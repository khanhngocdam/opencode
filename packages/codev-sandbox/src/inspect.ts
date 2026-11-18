import { createReadStream } from "node:fs"
import { open, stat } from "node:fs/promises"
import { createGunzip } from "node:zlib"
import type { SandboxArch, SandboxBackend } from "./provider"

// A guest image is one of two shapes. "vz" is the macOS pair (a kernel plus an
// ext4 disk); "rootfs" is the Debian root filesystem tarball that bubblewrap
// and `wsl --import` both consume — the same file serves Windows and Linux, so
// those two are indistinguishable by design.
export type SandboxImageFormat = "vz" | "rootfs"

export type SandboxImageInspection =
  | { kind: "image"; format: SandboxImageFormat; arch: SandboxArch | null }
  // Deliberately separate reasons: "this is not a sandbox image" and "this is
  // not even an archive" call for different advice to the user.
  | { kind: "unreadable" }
  | { kind: "not-gzip" }
  | { kind: "not-a-sandbox-image" }

export function imageFormatForBackend(backend: SandboxBackend): SandboxImageFormat {
  return backend === "vz" ? "vz" : "rootfs"
}

// Only the first bytes of any member are read, so this stays cheap on a
// multi-gigabyte tarball: the vz kernel is the first member, and a rootfs
// carries its arch marker among the early etc/ entries. The budget bounds the
// pathological case (an archive with neither) rather than the normal one.
const SCAN_BUDGET_BYTES = 256 * 1024 * 1024
const TAR_BLOCK = 512
// Enough to cover the x86 kernel's "HdrS" at offset 514.
const PEEK_BYTES = 1024

export async function inspectSandboxImage(path: string): Promise<SandboxImageInspection> {
  const file = await stat(path).catch(() => null)
  if (!file?.isFile() || file.size === 0) return { kind: "unreadable" }
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return { kind: "unreadable" }
  const magic = Buffer.alloc(2)
  await handle.read(magic, 0, 2, 0)
  await handle.close()
  // gzip: 1f 8b. Checked up front so a .png or a plain tar fails fast with a
  // reason we can explain, instead of surfacing as a zlib stream error.
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return { kind: "not-gzip" }

  const source = createReadStream(path).pipe(createGunzip())
  let format: SandboxImageFormat | null = null
  let arch: SandboxArch | null = null
  try {
    for await (const entry of tarEntries(source, SCAN_BUDGET_BYTES)) {
      if (entry.name === "vmlinux" || entry.name === "rootfs.img" || entry.name === "initrd") {
        format = "vz"
        if (entry.name === "vmlinux") arch = kernelArch(entry.peek) ?? arch
      } else if (looksLikeRootfs(entry.name)) {
        format ??= "rootfs"
      }
      // Written by the image build; the cheapest and most direct answer.
      if (entry.name === "etc/codev-office-versions") arch = versionsArch(entry.peek) ?? arch
      // Any ELF in the tree answers it too, for an image built without the
      // office layer (and so without the marker file above).
      if (!arch) arch = elfArch(entry.peek) ?? arch
      if (format && arch) break
    }
  } catch {
    // A truncated or corrupt stream mid-scan: whatever was learned before the
    // failure is not trustworthy enough to accept.
    return { kind: "not-a-sandbox-image" }
  } finally {
    source.destroy()
  }
  if (!format) return { kind: "not-a-sandbox-image" }
  return { kind: "image", format, arch }
}

export type SandboxImageProblem =
  | { code: "unreadable" }
  | { code: "not-gzip" }
  | { code: "not-a-sandbox-image" }
  | { code: "wrong-os"; found: SandboxImageFormat }
  | { code: "wrong-arch"; found: SandboxArch }

