import { spawn } from "node:child_process"
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  SANDBOX_GUEST_LAUNCHER,
  checkSandboxHealth,
  generateSandboxCredentials,
  pollSandboxHealth,
  sandboxBootEnv,
} from "../boot"
import { createBrokerServer, type SandboxEgress } from "../broker"
import { localImageAsset, readImageMarker, stageAsset, writeImageMarker } from "../image"
import type { SandboxAsset } from "../manifest"
import { resolveGuestMounts } from "../mounts"
import type { SandboxAvailability, SandboxConfig, SandboxJobOptions, SandboxProvider } from "../provider"
import { buildSeccompProgram, seccompArch } from "../seccomp/bpf"
import type { SeccompMode } from "../seccomp/policy"
import {
  GUEST_BRIDGE,
  GUEST_BROKER_PORT,
  GUEST_BUNDLE,
  GUEST_HOME,
  GUEST_PATH,
  GUEST_RUNTIME,
  GUEST_SERVER_PORT,
  buildBwrapArgs,
} from "./args"
import { GUEST_FORWARD_SCRIPT, forwardTcpToUnix } from "./bridge"
import { readRootfsEntries, runCommand, unpackRootfs } from "./rootfs"

export type BwrapProviderOptions = {
  dataDir: string
  cacheDir: string
  // Host path of the server bundle (dist/node), mounted read-only into the
  // guest so version parity with the desktop app is automatic.
  bundleDir: string
  resolveImage: (opts?: { signal?: AbortSignal }) => Promise<SandboxAsset>
  // Grants the guest egress: broker routes served on the runtime broker
  // socket, plus an optional guest codev config announced via CODEV_CONFIG.
  // Absent or null, the guest boots with no egress at all. guestBrokerPort is
  // fixed: the bwrap guest's network namespace (and thus loopback) is private,
  // so the stub port cannot collide with another sandbox's.
  resolveEgress?: (opts: { guestBrokerPort: number }) => Promise<SandboxEgress | null>
  // Syscall filter for sandboxes whose config does not choose one. enforce
  // is the default; audit only logs what enforce would refuse (kernel log),
  // and off installs no filter — the escape hatch for a workload the
  // allowlist breaks.
  seccomp?: SeccompMode
  bwrapCommand?: string
  guestNodeCommand?: string
  platform?: NodeJS.Platform
  arch?: string
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  startTimeoutMs?: number
}

export function sandboxDirs(dataDir: string, name: string) {
  const base = join(dataDir, name)
  return {
    base,
    rootfs: join(base, "rootfs"),
    home: join(base, "home"),
    runtime: join(base, "runtime"),
    bridge: join(base, "bridge"),
  }
}

