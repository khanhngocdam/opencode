import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRootfsEntries, runCommand, unpackRootfs } from "./rootfs"

async function buildFixtureTar(dir: string) {
  const tree = join(dir, "tree")
  await mkdir(join(tree, "usr", "bin"), { recursive: true })
  await mkdir(join(tree, "etc"), { recursive: true })
  await writeFile(join(tree, "usr", "bin", "hello"), "#!/bin/sh\necho hello\n")
  await writeFile(join(tree, "etc", "os-release"), "ID=codev-sandbox\n")
  await symlink("usr/bin", join(tree, "bin"))
  const tarPath = join(dir, "rootfs.tar")
  const result = await runCommand("tar", ["-cf", tarPath, "-C", tree, "usr", "etc", "bin"])
  expect(result.code).toBe(0)
  return tarPath
}

test("unpacks a rootfs image and reads its bindable layout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-rootfs-"))
  const tarPath = await buildFixtureTar(dir)
  const rootfsDir = join(dir, "rootfs")

  await unpackRootfs(tarPath, rootfsDir)
  expect(await Bun.file(join(rootfsDir, "etc", "os-release")).text()).toBe("ID=codev-sandbox\n")

  const entries = (await readRootfsEntries(rootfsDir)).sort((a, b) => a.name.localeCompare(b.name))
  expect(entries).toEqual([
    { name: "bin", symlinkTarget: "usr/bin" },
    { name: "etc", symlinkTarget: null },
    { name: "usr", symlinkTarget: null },
  ])

  await rm(dir, { recursive: true, force: true })
})

test("re-unpacking wipes previous rootfs contents (reset semantics)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-rootfs-"))
  const tarPath = await buildFixtureTar(dir)
  const rootfsDir = join(dir, "rootfs")

  await unpackRootfs(tarPath, rootfsDir)
  await writeFile(join(rootfsDir, "leftover.txt"), "state from a previous run")
  await unpackRootfs(tarPath, rootfsDir)
  expect(await stat(join(rootfsDir, "leftover.txt")).catch(() => null)).toBe(null)
  expect(await stat(join(rootfsDir, "usr", "bin", "hello")).catch(() => null)).not.toBe(null)

  await rm(dir, { recursive: true, force: true })
})

test("surfaces tar failures with stderr detail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-rootfs-"))
  const notATar = join(dir, "bogus.tar")
  await writeFile(notATar, "this is not a tar archive")
  expect(unpackRootfs(notATar, join(dir, "rootfs"))).rejects.toThrow("sandbox rootfs unpack failed")
  await Bun.sleep(10)
  await rm(dir, { recursive: true, force: true })
})
