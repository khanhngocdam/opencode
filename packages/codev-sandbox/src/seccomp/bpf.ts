// Compiles the seccomp policy into the classic-BPF program bwrap's --seccomp
// flag installs on the guest. Generated on the host at every start, so no
// native dependency, no build step, and no separately versioned blob: the
// policy ships with the app that runs the guest.
//
// A seccomp filter sees `struct seccomp_data` — nr, arch, instruction pointer
// and six 64-bit args — and returns an action. This program:
//   1. kills anything whose arch is not the native one (and, on x86_64, any
//      x32-ABI number), so a compat ABI cannot reach a syscall by another
//      number;
//   2. kills the escalation set outright;
//   3. inspects the flags of clone/unshare and the domain of socket/socketpair;
//   4. allows the allowlist;
//   5. denies the rest with EPERM, or ENOSYS above the unified numbering.
// In audit mode every non-allow verdict becomes SECCOMP_RET_LOG: the kernel
// logs what enforce would have blocked and the workload proceeds unchanged.
import {
  CLONE_NAMESPACE_FLAGS,
  CLONE_NEWUSER,
  NETLINK_ROUTE,
  SECCOMP_ALLOW,
  SECCOMP_KILL,
  SOCKET_FAMILY,
  UNIFIED_SYSCALL_BASE,
} from "./policy"
import type { SeccompMode } from "./policy"
import { SYSCALLS_ARM64 } from "./syscalls-arm64"
import { SYSCALLS_X64 } from "./syscalls-x64"

export type SeccompArch = "x64" | "arm64"

const SYSCALL_TABLES: Record<SeccompArch, Record<string, number>> = { x64: SYSCALLS_X64, arm64: SYSCALLS_ARM64 }

// AUDIT_ARCH_* from <linux/audit.h>: EM_* | __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE.
const AUDIT_ARCH: Record<SeccompArch, number> = { x64: 0xc000003e, arm64: 0xc00000b7 }
const X32_SYSCALL_BIT = 0x40000000

// struct seccomp_data offsets. Both supported arches are little-endian, so
// the low 32 bits of an argument sit at its base offset.
const DATA_NR = 0
const DATA_ARCH = 4
const argOffset = (index: number) => 16 + index * 8

// Instruction classes, from <linux/bpf_common.h> and <linux/filter.h>.
const LD_W_ABS = 0x20
const JMP_JEQ_K = 0x15
const JMP_JGE_K = 0x35
const JMP_JSET_K = 0x45
const RET_K = 0x06

// <linux/seccomp.h> return actions.
export const SECCOMP_RET_KILL_PROCESS = 0x80000000
export const SECCOMP_RET_ERRNO = 0x00050000
export const SECCOMP_RET_LOG = 0x7ffc0000
export const SECCOMP_RET_ALLOW = 0x7fff0000

const EPERM = 1
const ENOSYS = 38
const EAFNOSUPPORT = 97

// The kernel refuses programs longer than this (BPF_MAXINSNS).
const BPF_MAXINSNS = 4096

// Jump targets are unsigned 8-bit offsets from the next instruction, so a
// label may only be referenced from within 255 instructions of it; assemble()
// checks. The allowlist is emitted in chunks with their own `ret ALLOW` so no
// reference has to reach further than a chunk.
const ALLOW_CHUNK = 200

type Target = number | string
type Instruction = { code: number; k: number; jt: Target; jf: Target; label?: string }

export type SeccompProgram = {
  arch: SeccompArch
  mode: Exclude<SeccompMode, "off">
  instructions: number
  bytes: Buffer
}

