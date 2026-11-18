import { spawn } from "node:child_process"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import { release } from "node:os"
import { join } from "node:path"
import {
  SANDBOX_GUEST_LAUNCHER,
  checkSandboxHealth,
  generateSandboxCredentials,
  pollSandboxHealth,
  sandboxBootEnv,
} from "../boot"
import { startWslReverseTunnel, WSL_GUEST_BRIDGE_SOURCE } from "./bridge"
import { createBrokerServer, type SandboxEgress } from "../broker"
import { localImageAsset, readImageMarker, stageAsset, writeImageMarker } from "../image"
import { wslFirewallScript } from "./firewall"
import type { SandboxAsset } from "../manifest"
import { WINDOWS_11_FIRST_BUILD, windowsBuildNumber, windowsSandboxAvailability } from "../policy"
import type {
  ResolvedSandboxMount,
  SandboxAvailability,
  SandboxConfig,
  SandboxJobOptions,
  SandboxProvider,
} from "../provider"
import { parseDistroList, reserveLoopbackPort, runWsl, wslEnvSpec, wslFailureDetail } from "./cli"

// The HCS error family wsl.exe raises when the WSL2 utility VM cannot start:
// VirtualMachinePlatform enabled but inactive until Windows restarts, or
// virtualization switched off in firmware. 0x80370102 is the numeric form of
// HCS_E_HYPERV_NOT_INSTALLED on builds that print no symbolic name.
const WSL_VM_UNAVAILABLE = /0x80370102|0x80370114|HCS_E_HYPERV_NOT_INSTALLED|HCS_E_SERVICE_NOT_AVAILABLE/i
const WSL_VM_UNAVAILABLE_HINT =
  "WSL 2 could not start its virtual machine. If WSL was just installed, restart Windows and try again; if it still fails, enable virtualization in the machine's BIOS/UEFI settings."

// Guest-side paths. The bundle mount point and the launcher are baked into the
// image, so they match the vz and bwrap backends exactly.
const GUEST_HOME = "/home/codev"
const GUEST_BUNDLE = "/opt/codev"

// --import unpacks a multi-hundred-MB rootfs into a fresh vhdx; --unregister
// deletes the distro's disk, which scales with how much the sandbox wrote.
// Everything else keeps runWsl's 20s wedge guard.
const WSL_IMPORT_TIMEOUT_MS = 15 * 60_000
const WSL_UNREGISTER_TIMEOUT_MS = 5 * 60_000

export type WslProviderOptions = {
  dataDir: string
  cacheDir: string
  // Windows path of the server bundle (dist/node). Bind-mounted onto
  // GUEST_BUNDLE inside the distro so version parity with the desktop app is
  // automatic — the image never bakes a server.
  bundleDir: string
  resolveImage: (opts?: { signal?: AbortSignal }) => Promise<SandboxAsset>
  // Grants the guest egress via the host-side broker. Unlike vz/bwrap the WSL
  // guest reaches the host over the NAT default gateway, not a unix socket,
  // so the broker listens on TCP. guestBrokerPort is where the stub listens on
  // the guest loopback — per-sandbox here because every WSL2 distro shares the
  // VM loopback, so a fixed port would collide across concurrent sandboxes.
  resolveEgress?: (opts: { guestBrokerPort: number }) => Promise<SandboxEgress | null>
  // The Windows build the published WSL installer needs, for the availability
  // warning. Injected like resolveImage so the provider keeps no URLs and no
  // fetch policy of its own; absent, or resolving null, falls back to the
  // policy's own build tiers.
  resolveInstallerMinBuild?: (opts?: { signal?: AbortSignal }) => Promise<number | null>
  wslCommand?: string
  platform?: NodeJS.Platform
  osRelease?: () => string
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  startTimeoutMs?: number
}

// WSL distribution names appear in `wsl --list` and as directory names, so keep
// them to characters that are safe in both.
export function wslDistroName(name: string) {
  return `codev-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}`
}

export function wslSandboxDirs(dataDir: string, name: string) {
  const base = join(dataDir, name)
  return { base, install: join(base, "distro"), config: join(base, "config") }
}

