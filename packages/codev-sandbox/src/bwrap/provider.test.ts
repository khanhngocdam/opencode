import { expect, test } from "bun:test"
import type { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { SandboxConfig } from "../provider"
import { createBwrapProvider, sandboxDirs, type BwrapProviderOptions } from "./provider"
import { runCommand } from "./rootfs"

type FakeChild = EventEmitter & { stderr: EventEmitter; killed: boolean; kill: () => boolean }

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  return child
}

const config: SandboxConfig = { id: "sandbox:default", name: "default", backend: "bwrap", projectDir: "/tmp" }

async function startOptions(dir: string, child: FakeChild, overrides?: Partial<BwrapProviderOptions>) {
  const spawnCalls: { command: string; args: string[]; stdio: unknown[] }[] = []
  const dirs = sandboxDirs(join(dir, "data"), config.name)
  await mkdir(join(dirs.rootfs, "usr"), { recursive: true })
  const projectDir = join(dir, "project")
  await mkdir(projectDir, { recursive: true })
  const options: BwrapProviderOptions = {
    dataDir: join(dir, "data"),
    cacheDir: join(dir, "cache"),
    bundleDir: join(dir, "bundle"),
    resolveImage: async () => {
      throw new Error("not used")
    },
    platform: "linux",
    spawnImpl: ((command: string, args: string[], spawnOptions: { stdio: unknown[] }) => {
      spawnCalls.push({ command, args, stdio: spawnOptions.stdio })
      return child
    }) as unknown as typeof spawn,
    fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch,
    ...overrides,
  }
  return { options, spawnCalls, projectDir }
}

test("reports non-linux hosts as unsupported without probing", async () => {
  const provider = createBwrapProvider({
    dataDir: "/x",
    cacheDir: "/x",
    bundleDir: "/x",
    resolveImage: async () => {
      throw new Error("not used")
    },
    platform: "darwin",
  })
  expect(await provider.availability()).toEqual({ supported: false, message: "bubblewrap sandboxes require Linux" })
})

test("reports a missing bwrap binary", async () => {
  const provider = createBwrapProvider({
    dataDir: "/x",
    cacheDir: "/x",
    bundleDir: "/x",
    resolveImage: async () => {
      throw new Error("not used")
    },
    platform: "linux",
    bwrapCommand: "codev-definitely-not-installed",
  })
  expect(await provider.availability()).toEqual({ supported: false, message: "bubblewrap (bwrap) is not installed" })
})

test("reports a bwrap that cannot create sandboxes (AppArmor-style failure)", async () => {
  const provider = createBwrapProvider({
    dataDir: "/x",
    cacheDir: "/x",
    bundleDir: "/x",
    resolveImage: async () => {
      throw new Error("not used")
    },
    platform: "linux",
    bwrapCommand: "false",
  })
  const availability = await provider.availability()
  expect(availability.supported).toBe(false)
  if (!availability.supported) expect(availability.message).toContain("cannot create sandboxes")
})

test("starts the sandbox: spawns bwrap with the isolated spec and returns the forwarded server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const child = fakeChild()
  const prepared = await startOptions(dir, child)
  const provider = createBwrapProvider(prepared.options)

  const sandbox = await provider.start({ ...config, projectDir: prepared.projectDir })
  expect(sandbox.url).toStartWith("http://127.0.0.1:")
  expect(sandbox.username).toBe("codev")

  expect(prepared.spawnCalls.length).toBe(1)
  const joined = prepared.spawnCalls[0]!.args.join(" ")
  expect(prepared.spawnCalls[0]!.command).toBe("bwrap")
  expect(joined).toContain("--unshare-net")
  expect(joined).toContain(`--bind ${prepared.projectDir} /workspace`)
  expect(joined).toContain(`--setenv CODEV_SERVER_PASSWORD ${sandbox.password}`)
  expect(joined).toContain("--setenv CODEV_CLIENT desktop")
  expect(joined).toContain("unix-to-tcp /run/codev/server.sock 4096")
  expect(joined).toContain("tcp-to-unix 8788 /run/codev/broker.sock")
  expect(joined).toContain("--setenv CODEV_SERVER_HOSTNAME 127.0.0.1")
  expect(joined).toContain("--setenv CODEV_SERVER_PORT 4096")
  expect(joined).toContain("node /opt/codev-guest/server-launch.mjs")

  let exit: { code: number | null } | undefined
  sandbox.onExit((code) => {
    exit = { code }
  })
  sandbox.stop()
  expect(child.killed).toBe(true)
  child.emit("exit", 0, null)
  await Bun.sleep(1)
  expect(exit).toEqual({ code: 0 })

  await rm(dir, { recursive: true, force: true })
})

test("start fails with stderr detail when the guest exits during boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const child = fakeChild()
  const prepared = await startOptions(dir, child, {
    fetchImpl: (async () => {
      throw new Error("no server yet")
    }) as unknown as typeof fetch,
  })
  const provider = createBwrapProvider(prepared.options)
  setTimeout(() => {
    child.stderr.emit("data", "bwrap: setting up uid map: Permission denied")
    child.emit("exit", 1, null)
  }, 10)
  expect(provider.start({ ...config, projectDir: prepared.projectDir })).rejects.toThrow(
    /exited during startup \(code=1 signal=null\).*Permission denied/,
  )
  await Bun.sleep(30)
  await rm(dir, { recursive: true, force: true })
})