export function buildSeccompProgram(arch: SeccompArch, mode: Exclude<SeccompMode, "off">): SeccompProgram {
  const table = SYSCALL_TABLES[arch]
  const nr = (name: string) => {
    const number = table[name]
    if (number === undefined) throw new Error(`syscall ${name} is not in the ${arch} table`)
    return number
  }
  const present = (names: readonly string[]) => names.filter((name) => requireKnown(name) in table)
  // In audit mode nothing is refused; the verdict that would have been
  // returned is logged instead and the syscall proceeds.
  const verdict = (action: number) => (mode === "audit" ? SECCOMP_RET_LOG : action)
  const errno = (code: number) => verdict(SECCOMP_RET_ERRNO | code)
  const kill = verdict(SECCOMP_RET_KILL_PROCESS)

  const program: Instruction[] = []
  const load = (offset: number) => program.push({ code: LD_W_ABS, k: offset, jt: 0, jf: 0 })
  const jeq = (k: number, jt: Target, jf: Target) => program.push({ code: JMP_JEQ_K, k, jt, jf })
  const jge = (k: number, jt: Target, jf: Target) => program.push({ code: JMP_JGE_K, k, jt, jf })
  const jset = (k: number, jt: Target, jf: Target) => program.push({ code: JMP_JSET_K, k, jt, jf })
  const ret = (action: number, label?: string) => program.push({ code: RET_K, k: action, jt: 0, jf: 0, label })

  // 1. architecture gate
  load(DATA_ARCH)
  jeq(AUDIT_ARCH[arch], 1, 0)
  ret(kill)
  load(DATA_NR)
  if (arch === "x64") {
    jge(X32_SYSCALL_BIT, 0, 1)
    ret(kill)
  }

  // 2. the escalation set
  for (const name of present(SECCOMP_KILL)) jeq(nr(name), "kill", 0)
  jeq(nr("clone"), "namespace-flags", 0)
  jeq(nr("unshare"), "namespace-flags", "socket-domain-check")
  ret(kill, "kill")

  // 3a. clone/unshare: fatal for a new user namespace, refused for any other
  // namespace, allowed otherwise. The flags are the first argument on both
  // arches, and every CLONE_NEW* bit lives in the low word.
  program.push({ code: LD_W_ABS, k: argOffset(0), jt: 0, jf: 0, label: "namespace-flags" })
  jset(CLONE_NEWUSER, "kill-namespace", 0)
  jset(CLONE_NAMESPACE_FLAGS, "refuse-namespace", 0)
  ret(SECCOMP_RET_ALLOW)
  ret(kill, "kill-namespace")
  ret(errno(EPERM), "refuse-namespace")

  // 3b. socket/socketpair: domain in the first argument, protocol in the
  // third. The accumulator still holds nr on the skip path, so the checks
  // that follow need no reload.
  program.push({ code: JMP_JEQ_K, k: nr("socket"), jt: "socket-domain", jf: 0, label: "socket-domain-check" })
  jeq(nr("socketpair"), "socket-domain", "allowlist")
  program.push({ code: LD_W_ABS, k: argOffset(0), jt: 0, jf: 0, label: "socket-domain" })
  jeq(SOCKET_FAMILY.AF_UNIX, "socket-allow", 0)
  jeq(SOCKET_FAMILY.AF_INET, "socket-allow", 0)
  jeq(SOCKET_FAMILY.AF_INET6, "socket-allow", 0)
  jeq(SOCKET_FAMILY.AF_NETLINK, 0, "socket-refuse")
  load(argOffset(2))
  jeq(NETLINK_ROUTE, 0, "socket-refuse")
  ret(SECCOMP_RET_ALLOW, "socket-allow")
  ret(errno(EAFNOSUPPORT), "socket-refuse")

  // 4. the allowlist, in chunks short enough for 8-bit jumps
  const allowed = present(SECCOMP_ALLOW)
    .map(nr)
    .sort((a, b) => a - b)
  if (allowed.length === 0) throw new Error(`seccomp allowlist resolves to nothing on ${arch}`)
  const chunks = Array.from({ length: Math.ceil(allowed.length / ALLOW_CHUNK) }, (_, i) =>
    allowed.slice(i * ALLOW_CHUNK, (i + 1) * ALLOW_CHUNK),
  )
  chunks.forEach((chunk, index) => {
    // Each chunk: jeq → its own ret ALLOW; the last jeq's miss goes to the
    // next chunk (or the deny tail), skipping over that ret.
    const allow = `allow-${index}`
    const next = index + 1 < chunks.length ? `chunk-${index + 1}` : "deny"
    chunk.forEach((number, position) => {
      program.push({
        code: JMP_JEQ_K,
        k: number,
        jt: allow,
        jf: position === chunk.length - 1 ? next : 0,
        ...(position === 0 ? { label: index === 0 ? "allowlist" : `chunk-${index}` } : {}),
      })
    })
    ret(SECCOMP_RET_ALLOW, allow)
  })

  // 5. default deny
  program.push({ code: JMP_JGE_K, k: UNIFIED_SYSCALL_BASE, jt: "enosys", jf: 0, label: "deny" })
  ret(errno(EPERM))
  ret(errno(ENOSYS), "enosys")

  return { arch, mode, instructions: program.length, bytes: assemble(program) }
}

function requireKnown(name: string) {
  if (name in SYSCALLS_X64 || name in SYSCALLS_ARM64) return name
  throw new Error(`seccomp policy names an unknown syscall: ${name}`)
}

// Resolves labels to relative offsets and packs `struct sock_filter`
// (u16 code, u8 jt, u8 jf, u32 k; little-endian on both supported hosts).
function assemble(program: Instruction[]) {
  if (program.length > BPF_MAXINSNS) throw new Error(`seccomp program too long: ${program.length} instructions`)
  const labels = new Map<string, number>()
  program.forEach((instruction, index) => {
    if (instruction.label === undefined) return
    if (labels.has(instruction.label)) throw new Error(`duplicate seccomp label ${instruction.label}`)
    labels.set(instruction.label, index)
  })
  const offset = (target: Target, from: number) => {
    if (typeof target === "number") return target
    const index = labels.get(target)
    if (index === undefined) throw new Error(`unknown seccomp label ${target}`)
    const distance = index - (from + 1)
    if (distance < 0 || distance > 255) throw new Error(`seccomp label ${target} is out of jump range (${distance})`)
    return distance
  }
  const bytes = Buffer.alloc(program.length * 8)
  program.forEach((instruction, index) => {
    bytes.writeUInt16LE(instruction.code, index * 8)
    bytes.writeUInt8(offset(instruction.jt, index), index * 8 + 2)
    bytes.writeUInt8(offset(instruction.jf, index), index * 8 + 3)
    bytes.writeUInt32LE(instruction.k >>> 0, index * 8 + 4)
  })
  return bytes
}

// The host's own architecture, which is the guest's too: bwrap runs the
// rootfs on the host kernel.
export function seccompArch(arch: string = process.arch): SeccompArch | null {
  if (arch === "x64" || arch === "arm64") return arch
  return null
}