export function createWslProvider(options: WslProviderOptions): SandboxProvider {
  const platform = options.platform ?? process.platform
  const osRelease = options.osRelease ?? release
  const spawnImpl = options.spawnImpl ?? spawn
  const fetchImpl = options.fetchImpl ?? fetch
  const startTimeoutMs = options.startTimeoutMs ?? 120_000
  const wsl = (args: string[], opts?: { timeoutMs?: number }) =>
    runWsl(args, { wslCommand: options.wslCommand, spawnImpl, timeoutMs: opts?.timeoutMs })

  const registered = async (distro: string) => {
    const listed = await wsl(["--list", "--quiet"])
    return parseDistroList(listed.stdout).includes(distro)
  }

  // Windows paths have to be translated before they can be referenced inside
  // the distro; wslpath is the only translation that accounts for the user's
  // actual /etc/wsl.conf automount settings.
  const guestPath = async (distro: string, windowsPath: string) => {
    const translated = await wsl(["-d", distro, "--exec", "wslpath", "-a", "-u", windowsPath])
    const path = translated.stdout.trim()
    if (translated.code !== 0 || !path.length)
      throw new Error(`could not translate ${windowsPath} for the sandbox: ${wslFailureDetail(translated)}`)
    return path
  }

  // Unregistering is what actually deletes a WSL sandbox's disk; removing the
  // install directory only cleans up what --import left behind.
  const discard = async (config: SandboxConfig) => {
    const distro = wslDistroName(config.name)
    if (await registered(distro)) {
      await wsl(["--terminate", distro])
      const unregistered = await wsl(["--unregister", distro], { timeoutMs: WSL_UNREGISTER_TIMEOUT_MS })
      if (unregistered.code !== 0)
        throw new Error(`wsl --unregister failed for ${distro}: ${wslFailureDetail(unregistered)}`)
    }
    await rm(wslSandboxDirs(options.dataDir, config.name).base, { recursive: true, force: true })
  }

  const prepare = async (config: SandboxConfig, opts?: SandboxJobOptions) => {
    const distro = wslDistroName(config.name)
    const asset = config.imagePath
      ? await localImageAsset(config.imagePath)
      : await options.resolveImage({ signal: opts?.signal })
    const dirs = wslSandboxDirs(options.dataDir, config.name)
    if (await registered(distro)) {
      // Registered on the current image: nothing to do. A stale (or unknown)
      // image means the distro must be rebuilt — an import cannot overlay an
      // existing distribution.
      const marker = await readImageMarker(dirs.base)
      if (marker?.sha256 === asset.sha256) return
      await wsl(["--terminate", distro])
      const unregistered = await wsl(["--unregister", distro], { timeoutMs: WSL_UNREGISTER_TIMEOUT_MS })
      if (unregistered.code !== 0)
        throw new Error(`wsl --unregister failed for ${distro}: ${wslFailureDetail(unregistered)}`)
      await rm(dirs.install, { recursive: true, force: true })
    }
    const tarball = await stageAsset(options.cacheDir, asset, {
      fetchImpl,
      signal: opts?.signal,
      onProgress: opts?.onProgress,
    })
    await mkdir(dirs.install, { recursive: true })
    const imported = await wsl(["--import", distro, dirs.install, tarball, "--version", "2"], {
      timeoutMs: WSL_IMPORT_TIMEOUT_MS,
    })
    if (imported.code !== 0) {
      // Import is the first command that needs the WSL2 utility VM, so a
      // machine that installed WSL but has not restarted yet fails here.
      const detail = wslFailureDetail(imported)
      const hint = WSL_VM_UNAVAILABLE.test(detail) ? ` ${WSL_VM_UNAVAILABLE_HINT}` : ""
      throw new Error(`wsl --import failed for ${distro}: ${detail}${hint}`)
    }
    // Windows has no uid to match, so the guest keeps its own codev user and
    // the Windows drives are automounted as that user — without this the
    // unprivileged server could not write the project directory. wsl.conf is
    // read at distro boot, so write it and terminate before the first start.
    const configured = await wsl([
      "-d",
      distro,
      "-u",
      "root",
      "--",
      "/bin/sh",
      "-c",
      `printf '[automount]\\noptions = "metadata,uid=1000,gid=1000"\\n' > /etc/wsl.conf`,
    ])
    if (configured.code !== 0)
      throw new Error(`could not write /etc/wsl.conf in ${distro}: ${wslFailureDetail(configured)}`)
    await wsl(["--terminate", distro])
    await writeImageMarker(dirs.base, asset)
  }

  return {
    backend: "wsl",

    async availability(): Promise<SandboxAvailability> {
      if (platform !== "win32") return { supported: false, message: "WSL sandboxes require Windows" }
      // --status, not --version: --version answers from the installed MSI
      // alone and passed on machines where WSL could not run — a restart
      // still pending, or Windows 10 without the WSL optional component
      // (observed live as Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED while
      // --version reported 2.x). --status fails, and says why, exactly when
      // running a distro would; its reason is worth showing over a generic
      // line, and the dialogs offer the app's own installer either way.
      const status = await wsl(["--status"]).catch(() => null)
      if (!status || status.code !== 0) {
        const detail = status ? wslFailureDetail(status) : null
        return {
          supported: false,
          message: detail
            ? `WSL 2 is not ready: ${detail}`
            : "WSL 2 is not installed. Install it to use the sandbox, then try again.",
        }
      }
      const build = windowsBuildNumber(osRelease())
      // Only asked when a warning is actually in play. Every Windows 11 build
      // is above every floor Microsoft has published for WSL, so on the common
      // machine this costs no round trip at all.
      const recommended =
        build !== null && build < WINDOWS_11_FIRST_BUILD
          ? await options.resolveInstallerMinBuild?.().catch(() => null)
          : null
      return windowsSandboxAvailability(build, recommended)
    },

    async create(config, opts) {
      await prepare(config, opts)
    },

    async start(config) {
      const distro = wslDistroName(config.name)
      const project = await stat(config.projectDir).catch(() => null)
      if (!project?.isDirectory()) throw new Error(`project directory does not exist: ${config.projectDir}`)
      if (!(await registered(distro))) throw new Error(`sandbox has not been created: no WSL distribution ${distro}`)

      // Extra mounts need no guest work at all: automount already exposes the
      // fixed Windows drives inside the distro, so resolving a mount is pure
      // path translation. Unlike projectDir a broken one is skipped, not
      // fatal — a deleted extra folder must not brick the start.
      const mounts: ResolvedSandboxMount[] = []
      for (const mount of config.mounts ?? []) {
        const found = await stat(mount.path).catch(() => null)
        if (!found?.isDirectory()) continue
        const translated = await guestPath(distro, mount.path).catch(() => null)
        if (translated) mounts.push({ path: mount.path, guestPath: translated })
      }

      const credentials = generateSandboxCredentials()
      // Host and guest must agree on one port: WSL2 republishes the guest's
      // loopback port under the same number on the Windows loopback.
      const port = await reserveLoopbackPort()
      // The broker stub cannot sit on a fixed guest port here: every WSL2
      // distro shares the VM loopback, so a second sandbox's stub would lose
      // the bind silently and its model traffic would land on the first
      // sandbox's broker. Reserving against the Windows loopback is the right
      // uniqueness domain because WSL republishes guest loopback binds there.
      const guestBrokerPort = await reserveLoopbackPort()

      const egress = (await options.resolveEgress?.({ guestBrokerPort })) ?? null
      // No routes means no egress at all — the config injection below can
      // still apply without a listener.
      const broker = egress?.routes.length
        ? createBrokerServer({ routes: egress.routes, fetchImpl: egress.fetchImpl ?? fetchImpl, auth: egress.auth })
        : null
      // Mirrored networking (a .wslconfig opt-in, standard on corporate
      // machines where it is the fix for VPNs and proxies) removes the NAT
      // topology this bridge assumes: the guest's default gateway is the LAN
      // router, not the Windows host, and the host is reachable as 127.0.0.1
      // because the loopback is shared. wslinfo ships with every WSL that has
      // mirrored mode, so a failed query means NAT.
      const networking = broker
        ? await wsl(["-d", distro, "--exec", "wslinfo", "--networking-mode"]).catch(() => null)
        : null
      const mirrored = networking?.code === 0 && networking.stdout.trim() === "mirrored"
      // Under NAT the guest dials the host's vEthernet address, which loopback
      // cannot serve; under mirrored networking the shared loopback reaches
      // this listener, so it need not (and should not) be open to the LAN.
      const brokerPort = broker ? await broker.listen(mirrored ? "127.0.0.1" : "0.0.0.0") : null
      // Rendezvous for the reverse bridge (bridge.ts): when the guest cannot
      // reach the broker directly, it listens here on its loopback and the
      // host dials in through the Windows-loopback republish of that bind.
      // Reserved host-side like the other two because the republish makes the
      // Windows loopback the uniqueness domain.
      const rendezvousPort = broker ? await reserveLoopbackPort() : null
      const configDir = wslSandboxDirs(options.dataDir, config.name).config
      if (egress?.guestConfig) {
        await mkdir(configDir, { recursive: true })
        await writeFile(join(configDir, "codev.json"), egress.guestConfig)
      }

      const env = {
        ...sandboxBootEnv(credentials, GUEST_HOME, { hostname: "127.0.0.1", port }),
        HOME: GUEST_HOME,
        // Merged between the guest's global and project configs.
        ...(egress?.guestConfig ? { CODEV_CONFIG: "/codev-config/codev.json" } : {}),
      }
      const bootScript = [
        `set -u`,
        // The image ships an empty GUEST_BUNDLE; binding the host bundle over it
        // keeps the launcher's import path identical across backends.
        `mount --bind ${shellQuote(await guestPath(distro, options.bundleDir))} ${GUEST_BUNDLE}`,
        ...(egress?.guestConfig
          ? [`mount --bind ${shellQuote(await guestPath(distro, configDir))} /codev-config`]
          : []),
        `cp -Rn /etc/skel/. "$HOME"/ 2>/dev/null || true`,
        `chown -R codev:codev "$HOME" 2>/dev/null || true`,
        `if [ -f /etc/codev-guest.env ]; then . /etc/codev-guest.env; fi`,
        // Where the guest-loopback broker stub finds the host's TCP broker.
        // Under NAT that is the default gateway; under mirrored networking the
        // gateway is the LAN router and the host is the shared 127.0.0.1 — so
        // probe an ordered candidate list instead of trusting the route table.
        // When neither answers (a managed host firewall silently dropping
        // WSL-to-host traffic), fall back to tunnel mode: the host dials into
        // the guest instead (bridge.ts), announced to the host on stdout. The
        // probe runs before the firewall confines this shell, so nothing here
        // needs an allow rule. The gateway can lag the distro on a cold VM
        // boot, so poll briefly instead of capturing whatever the route table
        // says first. Tunnel mode keeps a loopback HOST_IP so the nft rule
        // below stays well-formed; nothing dials it.
        ...(brokerPort !== null
          ? [
              `GATEWAY_IP=""`,
              `for _ in $(seq 1 50); do`,
              `  GATEWAY_IP=$(ip route show default | awk '{print $3; exit}')`,
              `  [ -n "$GATEWAY_IP" ] && break`,
              `  sleep 0.2`,
              `done`,
              `HOST_IP=""`,
              `for CANDIDATE in ${mirrored ? "127.0.0.1 $GATEWAY_IP" : "$GATEWAY_IP 127.0.0.1"}; do`,
              `  socat -u -T 2 OPEN:/dev/null TCP:$CANDIDATE:${brokerPort},connect-timeout=2 || continue`,
              `  HOST_IP=$CANDIDATE`,
              `  break`,
              `done`,
              `BRIDGE_MODE=direct`,
              `[ -n "$HOST_IP" ] || { echo "codev sandbox: cannot reach the host broker directly; using the reverse bridge" >&2; BRIDGE_MODE=tunnel; HOST_IP=127.0.0.1; }`,
              `echo "codev-bridge-mode: $BRIDGE_MODE"`,
            ]
          : []),
        // The firewall confines this boot's process tree before anything that
        // can reach the network starts; the socat bridge below is inside the
        // confined cgroup and rides the broker allow rule.
        ...wslFirewallScript({ distro, serverPort: port, brokerPort }),
        // Direct mode bridges with socat; tunnel mode runs the guest half of
        // the reverse bridge, which serves the identical loopback stub — the
        // server's model base URL never changes. The daemon source travels
        // over this script's own stdin delivery, so the published images need
        // nothing new; the quoted delimiter keeps its $ and backticks literal.
        ...(brokerPort !== null && rendezvousPort !== null
          ? [
              `cat > /tmp/codev-bridge.mjs <<'CODEV_BRIDGE_EOF'`,
              WSL_GUEST_BRIDGE_SOURCE.trimEnd(),
              `CODEV_BRIDGE_EOF`,
              `if [ "$BRIDGE_MODE" = direct ]; then`,
              `  socat TCP-LISTEN:${guestBrokerPort},bind=127.0.0.1,fork,reuseaddr TCP:$HOST_IP:${brokerPort} &`,
              `else`,
              `  node /tmp/codev-bridge.mjs ${guestBrokerPort} ${rendezvousPort} &`,
              `fi`,
            ]
          : []),
        `cd ${shellQuote(await guestPath(distro, config.projectDir))}`,
        // Root did the bind mounts and the socat bridge; the agent itself runs
        // as the image's unprivileged codev user, which owns the automounted
        // Windows drives per the wsl.conf written at import.
        `exec setpriv --reuid=codev --regid=codev --init-groups node ${SANDBOX_GUEST_LAUNCHER}`,
      ].join("\n")

      // The script goes to /bin/sh over stdin, never through wsl.exe's argv:
      // wsl.exe reassembles its command line from Windows argv and drops the
      // backslash-escaped quotes node's spawn produces, which silently
      // corrupted any quoted space (observed live: `cut -d" " -f3` reached the
      // guest as a broken delimiter and the broker bridge dialed an empty
      // host). Stdin delivery has no quoting layer to corrupt.
      const child = spawnImpl(options.wslCommand ?? "wsl.exe", ["-d", distro, "-u", "root", "--", "/bin/sh"], {
        stdio: ["pipe", "pipe", "pipe"],
        // WSLENV forwards these into the distro without exposing the password
        // on a command line that any host process could read.
        env: { ...process.env, ...env, WSLENV: wslEnvSpec(Object.keys(env)) },
      })
      child.stdin?.end(`${bootScript}\n`)
      let stderrTail = ""
      child.stderr?.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-8000)
      })
      // The boot script announces which bridge carries broker traffic before
      // it starts the server, so the marker is on this pipe before health can
      // pass. Resolving is idempotent, which also means nothing the server
      // prints later can change the answer.
      let announceBridgeMode!: (mode: "direct" | "tunnel") => void
      const bridgeModeSeen = new Promise<"direct" | "tunnel">((resolve) => {
        announceBridgeMode = resolve
      })
      let stdoutTail = ""
      child.stdout?.on("data", (chunk) => {
        stdoutTail = `${stdoutTail}${chunk}`.slice(-8000)
        const mode = stdoutTail.match(/codev-bridge-mode: (direct|tunnel)/)?.[1]
        if (mode === "direct" || mode === "tunnel") announceBridgeMode(mode)
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }))
      })
      const url = `http://127.0.0.1:${port}`

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
        void wsl(["--terminate", distro])
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

      // Start the host half of the reverse bridge only when the guest chose
      // it. The timeout guards a pathological pipe stall; direct — the
      // do-nothing historical behavior — is the safe assumption.
      const bridge = await (async () => {
        if (brokerPort === null || rendezvousPort === null) return null
        let markerTimeout: ReturnType<typeof setTimeout> | undefined
        const mode = await Promise.race([
          bridgeModeSeen,
          new Promise<"direct">((resolve) => {
            markerTimeout = setTimeout(() => resolve("direct"), 10_000)
          }),
        ])
        clearTimeout(markerTimeout)
        if (mode !== "tunnel") return null
        return startWslReverseTunnel({ rendezvousPort, brokerPort })
      })()

      return {
        url,
        username: credentials.username,
        password: credentials.password,
        mounts,
        stop: () => {
          bridge?.stop()
          child.kill()
          // Killing wsl.exe ends the command but leaves the distro's VM running;
          // terminating it releases the loopback port mapping too.
          void wsl(["--terminate", distro])
          void broker?.close()
        },
        onExit: (cb) => {
          void exited.then((exit) => {
            bridge?.stop()
            void broker?.close()
            cb(exit.code, exit.signal)
          })
        },
      }
    },

    async destroy(config) {
      await discard(config)
    },

    async reset(config, opts) {
      await discard(config)
      await prepare(config, opts)
    },

    // Hot-applies the mount list to the running distro. All wsl.exe
    // invocations share the distro's mount namespace and the drives are
    // already automounted, so translation is the only work. Throws on an
    // unusable path: this runs before the controller persists the config and
    // doubles as the hot path's validation gate.
    async applyMounts(config) {
      const distro = wslDistroName(config.name)
      const resolved: ResolvedSandboxMount[] = []
      for (const mount of config.mounts ?? []) {
        const found = await stat(mount.path).catch(() => null)
        if (!found?.isDirectory()) throw new Error(`folder does not exist: ${mount.path}`)
        resolved.push({ path: mount.path, guestPath: await guestPath(distro, mount.path) })
      }
      return resolved
    },
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
