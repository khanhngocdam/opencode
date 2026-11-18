import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxConfig } from "../provider"
import { runCommand } from "../bwrap/rootfs"
import { createVzProvider, vzSandboxDirs, type VzProviderOptions } from "./provider"

const config: SandboxConfig = { id: "sandbox:default", name: "default", backend: "vz", projectDir: "/tmp" }

// A fake codev-vmm speaking the real protocol: reads the VmConfig, listens on
// the host-to-guest unix socket like the helper would, answers health checks,
// and exits on the stop command.
const FAKE_HELPER = `import { createServer } from "node:net"
import { readFileSync } from "node:fs"
const config = JSON.parse(readFileSync(process.argv[2], "utf8"))
const serverForward = config.forwards.find((forward) => forward.direction === "host-to-guest")
process.stdout.write(JSON.stringify({ event: "state", state: "starting" }) + "\\n")
process.stderr.write("guest console noise\\n")
const listener = createServer((socket) => {
  socket.on("data", () => socket.end("HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok"))
})
listener.listen(serverForward.socketPath, () => {
  process.stdout.write(JSON.stringify({ event: "state", state: "running" }) + "\\n")
})
process.stdin.on("data", (data) => {
  if (String(data).includes("stop")) {
    process.stdout.write(JSON.stringify({ event: "state", state: "stopped" }) + "\\n")
    process.exit(0)
  }
})
`

const FAILING_HELPER = `process.stdout.write(JSON.stringify({ event: "error", message: "virtual machine failed to start: no entitlement" }) + "\\n")
process.stderr.write("codesign says no\\n")
setTimeout(() => process.exit(1), 5000)
`

const SILENT_HELPER = `process.stdout.write(JSON.stringify({ event: "state", state: "starting" }) + "\\n")
setInterval(() => {}, 1000)
`

// Runs .mjs fake helpers through the current runtime, since helperPath
// normally points at a native binary.
const runViaExec = ((command: string, args: string[], opts: unknown) =>
  spawn(process.execPath, [command, ...args], opts as never)) as unknown as typeof spawn

async function preparedOptions(dir: string, helperScript: string, overrides?: Partial<VzProviderOptions>) {
  const helperPath = join(dir, "fake-helper.mjs")
  await writeFile(helperPath, helperScript)
  const dirs = vzSandboxDirs(join(dir, "data"), config.name)
  await mkdir(dirs.image, { recursive: true })
  await writeFile(join(dirs.image, "vmlinux"), "kernel")
  await writeFile(join(dirs.image, "initrd"), "initrd")
  await writeFile(join(dirs.image, "rootfs.img"), "pristine-disk")
  await writeFile(dirs.disk, "pristine-disk")
  const projectDir = join(dir, "project")
  await mkdir(projectDir, { recursive: true })
  const options: VzProviderOptions = {
    dataDir: join(dir, "data"),
    cacheDir: join(dir, "cache"),
    bundleDir: join(dir, "bundle"),
    helperPath,
    resolveImage: async () => {
      throw new Error("not used")
    },
    platform: "darwin",
    spawnImpl: runViaExec,
    ...overrides,
  }
  return { options, projectDir, dirs }
}

test("availability gates on platform, macOS version, and helper presence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const helperPath = join(dir, "codev-vmm")
  const base = {
    dataDir: dir,
    cacheDir: dir,
    bundleDir: dir,
    helperPath,
    resolveImage: async (): Promise<never> => {
      throw new Error("not used")
    },
  }
  expect(await createVzProvider({ ...base, platform: "linux" }).availability()).toEqual({
    supported: false,
    message: "Virtualization framework sandboxes require macOS",
  })
  const older = await createVzProvider({
    ...base,
    platform: "darwin",
    readMacosVersion: async () => "11.7.10",
  }).availability()
  expect(older.supported).toBe(false)
  if (!older.supported) expect(older.message).toContain("requires macOS 12")
  const missingHelper = await createVzProvider({
    ...base,
    platform: "darwin",
    readMacosVersion: async () => "15.3",
  }).availability()
  expect(missingHelper.supported).toBe(false)
  if (!missingHelper.supported) expect(missingHelper.message).toContain("helper is not installed")
  await writeFile(helperPath, "binary")
  expect(
    await createVzProvider({ ...base, platform: "darwin", readMacosVersion: async () => "15.3" }).availability(),
  ).toEqual({ supported: true, warning: null })
  await rm(dir, { recursive: true, force: true })
})