export function createBwrapProvider(options: BwrapProviderOptions): SandboxProvider {
  const bwrap = options.bwrapCommand ?? "bwrap"
  const guestNode = options.guestNodeCommand ?? "node"
  const platform = options.platform ?? process.platform
  const arch = seccompArch(options.arch)
  const spawnImpl = options.spawnImpl ?? spawn
  const fetchImpl = options.fetchImpl ?? fetch
  const startTimeoutMs = options.startTimeoutMs ?? 30_000

  const prepare = async (config: SandboxConfig, opts?: SandboxJobOptions) => {
    const asset = config.imagePath
      ? await localImageAsset(config.imagePath)
      : await options.resolveImage({ signal: opts?.signal })
    const dirs = sandboxDirs(options.dataDir, config.name)
    // reset wipes the rootfs (it is the guest's mutable state), so a matching
    // marker alone is not proof — the rootfs must actually be there.
    const marker = await readImageMarker(dirs.base)
    const rootfs = await stat(dirs.rootfs).catch(() => null)
    if (marker?.sha256 !== asset.sha256 || !rootfs?.isDirectory()) {
      const image = await stageAsset(options.cacheDir, asset, {
        fetchImpl,
        signal: opts?.signal,
        onProgress: opts?.onProgress,
      })
      await unpackRootfs(image, dirs.rootfs, opts)
      await writeImageMarker(dirs.base, asset)
    }
    await mkdir(dirs.home, { recursive: true })
  }

  return {
    backend: "bwrap",

    async availability(): Promise<SandboxAvailability> {
      if (platform !== "linux") return { supported: false, message: "bubblewrap sandboxes require Linux" }
      const probe = await runCommand(bwrap, ["--ro-bind", "/", "/", "true"]).catch(() => null)
      if (!probe) return { supported: false, message: "bubblewrap (bwrap) is not installed" }
      if (probe.code !== 0)
        return {
          supported: false,
          message: `bubblewrap cannot create sandboxes on this system: ${probe.stderr.trim() || `bwrap exited ${probe.code}`}. On Ubuntu 23.10+ this usually means unprivileged user namespaces are restricted by AppArmor.`,
        }
      return { supported: true, warning: null }
    },

    async create(config, opts) {
      await prepare(config, opts)
    },

    async start(config) {
      const dirs = sandboxDirs(options.dataDir, config.name)
      const project = await stat(config.projectDir).catch(() => null)
      if (!project?.isDirectory()) throw new Error(`project directory does not exist: ${config.projectDir}`)
      const rootfs = await stat(dirs.rootfs).catch(() => null)
      if (!rootfs?.isDirectory()) throw new Error(`sandbox has not been created: missing rootfs at ${dirs.rootfs}`)
      await rm(dirs.runtime, { recursive: true, force: true })
      await mkdir(dirs.runtime, { recursive: true })
      await mkdir(dirs.bridge, { recursive: true })
      await mkdir(dirs.home, { recursive: true })
      await writeFile(join(dirs.bridge, "forward.mjs"), GUEST_FORWARD_SCRIPT)
      // Extra mounts, unlike projectDir, must not brick the start: a folder
      // deleted since it was added is skipped, not fatal.
      const accessible = []
      for (const mount of config.mounts ?? []) {
        const found = await stat(mount.path).catch(() => null)
        if (found?.isDirectory()) accessible.push(mount)
      }
      const guestMounts = resolveGuestMounts(accessible).map((mount) => ({
        path: mount.path,
        guestPath: mount.guestPath,
      }))

      // Listening before boot: the guest-side bridge dials broker.sock per
      // connection and drops it when nothing serves the socket.
      const egress = (await options.resolveEgress?.({ guestBrokerPort: GUEST_BROKER_PORT })) ?? null
      // No routes means no egress at all — the config injection below can
      // still apply without a listener.
      const broker = egress?.routes.length
        ? createBrokerServer({ routes: egress.routes, fetchImpl: egress.fetchImpl ?? fetchImpl, auth: egress.auth })
        : null
      if (broker) await broker.listenUnix(join(dirs.runtime, "broker.sock"))
      if (egress?.guestConfig) await writeFile(join(dirs.bridge, "codev.json"), egress.guestConfig)

      // The filter is compiled per start and handed to bwrap as an inherited
      // fd (stdio slot 3), which it reads in full before exec — so the file
      // is closed here the moment spawn returns. It stays in the runtime dir
      // as the record of what this instance runs under.
      const seccomp = config.seccomp ?? options.seccomp ?? "enforce"
      const seccompPath = join(dirs.runtime, "seccomp.bpf")
      if (seccomp !== "off") {
        if (!arch) throw new Error(`seccomp filtering is not available on ${options.arch ?? process.arch}`)
        await writeFile(seccompPath, buildSeccompProgram(arch, seccomp).bytes)
      }
      const seccompFile = seccomp === "off" ? null : await open(seccompPath, "r")

      const credentials = generateSandboxCredentials()
      const bootScript = [
        // Fresh homes get the image's skel (skills config); images may also
        // declare extra env (DOTNET_ROOT, NODE_PATH, ...) in codev-guest.env.
        `cp -Rn /etc/skel/. "$HOME"/ 2>/dev/null || true`,
        `[ -f /etc/codev-guest.env ] && . /etc/codev-guest.env`,
        `${guestNode} ${GUEST_BRIDGE}/forward.mjs unix-to-tcp ${GUEST_RUNTIME}/server.sock ${GUEST_SERVER_PORT} &`,
        `${guestNode} ${GUEST_BRIDGE}/forward.mjs tcp-to-unix ${GUEST_BROKER_PORT} ${GUEST_RUNTIME}/broker.sock &`,
        `exec ${guestNode} ${SANDBOX_GUEST_LAUNCHER}`,
      ].join("\n")
      const child = spawnImpl(
        bwrap,
        buildBwrapArgs({
          rootfsDir: dirs.rootfs,
          rootfsEntries: await readRootfsEntries(dirs.rootfs),
          projectDir: config.projectDir,
          mounts: guestMounts,
          bundleDir: options.bundleDir,
          bridgeDir: dirs.bridge,
          runtimeDir: dirs.runtime,
          homeDir: dirs.home,
          env: {
            ...sandboxBootEnv(credentials, GUEST_HOME, { hostname: "127.0.0.1", port: GUEST_SERVER_PORT }),
            PATH: GUEST_PATH,
            HOME: GUEST_HOME,
            // Merged between the guest's global and project configs.
            ...(egress?.guestConfig ? { CODEV_CONFIG: `${GUEST_BRIDGE}/codev.json` } : {}),
          },
          command: ["/bin/sh", "-c", bootScript],
          ...(seccompFile ? { seccompFd: 3 } : {}),
        }),
        { stdio: seccompFile ? ["ignore", "ignore", "pipe", seccompFile.fd] : ["ignore", "ignore", "pipe"] },
      )
      // spawn has already dup'd the fd into the child; the parent's copy is done.
      await seccompFile?.close()
      let stderrTail = ""
      child.stderr?.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-8000)
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }))
      })
      const forwarder = await forwardTcpToUnix(join(dirs.runtime, "server.sock"))
      const url = `http://127.0.0.1:${forwarder.port}`

      const abort = new AbortController()
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        pollSandboxHealth(() => checkSandboxHealth(url, credentials, fetchImpl, abort.signal), abort.signal).then(
          () => "healthy" as const,
        ),
        exited,
        new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timeout"), startTimeoutMs)
        }),
      ])
      abort.abort()
      clearTimeout(timeoutHandle)
      if (outcome !== "healthy") {
        child.kill()
        await forwarder.close()
        await broker?.close()
        const detail = stderrTail.trim()
        if (outcome === "timeout")
          throw new Error(
            `sandbox server did not become healthy within ${startTimeoutMs}ms${detail ? `: ${detail}` : ""}`,
          )
        throw new Error(
          `sandbox server exited during startup (code=${outcome.code ?? "null"} signal=${outcome.signal ?? "null"})${detail ? `: ${detail}` : ""}`,
        )
      }

      return {
        url,
        username: credentials.username,
        password: credentials.password,
        mounts: guestMounts,
        stop: () => {
          child.kill()
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
      await rm(sandboxDirs(options.dataDir, config.name).base, { recursive: true, force: true })
    },

    async reset(config, opts) {
      const dirs = sandboxDirs(options.dataDir, config.name)
      await rm(dirs.home, { recursive: true, force: true })
      await rm(dirs.rootfs, { recursive: true, force: true })
      await prepare(config, opts)
    },
  }
}
