import { expect, test } from "bun:test"
import {
  SECCOMP_RET_ALLOW,
  SECCOMP_RET_ERRNO,
  SECCOMP_RET_KILL_PROCESS,
  SECCOMP_RET_LOG,
  buildSeccompProgram,
  seccompArch,
} from "./bpf"
import type { SeccompArch } from "./bpf"
import { CLONE_NEWUSER, SECCOMP_ALLOW, SECCOMP_DENIED, SECCOMP_KILL, SOCKET_FAMILY } from "./policy"
import { SYSCALLS_ARM64 } from "./syscalls-arm64"
import { SYSCALLS_X64 } from "./syscalls-x64"

const TABLES: Record<SeccompArch, Record<string, number>> = { x64: SYSCALLS_X64, arm64: SYSCALLS_ARM64 }
const AUDIT_ARCH: Record<SeccompArch, number> = { x64: 0xc000003e, arm64: 0xc00000b7 }
const EPERM = SECCOMP_RET_ERRNO | 1
const ENOSYS = SECCOMP_RET_ERRNO | 38
const EAFNOSUPPORT = SECCOMP_RET_ERRNO | 97

// A classic-BPF interpreter for the seccomp subset the generator emits, so
// the tests exercise the real program bytes the kernel would run rather than
// the generator's intermediate form.
function run(bytes: Buffer, data: { nr: number; arch: number; args?: number[] }) {
  const input = Buffer.alloc(64)
  input.writeUInt32LE(data.nr >>> 0, 0)
  input.writeUInt32LE(data.arch >>> 0, 4)
  ;(data.args ?? []).forEach((arg, index) => input.writeBigUInt64LE(BigInt(arg), 16 + index * 8))
  let acc = 0
  let pc = 0
  for (let steps = 0; steps < 10_000; steps++) {
    if (pc * 8 >= bytes.length) throw new Error("fell off the end of the program")
    const code = bytes.readUInt16LE(pc * 8)
    const jt = bytes.readUInt8(pc * 8 + 2)
    const jf = bytes.readUInt8(pc * 8 + 3)
    const k = bytes.readUInt32LE(pc * 8 + 4)
    if (code === 0x20) {
      acc = input.readUInt32LE(k)
      pc += 1
      continue
    }
    if (code === 0x06) return k
    if (code === 0x15) {
      pc += 1 + (acc === k ? jt : jf)
      continue
    }
    if (code === 0x35) {
      pc += 1 + (acc >= k ? jt : jf)
      continue
    }
    if (code === 0x45) {
      pc += 1 + ((acc & k) !== 0 ? jt : jf)
      continue
    }
    throw new Error(`unsupported opcode 0x${code.toString(16)} at ${pc}`)
  }
  throw new Error("program did not terminate")
}

function verdict(arch: SeccompArch, mode: "audit" | "enforce", name: string, args?: number[]) {
  const nr = TABLES[arch][name]
  if (nr === undefined) throw new Error(`${name} is not on ${arch}`)
  return run(buildSeccompProgram(arch, mode).bytes, { nr, arch: AUDIT_ARCH[arch], args })
}