test("starts the VM via the helper protocol and serves health through the vsock bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const prepared = await preparedOptions(dir, FAKE_HELPER)
  const provider = createVzProvider(prepared.options)

  const sandbox = await provider.start({ ...config, projectDir: prepared.projectDir })
  expect(sandbox.url).toStartWith("http://127.0.0.1:")
  expect(sandbox.username).toBe("codev")

  const vmConfig = JSON.parse(await readFile(join(prepared.dirs.runtime, "vm.json"), "utf8"))
  expect(vmConfig.cmdline).toContain("root=/dev/vda")
  expect(vmConfig.shares).toEqual([
    { tag: "workspace", path: prepared.projectDir, readOnly: false },
    { tag: "bundle", path: prepared.options.bundleDir, readOnly: true },
    { tag: "config", path: prepared.dirs.guestConfig, readOnly: true },
  ])
  expect(vmConfig.forwards.map((forward: { direction: string }) => forward.direction)).toEqual([
    "host-to-guest",
    "guest-to-host",
  ])
  expect(vmConfig.cpus).toBe(4)
  expect(vmConfig.memoryMiB).toBe(4096)
  const boot = JSON.parse(await readFile(join(prepared.dirs.guestConfig, "boot.json"), "utf8"))
  expect(boot.env.CODEV_SERVER_PASSWORD).toBe(sandbox.password)
  expect(boot.env.CODEV_SERVER_HOSTNAME).toBe("127.0.0.1")
  expect(boot.env.CODEV_SERVER_PORT).toBe("4096")
  // No extra mounts: the manifest is still written so a stale list from a
  // previous boot cannot survive.
  expect(JSON.parse(await readFile(join(prepared.dirs.guestConfig, "mounts.json"), "utf8"))).toEqual({ mounts: [] })
  expect(sandbox.mounts).toEqual([])

  let exited = false
  sandbox.onExit(() => {
    exited = true
  })
  sandbox.stop()
  const until = Date.now() + 3000
  while (!exited && Date.now() < until) await Bun.sleep(10)
  expect(exited).toBe(true)

  await rm(dir, { recursive: true, force: true })
})

test("shares extra mounts into the guest and skips deleted folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const prepared = await preparedOptions(dir, FAKE_HELPER)
  const provider = createVzProvider(prepared.options)
  const docs = join(dir, "docs")
  await mkdir(docs, { recursive: true })

  const sandbox = await provider.start({
    ...config,
    projectDir: prepared.projectDir,
    mounts: [{ path: docs }, { path: join(dir, "deleted-since-added") }],
  })
  const vmConfig = JSON.parse(await readFile(join(prepared.dirs.runtime, "vm.json"), "utf8"))
  expect(vmConfig.shares).toEqual([
    { tag: "workspace", path: prepared.projectDir, readOnly: false },
    { tag: "bundle", path: prepared.options.bundleDir, readOnly: true },
    { tag: "config", path: prepared.dirs.guestConfig, readOnly: true },
    { tag: "mnt-docs", path: docs, readOnly: false },
  ])
  expect(JSON.parse(await readFile(join(prepared.dirs.guestConfig, "mounts.json"), "utf8"))).toEqual({
    mounts: [{ tag: "mnt-docs", path: "/mnt/docs" }],
  })
  expect(sandbox.mounts).toEqual([{ path: docs, guestPath: "/mnt/docs" }])

  sandbox.stop()
  await rm(dir, { recursive: true, force: true })
})

test("per-sandbox cpus and memory win over the provider defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const prepared = await preparedOptions(dir, FAKE_HELPER)
  const provider = createVzProvider({ ...prepared.options, cpus: 2, memoryMiB: 2048 })

  const sandbox = await provider.start({
    ...config,
    projectDir: prepared.projectDir,
    cpus: 8,
    memoryMiB: 16384,
  })
  const vmConfig = JSON.parse(await readFile(join(prepared.dirs.runtime, "vm.json"), "utf8"))
  expect(vmConfig.cpus).toBe(8)
  expect(vmConfig.memoryMiB).toBe(16384)

  sandbox.stop()
  await rm(dir, { recursive: true, force: true })
})

test("surfaces helper error events with the stderr tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const prepared = await preparedOptions(dir, FAILING_HELPER)
  const provider = createVzProvider(prepared.options)
  expect(provider.start({ ...config, projectDir: prepared.projectDir })).rejects.toThrow(
    /no entitlement.*codesign says no/s,
  )
  await Bun.sleep(20)
  await rm(dir, { recursive: true, force: true })
})

test("times out when the helper never reaches running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const prepared = await preparedOptions(dir, SILENT_HELPER, { startTimeoutMs: 300 })
  const provider = createVzProvider(prepared.options)
  await expect(provider.start({ ...config, projectDir: prepared.projectDir })).rejects.toThrow(
    "did not start within 300ms",
  )
  await rm(dir, { recursive: true, force: true })
})

test("start requires create to have run first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const prepared = await preparedOptions(dir, FAKE_HELPER)
  await rm(prepared.dirs.disk, { force: true })
  const provider = createVzProvider(prepared.options)
  expect(provider.start({ ...config, projectDir: prepared.projectDir })).rejects.toThrow("missing disk")
  await rm(dir, { recursive: true, force: true })
})

