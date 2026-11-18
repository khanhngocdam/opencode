import { spawn } from "node:child_process"
import { constants, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { checkSandboxHealth, generateSandboxCredentials, pollSandboxHealth, sandboxBootEnv } from "../boot"
import { createBrokerServer, type SandboxEgress } from "../broker"
import { forwardTcpToUnix } from "../bwrap/bridge"
import { runCommand, unpackRootfs } from "../bwrap/rootfs"
import { localImageAsset, readImageMarker, stageAsset, writeImageMarker } from "../image"
import type { SandboxAsset } from "../manifest"
import { resolveGuestMounts } from "../mounts"
import { macosSandboxAvailability } from "../policy"
import { createSandboxSocketDir } from "../socket"
import { SANDBOX_DEFAULT_CPUS, SANDBOX_DEFAULT_MEMORY_MIB } from "../provider"
import type { SandboxAvailability, SandboxConfig, SandboxJobOptions, SandboxProvider } from "../provider"
import { createVzHelperEventReader, type VzHelperEvent, type VzVmConfig } from "./protocol"

// Contents of the vz image tarball (built by the image pipeline).
export const VZ_KERNEL_FILE = "vmlinux"
export const VZ_INITRD_FILE = "initrd"
export const VZ_DISK_FILE = "rootfs.img"

// Guest agent contract: the image's init bridges vsock SERVER_PORT to the
// codev server's TCP port and dials vsock BROKER_PORT for egress, reading
// credentials and serve args from the "config" virtio-fs share's boot.json.
export const VZ_SERVER_VSOCK_PORT = 4096
export const VZ_BROKER_VSOCK_PORT = 8788
export const VZ_GUEST_HOME = "/home/codev"
const VZ_CMDLINE = "console=hvc0 root=/dev/vda rw init=/sbin/codev-init"

export type VzProviderOptions = {
  dataDir: string
  cacheDir: string
  // Host path of the server bundle (dist/node), shared read-only into the
  // guest so version parity with the desktop app is automatic.
  bundleDir: string
  // The signed codev-vmm binary (native/vzhelper).
  helperPath: string
  resolveImage: (opts?: { signal?: AbortSignal }) => Promise<SandboxAsset>
  // Grants the guest egress: broker routes served on the runtime broker
  // socket, plus an optional guest codev config announced via CODEV_CONFIG.
  // Absent or null, the guest boots with no egress at all. guestBrokerPort is
  // fixed: the image's codev-init bakes the loopback stub on 8788, and the vz
  // guest's loopback is private so it cannot collide.
  resolveEgress?: (opts: { guestBrokerPort: number }) => Promise<SandboxEgress | null>
  // Defaults for sandboxes that do not set their own.
  cpus?: number
  memoryMiB?: number
  platform?: NodeJS.Platform
  readMacosVersion?: () => Promise<string | null>
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  startTimeoutMs?: number
}

export function vzSandboxDirs(dataDir: string, name: string) {
  const base = join(dataDir, name)
  return {
    base,
    image: join(base, "image"),
    disk: join(base, "disk.img"),
    runtime: join(base, "runtime"),
    guestConfig: join(base, "guest-config"),
  }
}

export function createVzProvider(options: VzProviderOptions): SandboxProvider {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  const fetchImpl = options.fetchImpl ?? fetch
  const startTimeoutMs = options.startTimeoutMs ?? 60_000
  const readMacosVersion = options.readMacosVersion ?? defaultMacosVersion

  const provision = async (config: SandboxConfig, asset: SandboxAsset, opts?: SandboxJobOptions) => {
    const dirs = vzSandboxDirs(options.dataDir, config.name)
    const marker = await readImageMarker(dirs.base)
    if (marker?.sha256 !== asset.sha256) {
      const image = await stageAsset(options.cacheDir, asset, {
        fetchImpl,
        signal: opts?.signal,
        onProgress: opts?.onProgress,
      })
      await unpackRootfs(image, dirs.image, opts)
      // initrd is optional: the pipeline's custom kernel has virtio + ext4
      // compiled in and boots without one.
      const missing = []
      for (const file of [VZ_KERNEL_FILE, VZ_DISK_FILE]) {
        const found = await stat(join(dirs.image, file)).catch(() => null)
        if (!found?.isFile()) missing.push(file)
      }
      if (missing.length) throw new Error(`vz image is missing ${missing.join(", ")}`)
      await writeImageMarker(dirs.base, asset)
    }
    // The pristine unpacked disk stays untouched; the instance runs a
    // copy-on-write clone, so reset is just re-cloning.
    await cloneDisk(join(dirs.image, VZ_DISK_FILE), dirs.disk, platform)
  }

  // A custom image is used from where it lies; otherwise the published one
  // is resolved from the manifest and downloaded.
  const resolveAsset = (config: SandboxConfig, opts?: SandboxJobOptions) =>
    config.imagePath ? localImageAsset(config.imagePath) : options.resolveImage({ signal: opts?.signal })

  const prepare = async (config: SandboxConfig, opts?: SandboxJobOptions) => {
    await provision(config, await resolveAsset(config, opts), opts)
  }

  return {
    backend: "vz",

    async availability(): Promise<SandboxAvailability> {
      if (platform !== "darwin")
        return { supported: false, message: "Virtualization framework sandboxes require macOS" }
      const version = await readMacosVersion()
      const policy = macosSandboxAvailability(version ?? "")
      if (!policy.supported) return policy
      const helper = await stat(options.helperPath).catch(() => null)
      if (!helper?.isFile())
        return { supported: false, message: `sandbox VM helper is not installed (expected at ${options.helperPath})` }
      return policy
    },

    async create(config, opts) {
      await prepare(config, opts)
    },

    async start(config) {
      const dirs = vzSandboxDirs(options.dataDir, config.name)
      const project = await stat(config.projectDir).catch(() => null)
      if (!project?.isDirectory()) throw new Error(`project directory does not exist: ${config.projectDir}`)
      const disk = await stat(dirs.disk).catch(() => null)
      if (!disk?.isFile()) throw new Error(`sandbox has not been created: missing disk at ${dirs.disk}`)
      await rm(dirs.runtime, { recursive: true, force: true })
      await mkdir(dirs.runtime, { recursive: true })
      await mkdir(dirs.guestConfig, { recursive: true })
      // Extra mounts, unlike projectDir, must not brick the start: a folder
      // deleted since it was added is skipped, not fatal.
      const accessible = []
      for (const mount of config.mounts ?? []) {
        const found = await stat(mount.path).catch(() => null)
        if (found?.isDirectory()) accessible.push(mount)
      }
      const guestMounts = resolveGuestMounts(accessible)
      // Written every start, even when empty: guest-config persists across
      // starts, and a stale list from the previous boot must not survive. The
      // image's codev-init reads it and mounts each tag.
      await writeFile(
        join(dirs.guestConfig, "mounts.json"),
        JSON.stringify({ mounts: guestMounts.map((mount) => ({ tag: mount.tag, path: mount.guestPath })) }),
      )
      // Sockets live outside the data dir: their absolute path must fit the
      // AF_UNIX limit, which the data dir alone nearly exhausts.
      const socketDir = await createSandboxSocketDir(dirs.base)

      // The broker must be listening before guest traffic flows: codev-vmm
      // dials runtime/broker.sock per guest connection and refuses when
      // nothing serves it.
      const egress = (await options.resolveEgress?.({ guestBrokerPort: VZ_BROKER_VSOCK_PORT })) ?? null
      // No routes means no egress at all — the config injection below can
      // still apply without a listener.
      const broker = egress?.routes.length
        ? createBrokerServer({ routes: egress.routes, fetchImpl: egress.fetchImpl ?? fetchImpl, auth: egress.auth })
        : null
      if (broker) await broker.listenUnix(join(socketDir, "broker.sock"))
      if (egress?.guestConfig) await writeFile(join(dirs.guestConfig, "codev.json"), egress.guestConfig)

      const credentials = generateSandboxCredentials()
      await writeFile(
        join(dirs.guestConfig, "boot.json"),
        JSON.stringify({
          env: {
            ...sandboxBootEnv(credentials, VZ_GUEST_HOME, { hostname: "127.0.0.1", port: VZ_SERVER_VSOCK_PORT }),
            // Merged between the guest's global and project configs.
            ...(egress?.guestConfig ? { CODEV_CONFIG: "/codev-config/codev.json" } : {}),
          },
        }),
      )
      const serverSocket = join(socketDir, "server.sock")
      const initrd = await stat(join(dirs.image, VZ_INITRD_FILE)).catch(() => null)
      const vmConfig: VzVmConfig = {
        kernel: join(dirs.image, VZ_KERNEL_FILE),
        initrd: initrd?.isFile() ? join(dirs.image, VZ_INITRD_FILE) : "",
        disk: dirs.disk,
        cmdline: VZ_CMDLINE,
        // Per-sandbox limits win over the provider-wide defaults.
        cpus: config.cpus ?? options.cpus ?? SANDBOX_DEFAULT_CPUS,
        memoryMiB: config.memoryMiB ?? options.memoryMiB ?? SANDBOX_DEFAULT_MEMORY_MIB,
        shares: [
          { tag: "workspace", path: config.projectDir, readOnly: false },
          { tag: "bundle", path: options.bundleDir, readOnly: true },
          { tag: "config", path: dirs.guestConfig, readOnly: true },
          ...guestMounts.map((mount) => ({ tag: mount.tag, path: mount.path, readOnly: false })),
        ],
        forwards: [
          { direction: "host-to-guest", vsockPort: VZ_SERVER_VSOCK_PORT, socketPath: serverSocket },
          { direction: "guest-to-host", vsockPort: VZ_BROKER_VSOCK_PORT, socketPath: join(socketDir, "broker.sock") },
        ],
      }
      const configPath = join(dirs.runtime, "vm.json")
      await writeFile(configPath, JSON.stringify(vmConfig))

      const child = spawnImpl(options.helperPath, [configPath], { stdio: ["pipe", "pipe", "pipe"] })
      let stderrTail = ""
      child.stderr?.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-8000)
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }))
      })
      const handlers: { error?: (message: string) => void; running?: () => void } = {}
      const helperError = new Promise<string>((resolve) => {
        handlers.error = resolve
      })
      const running = new Promise<"running">((resolve) => {
        handlers.running = () => resolve("running")
      })
      // A helper that cannot be spawned emits "error" and never "exit"; without
      // this the boot would sit out the whole start timeout (and an unhandled
      // "error" event would crash the process).
      child.once("error", (err) => {
        handlers.error?.(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `sandbox VM helper is not installed (expected at ${options.helperPath})`
            : `could not run the sandbox VM helper: ${err.message}`,
        )
      })
      child.stdout?.on(
        "data",
        createVzHelperEventReader((event: VzHelperEvent) => {
          if (event.event === "error") handlers.error?.(event.message)
          if (event.event === "state" && event.state === "running") handlers.running?.()
        }),
      )

      // Helper events arrive on stdout and can outrun the stderr pipe; give
      // stderr a beat to flush so failures carry the diagnostic tail.
      const failure = async (detail: string) => {
        child.kill()
        void broker?.close()
        await new Promise((resolve) => setTimeout(resolve, 100))
        const tail = stderrTail.trim()
        return new Error(`${detail}${tail ? `: ${tail}` : ""}`)
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), startTimeoutMs)
      })

      const bootOutcome = await Promise.race([running, helperError, exited, timeout])
      if (bootOutcome !== "running") {
        clearTimeout(timeoutHandle)
        if (bootOutcome === "timeout") throw await failure(`sandbox VM did not start within ${startTimeoutMs}ms`)
        if (typeof bootOutcome === "string") throw await failure(`sandbox VM failed: ${bootOutcome}`)
        throw await failure(
          `sandbox VM helper exited during startup (code=${bootOutcome.code ?? "null"} signal=${bootOutcome.signal ?? "null"})`,
        )
      }

      const forwarder = await forwardTcpToUnix(serverSocket)
      const url = `http://127.0.0.1:${forwarder.port}`
      const abort = new AbortController()
      const healthOutcome = await Promise.race([
        pollSandboxHealth(() => checkSandboxHealth(url, credentials, fetchImpl, abort.signal), abort.signal).then(
          () => "healthy" as const,
        ),
        helperError,
        exited,
        timeout,
      ])
      abort.abort()
      clearTimeout(timeoutHandle)
      if (healthOutcome !== "healthy") {
        await forwarder.close()
        if (healthOutcome === "timeout")
          throw await failure(`sandbox server did not become healthy within ${startTimeoutMs}ms`)
        if (typeof healthOutcome === "string") throw await failure(`sandbox VM failed: ${healthOutcome}`)
        throw await failure(
          `sandbox VM helper exited during startup (code=${healthOutcome.code ?? "null"} signal=${healthOutcome.signal ?? "null"})`,
        )
      }

      let stopKill: ReturnType<typeof setTimeout> | undefined
      void exited.then(() => clearTimeout(stopKill))
      return {
        url,
        username: credentials.username,
        password: credentials.password,
        mounts: guestMounts.map((mount) => ({ path: mount.path, guestPath: mount.guestPath })),
        stop: () => {
          // Ask the helper for a guest stop; escalate to kill if it hangs.
          child.stdin?.write('{"cmd":"stop"}\n')
          stopKill = setTimeout(() => child.kill(), 3000)
          void forwarder.close()
          void broker?.close()
        },
        onExit: (cb) => {
          void exited.then((exit) => {
            void forwarder.close()
            void broker?.close()
            cb(exit.code, exit.signal)
          })
        },
      }
    },

    async destroy(config) {
      await rm(vzSandboxDirs(options.dataDir, config.name).base, { recursive: true, force: true })
    },

    async reset(config, opts) {
      const dirs = vzSandboxDirs(options.dataDir, config.name)
      // Guest state lives in the instance disk. When the manifest still points
      // at the image this sandbox was built from, reset is just re-cloning the
      // pristine disk; when it has moved on, reset doubles as the upgrade path
      // and re-provisions from the current image.
      await rm(dirs.disk, { force: true })
      await provision(config, await resolveAsset(config, opts), opts)
    },
  }
}