test("start fails after the timeout when the server never becomes healthy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const child = fakeChild()
  const prepared = await startOptions(dir, child, {
    startTimeoutMs: 40,
    fetchImpl: (async () => {
      throw new Error("no server yet")
    }) as unknown as typeof fetch,
  })
  const provider = createBwrapProvider(prepared.options)
  await expect(provider.start({ ...config, projectDir: prepared.projectDir })).rejects.toThrow(
    "did not become healthy within 40ms",
  )
  expect(child.killed).toBe(true)
  await rm(dir, { recursive: true, force: true })
})

test("start requires create to have run first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const child = fakeChild()
  const prepared = await startOptions(dir, child)
  await rm(sandboxDirs(prepared.options.dataDir, config.name).rootfs, { recursive: true, force: true })
  const provider = createBwrapProvider(prepared.options)
  expect(provider.start({ ...config, projectDir: prepared.projectDir })).rejects.toThrow("missing rootfs")
  await rm(dir, { recursive: true, force: true })
})

test("create/reset/destroy manage the sandbox dirs from a staged image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const tree = join(dir, "tree")
  await mkdir(join(tree, "etc"), { recursive: true })
  await writeFile(join(tree, "etc", "os-release"), "ID=codev-sandbox\n")
  const tarPath = join(dir, "rootfs.tar")
  expect((await runCommand("tar", ["-cf", tarPath, "-C", tree, "etc"])).code).toBe(0)
  const payload = await Bun.file(tarPath).bytes()

  let downloads = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      downloads++
      return new Response(payload)
    },
  })
  const options: BwrapProviderOptions = {
    dataDir: join(dir, "data"),
    cacheDir: join(dir, "cache"),
    bundleDir: join(dir, "bundle"),
    platform: "linux",
    resolveImage: async () => ({
      url: `http://127.0.0.1:${server.port}/rootfs.tar`,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
    }),
  }
  const provider = createBwrapProvider(options)
  const dirs = sandboxDirs(options.dataDir, config.name)

  await provider.create(config)
  expect(await Bun.file(join(dirs.rootfs, "etc", "os-release")).text()).toBe("ID=codev-sandbox\n")
  expect((await stat(dirs.home)).isDirectory()).toBe(true)

  await writeFile(join(dirs.home, "state.db"), "guest state")
  await provider.reset(config)
  expect(await stat(join(dirs.home, "state.db")).catch(() => null)).toBe(null)
  expect(await Bun.file(join(dirs.rootfs, "etc", "os-release")).text()).toBe("ID=codev-sandbox\n")
  expect(downloads).toBe(1)

  await provider.destroy(config)
  expect(await stat(dirs.base).catch(() => null)).toBe(null)

  server.stop(true)
  await rm(dir, { recursive: true, force: true })
})

test("start installs the seccomp filter through an inherited fd by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const child = fakeChild()
  const prepared = await startOptions(dir, child)
  const provider = createBwrapProvider(prepared.options)
  const sandbox = await provider.start({ ...config, projectDir: prepared.projectDir })
  const call = prepared.spawnCalls[0]!
  expect(call.args.join(" ")).toContain("--seccomp 3")
  // Slot 3 is an open descriptor on the compiled program, which is also left
  // in the runtime dir for inspection; the parent's handle is closed after
  // spawn, so the fd number alone is what remains.
  expect(typeof call.stdio[3]).toBe("number")
  const program = await Bun.file(
    join(sandboxDirs(prepared.options.dataDir, config.name).runtime, "seccomp.bpf"),
  ).bytes()
  expect(program.length % 8).toBe(0)
  expect(program.length).toBeGreaterThan(8 * 100)
  sandbox.stop()
  await rm(dir, { recursive: true, force: true })
})

test("start skips the filter when the sandbox or the provider turns it off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const child = fakeChild()
  const prepared = await startOptions(dir, child, { seccomp: "off" })
  const provider = createBwrapProvider(prepared.options)
  const sandbox = await provider.start({ ...config, projectDir: prepared.projectDir })
  expect(prepared.spawnCalls[0]!.args).not.toContain("--seccomp")
  expect(prepared.spawnCalls[0]!.stdio.length).toBe(3)
  sandbox.stop()

  // The per-sandbox setting wins over the provider default, in both directions.
  const enforced = await provider.start({ ...config, projectDir: prepared.projectDir, seccomp: "audit" })
  expect(prepared.spawnCalls[1]!.args.join(" ")).toContain("--seccomp 3")
  enforced.stop()
  await rm(dir, { recursive: true, force: true })
})

test("start refuses to filter on an architecture without a syscall table", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bwrap-"))
  const child = fakeChild()
  const prepared = await startOptions(dir, child, { arch: "ia32" })
  const provider = createBwrapProvider(prepared.options)
  expect(provider.start({ ...config, projectDir: prepared.projectDir })).rejects.toThrow(
    "seccomp filtering is not available on ia32",
  )
  await rm(dir, { recursive: true, force: true })
})
