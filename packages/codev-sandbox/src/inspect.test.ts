import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { inspectSandboxImage, validateSandboxImage } from "./inspect"

// Minimal ustar writer: the inspector reads names, sizes and the first bytes
// of each member, so the fixtures only need to be structurally real.
function tarHeader(name: string, size: number) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, "utf8")
  header.write("000644 \0", 100, 8)
  header.write("000000 \0", 108, 8)
  header.write("000000 \0", 116, 8)
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12)
  header.write("00000000000 ", 136, 12)
  header.write("        ", 148, 8)
  header.write("0", 156, 1)
  header.write("ustar\x0000", 257, 8)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8)
  return header
}

function tar(entries: { name: string; data?: Buffer }[]) {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    blocks.push(tarHeader(entry.name, data.length), data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

async function fixture(name: string, contents: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "codev-inspect-"))
  const path = join(dir, name)
  await writeFile(path, contents)
  return path
}

// Both kernels are EFI-stub PE images opening with "MZ"; the arch magic sits
// further in, which is exactly what kernelArch keys on.
function arm64Kernel() {
  const kernel = Buffer.alloc(2048)
  kernel.write("MZ", 0, "latin1")
  kernel.write("ARM\x64", 56, "latin1")
  return kernel
}

function x64Kernel() {
  const kernel = Buffer.alloc(2048)
  kernel.write("MZ", 0, "latin1")
  kernel.write("HdrS", 514, "latin1")
  return kernel
}

function elf(machine: number) {
  const binary = Buffer.alloc(64)
  binary.writeUInt32BE(0x7f454c46, 0)
  binary.writeUInt16LE(machine, 18)
  return binary
}

test("recognizes a vz image and its architecture", async () => {
  const arm = await fixture(
    "vz.tar.gz",
    gzipSync(tar([{ name: "vmlinux", data: arm64Kernel() }, { name: "rootfs.img" }])),
  )
  expect(await inspectSandboxImage(arm)).toEqual({ kind: "image", format: "vz", arch: "arm64" })
  const intel = await fixture(
    "vz.tar.gz",
    gzipSync(tar([{ name: "vmlinux", data: x64Kernel() }, { name: "rootfs.img" }])),
  )
  expect(await inspectSandboxImage(intel)).toEqual({ kind: "image", format: "vz", arch: "x64" })
})

test("reads a rootfs image's architecture from the build's version marker", async () => {
  const path = await fixture(
    "bwrap.tar.gz",
    gzipSync(
      tar([
        { name: "etc/" },
        { name: "etc/hostname", data: Buffer.from("guest\n") },
        { name: "etc/codev-office-versions", data: Buffer.from("dotnet=8.0.423\npandoc=3.10.1\narch=amd64\n") },
      ]),
    ),
  )
  expect(await inspectSandboxImage(path)).toEqual({ kind: "image", format: "rootfs", arch: "x64" })
})

// An image built without the office layer has no marker file, so the arch has
// to come from the first ELF in the tree.
test("falls back to an ELF header when the marker file is absent", async () => {
  const path = await fixture(
    "bwrap.tar.gz",
    gzipSync(tar([{ name: "etc/" }, { name: "usr/bin/node", data: elf(0xb7) }])),
  )
  expect(await inspectSandboxImage(path)).toEqual({ kind: "image", format: "rootfs", arch: "arm64" })
})

test("reports an archive that is not a sandbox image", async () => {
  const path = await fixture(
    "holiday.tar.gz",
    gzipSync(tar([{ name: "photos/" }, { name: "photos/beach.jpg", data: Buffer.from("\xff\xd8\xff\xe0", "latin1") }])),
  )
  expect(await inspectSandboxImage(path)).toEqual({ kind: "not-a-sandbox-image" })
})

test("reports a file that is not a gzip archive at all", async () => {
  const path = await fixture("screenshot.png", Buffer.from("\x89PNG\r\n\x1a\n", "latin1"))
  expect(await inspectSandboxImage(path)).toEqual({ kind: "not-gzip" })
})

test("reports a missing or empty file", async () => {
  expect(await inspectSandboxImage(join(tmpdir(), "codev-does-not-exist.tar.gz"))).toEqual({ kind: "unreadable" })
  expect(await inspectSandboxImage(await fixture("empty.tar.gz", Buffer.alloc(0)))).toEqual({ kind: "unreadable" })
})

test("accepts an image that matches the machine", () => {
  const inspection = { kind: "image", format: "vz", arch: "arm64" } as const
  expect(validateSandboxImage(inspection, { backend: "vz", arch: "arm64" })).toBeNull()
})

test("rejects an image built for the other architecture", () => {
  const inspection = { kind: "image", format: "vz", arch: "x64" } as const
  expect(validateSandboxImage(inspection, { backend: "vz", arch: "arm64" })).toEqual({
    code: "wrong-arch",
    found: "x64",
  })
})

test("rejects an image built for a different operating system", () => {
  // A Windows/Linux rootfs tarball offered to the macOS backend...
  expect(
    validateSandboxImage({ kind: "image", format: "rootfs", arch: "arm64" }, { backend: "vz", arch: "arm64" }),
  ).toEqual({ code: "wrong-os", found: "rootfs" })
  // ...and a macOS image offered to Windows.
  expect(validateSandboxImage({ kind: "image", format: "vz", arch: "x64" }, { backend: "wsl", arch: "x64" })).toEqual({
    code: "wrong-os",
    found: "vz",
  })
})

// Windows and Linux consume the same rootfs tarball, so neither can be told
// from the other — accepting it for both is correct, not a gap.
test("accepts one rootfs image for both Windows and Linux", () => {
  const inspection = { kind: "image", format: "rootfs", arch: "x64" } as const
  expect(validateSandboxImage(inspection, { backend: "wsl", arch: "x64" })).toBeNull()
  expect(validateSandboxImage(inspection, { backend: "bwrap", arch: "x64" })).toBeNull()
})

test("allows an image whose architecture could not be determined", () => {
  const inspection = { kind: "image", format: "rootfs", arch: null } as const
  expect(validateSandboxImage(inspection, { backend: "bwrap", arch: "arm64" })).toBeNull()
})

test("passes the unusable-file reasons straight through", () => {
  expect(validateSandboxImage({ kind: "not-gzip" }, { backend: "vz", arch: "arm64" })).toEqual({ code: "not-gzip" })
  expect(validateSandboxImage({ kind: "unreadable" }, { backend: "vz", arch: "arm64" })).toEqual({ code: "unreadable" })
})