// A copy-on-write clone of the pristine disk, falling back to a byte copy.
//
// `copyFile`'s COPYFILE_FICLONE is a no-op on macOS: libuv opens the
// destination and calls fcopyfile(), and only clonefile(2) — which takes paths
// and requires the destination not to exist — can share extents. So every
// provision wrote the whole image out instead: ~9s and a full 8 GiB per
// sandbox for a disk that should cost nothing, and it expands the source's
// sparse holes into real zeroes. Worse, the VM boots straight after, so the
// guest competes with gigabytes of write-back for the disk it is reading —
// that contention, not the image itself, is what pushed first boot past the
// 60s start budget. `cp -c` is the syscall; it fails outright rather than
// silently copying when the clone cannot happen, which is exactly the signal
// the fallback needs.
async function cloneDisk(source: string, destination: string, platform: NodeJS.Platform) {
  await rm(destination, { force: true })
  if (platform === "darwin") {
    const cloned = await runCommand("cp", ["-c", source, destination]).catch(() => null)
    if (cloned?.code === 0) return
    await rm(destination, { force: true })
  }
  await copyFile(source, destination, constants.COPYFILE_FICLONE)
}

async function defaultMacosVersion() {
  const result = await runCommand("sw_vers", ["-productVersion"]).catch(() => null)
  if (!result || result.code !== 0) return null
  return result.stdout.trim()
}