test("create unpacks the image, validates its contents, and clones the instance disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const tree = join(dir, "tree")
  await mkdir(tree, { recursive: true })
  await writeFile(join(tree, "vmlinux"), "kernel")
  await writeFile(join(tree, "initrd"), "initrd")
  await writeFile(join(tree, "rootfs.img"), "pristine-disk")
  const tarPath = join(dir, "vz.tar")
  expect((await runCommand("tar", ["-cf", tarPath, "-C", tree, "vmlinux", "initrd", "rootfs.img"])).code).toBe(0)
  const payload = await Bun.file(tarPath).bytes()
  const server = Bun.serve({ port: 0, fetch: () => new Response(payload) })

  const options: VzProviderOptions = {
    dataDir: join(dir, "data"),
    cacheDir: join(dir, "cache"),
    bundleDir: join(dir, "bundle"),
    helperPath: join(dir, "codev-vmm"),
    platform: "darwin",
    resolveImage: async () => ({
      url: `http://127.0.0.1:${server.port}/vz.tar`,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
    }),
  }
  const provider = createVzProvider(options)
  const dirs = vzSandboxDirs(options.dataDir, config.name)

  await provider.create(config)
  expect(await readFile(dirs.disk, "utf8")).toBe("pristine-disk")

  await writeFile(dirs.disk, "guest state scribbled all over the disk")
  await provider.reset(config)
  expect(await readFile(dirs.disk, "utf8")).toBe("pristine-disk")

  await provider.destroy(config)
  expect(await stat(dirs.base).catch(() => null)).toBe(null)

  server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

test("reset re-clones when current and re-provisions when the image moved on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const buildTar = async (version: string) => {
    const tree = join(dir, `tree-${version}`)
    await mkdir(tree, { recursive: true })
    await writeFile(join(tree, "vmlinux"), "kernel")
    await writeFile(join(tree, "rootfs.img"), `disk-${version}`)
    const tarPath = join(dir, `vz-${version}.tar`)
    expect((await runCommand("tar", ["-cf", tarPath, "-C", tree, "vmlinux", "rootfs.img"])).code).toBe(0)
    return await Bun.file(tarPath).bytes()
  }
  const payloads = { v1: await buildTar("v1"), v2: await buildTar("v2") }
  let active: keyof typeof payloads = "v1"
  let downloads = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      downloads += 1
      return new Response(payloads[active])
    },
  })

  const options: VzProviderOptions = {
    dataDir: join(dir, "data"),
    cacheDir: join(dir, "cache"),
    bundleDir: join(dir, "bundle"),
    helperPath: join(dir, "codev-vmm"),
    platform: "darwin",
    resolveImage: async () => ({
      url: `http://127.0.0.1:${server.port}/vz-${active}.tar`,
      sha256: createHash("sha256").update(payloads[active]).digest("hex"),
      bytes: payloads[active].byteLength,
    }),
  }
  const provider = createVzProvider(options)
  const dirs = vzSandboxDirs(options.dataDir, config.name)

  await provider.create(config)
  expect(await readFile(dirs.disk, "utf8")).toBe("disk-v1")
  expect(downloads).toBe(1)

  // Current image: reset re-clones without touching the network.
  await writeFile(dirs.disk, "scribbles")
  await provider.reset(config)
  expect(await readFile(dirs.disk, "utf8")).toBe("disk-v1")
  expect(downloads).toBe(1)

  // Manifest moved on: the same reset re-provisions from the new image.
  active = "v2"
  await provider.reset(config)
  expect(await readFile(dirs.disk, "utf8")).toBe("disk-v2")
  expect(downloads).toBe(2)

  await provider.destroy(config)
  server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

test("create rejects an image tarball missing required files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-vz-"))
  const tree = join(dir, "tree")
  await mkdir(tree, { recursive: true })
  await writeFile(join(tree, "vmlinux"), "kernel")
  const tarPath = join(dir, "vz.tar")
  expect((await runCommand("tar", ["-cf", tarPath, "-C", tree, "vmlinux"])).code).toBe(0)
  const payload = await Bun.file(tarPath).bytes()
  const server = Bun.serve({ port: 0, fetch: () => new Response(payload) })

  const provider = createVzProvider({
    dataDir: join(dir, "data"),
    cacheDir: join(dir, "cache"),
    bundleDir: join(dir, "bundle"),
    helperPath: join(dir, "codev-vmm"),
    platform: "darwin",
    resolveImage: async () => ({
      url: `http://127.0.0.1:${server.port}/vz.tar`,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
    }),
  })
  expect(provider.create(config)).rejects.toThrow("vz image is missing rootfs.img")
  await Bun.sleep(20)
  server.stop(true)
  await rm(dir, { recursive: true, force: true })
})