for (const arch of ["x64", "arm64"] as const) {
  test(`${arch}: allows the workload syscalls and denies the rest`, () => {
    expect(verdict(arch, "enforce", "read")).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "openat")).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "execve")).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "mount")).toBe(EPERM)
    expect(verdict(arch, "enforce", "ptrace")).toBe(EPERM)
    expect(verdict(arch, "enforce", "setns")).toBe(EPERM)
    // Newer syscalls libc probes for must read as absent, not forbidden.
    expect(verdict(arch, "enforce", "clone3")).toBe(ENOSYS)
    expect(verdict(arch, "enforce", "io_uring_setup")).toBe(ENOSYS)
  })

  test(`${arch}: every allowlisted syscall passes, every kill/deny entry does not`, () => {
    const program = buildSeccompProgram(arch, "enforce").bytes
    for (const name of SECCOMP_ALLOW) {
      const nr = TABLES[arch][name]
      if (nr === undefined) continue
      // clone and socket are argument-filtered; benign arguments here.
      const args = name === "socket" || name === "socketpair" ? [SOCKET_FAMILY.AF_UNIX] : [0]
      expect([name, run(program, { nr, arch: AUDIT_ARCH[arch], args })]).toEqual([name, SECCOMP_RET_ALLOW])
    }
    for (const name of SECCOMP_KILL) {
      const nr = TABLES[arch][name]
      if (nr === undefined) continue
      expect([name, run(program, { nr, arch: AUDIT_ARCH[arch] })]).toEqual([name, SECCOMP_RET_KILL_PROCESS])
    }
    for (const name of SECCOMP_DENIED) {
      const nr = TABLES[arch][name]
      if (nr === undefined) continue
      const action = run(program, { nr, arch: AUDIT_ARCH[arch] })
      expect([name, action]).toEqual([name, nr >= 424 ? ENOSYS : EPERM])
    }
  })

  test(`${arch}: kills the wrong architecture`, () => {
    const program = buildSeccompProgram(arch, "enforce").bytes
    const other = arch === "x64" ? AUDIT_ARCH.arm64 : AUDIT_ARCH.x64
    expect(run(program, { nr: TABLES[arch].read, arch: other })).toBe(SECCOMP_RET_KILL_PROCESS)
    // AUDIT_ARCH_I386, the compat ABI on x86_64 hosts.
    expect(run(program, { nr: 3, arch: 0x40000003 })).toBe(SECCOMP_RET_KILL_PROCESS)
  })

  test(`${arch}: refuses namespace creation and kills user-namespace creation`, () => {
    const SIGCHLD = 17
    expect(verdict(arch, "enforce", "clone", [SIGCHLD])).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "clone", [SIGCHLD | CLONE_NEWUSER])).toBe(SECCOMP_RET_KILL_PROCESS)
    expect(verdict(arch, "enforce", "clone", [SIGCHLD | 0x20000000 /* NEWPID */])).toBe(EPERM)
    expect(verdict(arch, "enforce", "unshare", [0x00000200 /* CLONE_FS */])).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "unshare", [0x00020000 /* NEWNS */])).toBe(EPERM)
    expect(verdict(arch, "enforce", "unshare", [CLONE_NEWUSER])).toBe(SECCOMP_RET_KILL_PROCESS)
    // Only the low word is inspected; a flag word with high bits set but no
    // namespace bit is still a plain clone.
    expect(verdict(arch, "enforce", "clone", [0x1_0000_0000 + SIGCHLD])).toBe(SECCOMP_RET_ALLOW)
  })

  test(`${arch}: limits socket domains to unix, inet and route netlink`, () => {
    const SOCK_STREAM = 1
    expect(verdict(arch, "enforce", "socket", [SOCKET_FAMILY.AF_UNIX, SOCK_STREAM, 0])).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "socket", [SOCKET_FAMILY.AF_INET, SOCK_STREAM, 0])).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "socket", [SOCKET_FAMILY.AF_INET6, SOCK_STREAM, 0])).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "socketpair", [SOCKET_FAMILY.AF_UNIX, SOCK_STREAM, 0])).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "enforce", "socket", [SOCKET_FAMILY.AF_NETLINK, 3, 0 /* NETLINK_ROUTE */])).toBe(
      SECCOMP_RET_ALLOW,
    )
    expect(verdict(arch, "enforce", "socket", [SOCKET_FAMILY.AF_NETLINK, 3, 9 /* NETLINK_AUDIT */])).toBe(EAFNOSUPPORT)
    expect(verdict(arch, "enforce", "socket", [17 /* AF_PACKET */, 3, 0])).toBe(EAFNOSUPPORT)
    expect(verdict(arch, "enforce", "socketpair", [17, 3, 0])).toBe(EAFNOSUPPORT)
    // The domain check must not leak into the syscalls checked after it:
    // the accumulator still holds nr on the miss path.
    expect(verdict(arch, "enforce", "bind", [SOCKET_FAMILY.AF_UNIX])).toBe(SECCOMP_RET_ALLOW)
  })

  test(`${arch}: audit mode logs instead of refusing`, () => {
    expect(verdict(arch, "audit", "read")).toBe(SECCOMP_RET_ALLOW)
    expect(verdict(arch, "audit", "mount")).toBe(SECCOMP_RET_LOG)
    expect(verdict(arch, "audit", "clone3")).toBe(SECCOMP_RET_LOG)
    expect(verdict(arch, "audit", "bpf")).toBe(SECCOMP_RET_LOG)
    expect(verdict(arch, "audit", "unshare", [CLONE_NEWUSER])).toBe(SECCOMP_RET_LOG)
    expect(verdict(arch, "audit", "socket", [17, 3, 0])).toBe(SECCOMP_RET_LOG)
    expect(run(buildSeccompProgram(arch, "audit").bytes, { nr: 0, arch: 0x40000003 })).toBe(SECCOMP_RET_LOG)
  })

  test(`${arch}: every syscall number gets a verdict and the program fits the kernel limit`, () => {
    const program = buildSeccompProgram(arch, "enforce")
    expect(program.instructions).toBeLessThanOrEqual(4096)
    expect(program.bytes.length).toBe(program.instructions * 8)
    for (let nr = 0; nr < 1024; nr++) {
      const action = run(program.bytes, { nr, arch: AUDIT_ARCH[arch], args: [0, 0, 0] })
      // EAFNOSUPPORT: the sweep's zero args make socket(AF_UNSPEC) a refusal.
      expect([SECCOMP_RET_ALLOW, SECCOMP_RET_KILL_PROCESS, EPERM, ENOSYS, EAFNOSUPPORT]).toContain(action)
    }
  })
}

test("x64: kills the x32 ABI by syscall number", () => {
  const program = buildSeccompProgram("x64", "enforce").bytes
  expect(run(program, { nr: SYSCALLS_X64.read | 0x40000000, arch: AUDIT_ARCH.x64 })).toBe(SECCOMP_RET_KILL_PROCESS)
})

test("the policy names only real syscalls and never lists one twice", () => {
  const known = (name: string) => name in SYSCALLS_X64 || name in SYSCALLS_ARM64
  for (const name of [...SECCOMP_ALLOW, ...SECCOMP_KILL, ...SECCOMP_DENIED])
    expect([name, known(name)]).toEqual([name, true])
  const lists = [new Set<string>(SECCOMP_ALLOW), new Set<string>(SECCOMP_KILL), new Set<string>(SECCOMP_DENIED)]
  expect(lists.map((set) => set.size)).toEqual([SECCOMP_ALLOW.length, SECCOMP_KILL.length, SECCOMP_DENIED.length])
  for (const name of SECCOMP_ALLOW) expect([name, lists[1].has(name) || lists[2].has(name)]).toEqual([name, false])
  for (const name of SECCOMP_KILL) expect([name, lists[2].has(name)]).toEqual([name, false])
})

test("seccompArch maps the supported node archs and nothing else", () => {
  expect(seccompArch("x64")).toBe("x64")
  expect(seccompArch("arm64")).toBe("arm64")
  expect(seccompArch("ia32")).toBe(null)
})