// Null means usable. An image whose architecture could not be determined is
// allowed through with no problem reported: refusing a valid image because the
// probe could not prove its arch would be worse than the rare mismatch that
// slips past, and the guest fails loudly on first boot either way.
export function validateSandboxImage(
  inspection: SandboxImageInspection,
  expected: { backend: SandboxBackend; arch: SandboxArch },
): SandboxImageProblem | null {
  if (inspection.kind !== "image") return { code: inspection.kind }
  if (inspection.format !== imageFormatForBackend(expected.backend))
    return { code: "wrong-os", found: inspection.format }
  if (inspection.arch && inspection.arch !== expected.arch) return { code: "wrong-arch", found: inspection.arch }
  return null
}

type TarEntry = { name: string; peek: Buffer }

async function* tarEntries(source: AsyncIterable<Buffer>, budget: number): AsyncGenerator<TarEntry> {
  const iterator = source[Symbol.asyncIterator]()
  let buffer: Buffer = Buffer.alloc(0)
  let read = 0
  const pull = async () => {
    const next = await iterator.next()
    if (next.done) return false
    buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value
    read += next.value.length
    return true
  }
  const ensure = async (bytes: number) => {
    while (buffer.length < bytes) if (!(await pull())) return false
    return true
  }
  const take = (bytes: number) => {
    const out = buffer.subarray(0, bytes)
    buffer = buffer.subarray(bytes)
    return out
  }
  while (read < budget) {
    if (!(await ensure(TAR_BLOCK))) return
    const header = take(TAR_BLOCK)
    // Two zero blocks terminate the archive; one is enough to stop scanning.
    if (header[0] === 0) return
    const name = cstring(header.subarray(0, 100))
    const size = Number.parseInt(cstring(header.subarray(124, 136)).trim() || "0", 8)
    if (!Number.isFinite(size) || size < 0) return
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    const peekLength = Math.min(size, PEEK_BYTES)
    let peek = Buffer.alloc(0)
    if (peekLength > 0) {
      if (!(await ensure(peekLength))) return
      peek = Buffer.from(take(peekLength))
    }
    let skip = padded - peekLength
    while (skip > 0) {
      if (buffer.length === 0 && !(await pull())) return
      skip -= take(Math.min(skip, buffer.length)).length
    }
    yield { name, peek }
  }
}

function cstring(buffer: Buffer) {
  const end = buffer.indexOf(0)
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8")
}

// The top-level directories a Linux root filesystem always has. Matched on the
// tar's own entry names, which carry no leading slash.
const ROOTFS_ENTRIES = new Set(["etc", "usr", "bin", "sbin", "var", "opt", "lib"])

function looksLikeRootfs(name: string) {
  const top = name.replace(/\/+$/, "").split("/")[0] ?? ""
  return ROOTFS_ENTRIES.has(top)
}

// Both architectures' kernels are EFI-stub PE images starting "MZ", so the
// magic further in is what actually distinguishes them: arm64 stamps "ARM\x64"
// at offset 56, x86 stamps "HdrS" at 514 (verified against both built kernels).
function kernelArch(peek: Buffer): SandboxArch | null {
  if (peek.length >= 60 && peek.subarray(56, 60).toString("latin1") === "ARM\x64") return "arm64"
  if (peek.length >= 518 && peek.subarray(514, 518).toString("latin1") === "HdrS") return "x64"
  return null
}

function versionsArch(peek: Buffer): SandboxArch | null {
  const match = /^arch=(\S+)$/m.exec(peek.toString("utf8"))
  if (!match) return null
  // The file records the Debian architecture the image was built for.
  if (match[1] === "amd64") return "x64"
  if (match[1] === "arm64") return "arm64"
  return null
}

const ELF_MACHINE_X86_64 = 0x3e
const ELF_MACHINE_AARCH64 = 0xb7

function elfArch(peek: Buffer): SandboxArch | null {
  if (peek.length < 20 || peek.readUInt32BE(0) !== 0x7f454c46) return null
  const machine = peek.readUInt16LE(18)
  if (machine === ELF_MACHINE_X86_64) return "x64"
  if (machine === ELF_MACHINE_AARCH64) return "arm64"
  return null
}
