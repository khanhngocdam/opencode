import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxConfig } from "../provider"
import { decodeWslOutput, parseDistroList, wslEnvSpec, wslFailureDetail } from "./cli"
import { createWslProvider, wslDistroName, type WslProviderOptions } from "./provider"

// tmpdir() rather than a literal /tmp so the suite also runs on the Windows
// machines this backend actually targets.
const config: SandboxConfig = { id: "sandbox:default", name: "default", backend: "wsl", projectDir: tmpdir() }
const ASSET_SHA = "a".repeat(64)

// A fake wsl.exe: tracks registered distros in a state file, answers wslpath,
// and for the boot command serves the health endpoint on the port the provider
// handed it through the environment instead of booting Linux. Output is UTF-16LE
// for the informational subcommands, matching the real wsl.exe.
const fakeWsl = (statePath: string) => `import { createServer } from "node:net"
import { readFileSync, writeFileSync } from "node:fs"
const state = ${JSON.stringify(statePath)}
const read = () => { try { return JSON.parse(readFileSync(state, "utf8")) } catch { return { distros: [] } } }
const write = (value) => writeFileSync(state, JSON.stringify(value))
const args = process.argv.slice(2)
const out = (text) => process.stdout.write(Buffer.from(text, "utf16le"))

if (args[0] === "--version") { out("WSL version: 2.3.24.0\\r\\n"); process.exit(0) }
if (args[0] === "--status") { out("Default Version: 2\\r\\n"); process.exit(0) }
if (args[0] === "--list") { out(read().distros.join("\\r\\n") + "\\r\\n"); process.exit(0) }
if (args[0] === "--import") {
  const value = read(); value.distros.push(args[1]); value.imports = (value.imports ?? 0) + 1; write(value)
  out("The operation completed successfully.\\r\\n"); process.exit(0)
}
if (args[0] === "--terminate") { process.exit(0) }
if (args[0] === "--unregister") {
  const value = read(); value.distros = value.distros.filter((d) => d !== args[1]); write(value)
  process.exit(0)
}
if (args.includes("wslpath")) { process.stdout.write("/mnt/hostpath\\n"); process.exit(0) }
if (args.includes("wslinfo")) { process.stdout.write((read().networkingMode ?? "nat") + "\\n"); process.exit(0) }

// The boot script arrives on stdin (never argv — wsl.exe corrupts quoted
// spaces there); import-time configuration still uses -- /bin/sh -c.
const script = args[args.length - 1] === "/bin/sh" ? readFileSync(0, "utf8") : args[args.length - 1]
if (script.includes("/etc/wsl.conf")) {
  const value = read(); value.wslConf = script; write(value)
  process.exit(0)
}

// Boot command: assert the script the provider built, then answer health checks.
if (!script.includes("mount --bind") || !script.includes("server-launch.mjs")) {
  process.stderr.write("unexpected boot script\\n"); process.exit(2)
}
{
  const value = read(); value.bootScript = script; value.codevConfigEnv = process.env.CODEV_CONFIG ?? null; write(value)
}
// The real boot script announces its bridge mode on stdout before the server
// starts; tunnel mode also stands up the rendezvous listener the host dials.
const bridgeMode = read().bridgeMode ?? "direct"
process.stdout.write("codev-bridge-mode: " + bridgeMode + "\\n")
if (bridgeMode === "tunnel") {
  const rendezvous = Number((script.match(/codev-bridge\\.mjs \\d+ (\\d+)/) ?? [])[1])
  createServer((socket) => {
    socket.on("error", () => {})
    const value = read(); value.rendezvousDials = (value.rendezvousDials ?? 0) + 1; write(value)
  }).listen(rendezvous, "127.0.0.1")
}
const listener = createServer((socket) => {
  socket.on("data", () => socket.end("HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok"))
})
listener.listen(Number(process.env.CODEV_SERVER_PORT), "127.0.0.1")
setInterval(() => {}, 1000)
`

// The fakes are .mjs scripts, so route them through the current runtime the way
// the vz tests route their fake helper.
const runViaExec = ((command: string, args: string[], opts: unknown) =>
  spawn(process.execPath, [command, ...args], opts as never)) as unknown as typeof spawn

async function preparedOptions(dir: string, overrides?: Partial<WslProviderOptions>) {
  const fake = join(dir, "fake-wsl.mjs")
  await writeFile(fake, fakeWsl(join(dir, "state.json")))
  // Pre-stage the asset so stageAsset short-circuits on its digest/size check
  // and the test never reaches the network.
  const cacheDir = join(dir, "cache")
  await mkdir(join(cacheDir, ASSET_SHA), { recursive: true })
  await writeFile(join(cacheDir, ASSET_SHA, "rootfs.tar.gz"), "x")
  return {
    dataDir: join(dir, "data"),
    cacheDir,
    bundleDir: "C:\\bundle\\dist\\node",
    resolveImage: async () => ({
      url: "https://example.invalid/sandbox/rootfs.tar.gz",
      sha256: ASSET_SHA,
      bytes: 1,
    }),
    wslCommand: fake,
    platform: "win32" as NodeJS.Platform,
    osRelease: () => "10.0.22631",
    spawnImpl: runViaExec,
    startTimeoutMs: 20_000,
    ...overrides,
  } satisfies WslProviderOptions
}

test("decodeWslOutput handles wsl.exe UTF-16LE and plain UTF-8", () => {
  expect(decodeWslOutput(Buffer.from("codev-default\r\n", "utf16le"))).toBe("codev-default\r\n")
  expect(decodeWslOutput(Buffer.from("/mnt/c/project\n", "utf8"))).toBe("/mnt/c/project\n")
})

test("parseDistroList drops blank lines and trailing CR", () => {
  expect(parseDistroList("codev-a\r\ncodev-b\r\n\r\n")).toEqual(["codev-a", "codev-b"])
})

test("wslDistroName keeps names safe for wsl --list and directories", () => {
  expect(wslDistroName("my project #1")).toBe("codev-my-project-1")
})

test("wslEnvSpec marks every variable host-to-guest only", () => {
  expect(wslEnvSpec(["CODEV_SERVER_PORT", "HOME"])).toBe("CODEV_SERVER_PORT/u:HOME/u")
})

// wsl.exe reports failures on stdout, not stderr; a message built from stderr
// alone reduced a real diagnostic to a bare "exited 4294967295".
test("wslFailureDetail keeps the stdout diagnostic and falls back to the exit code", () => {
  expect(wslFailureDetail({ code: 1, stdout: "", stderr: " bad \r\n" })).toBe("bad")
  expect(wslFailureDetail({ code: null, stdout: "Error code: Wsl/Service/CreateVm\r\n", stderr: "" })).toBe(
    "Error code: Wsl/Service/CreateVm",
  )
  expect(wslFailureDetail({ code: 4294967295, stdout: "", stderr: "" })).toBe("exited 4294967295")
})

test("availability refuses non-Windows hosts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir, { platform: "darwin" }))
  expect(await provider.availability()).toEqual({ supported: false, message: "WSL sandboxes require Windows" })
  await rm(dir, { recursive: true, force: true })
})

test("availability is clean on Windows 10 22H2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir, { osRelease: () => "10.0.19045" }))
  expect(await provider.availability()).toEqual({ supported: true, warning: null })
  await rm(dir, { recursive: true, force: true })
})

test("availability is clean on Windows 11", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir))
  expect(await provider.availability()).toEqual({ supported: true, warning: null })
  await rm(dir, { recursive: true, force: true })
})

test("availability warns against the installer's minimum build on an older machine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, {
      osRelease: () => "10.0.18363",
      resolveInstallerMinBuild: async () => 19041,
    }),
  )
  const availability = await provider.availability()
  expect(availability.supported).toBe(true)
  expect(availability.supported && availability.warning).toContain("19041")
  await rm(dir, { recursive: true, force: true })
})

// Every Windows 11 build clears every floor Microsoft has published, so the
// common machine must not pay a network round trip to learn that.
test("availability does not ask for the installer minimum on Windows 11", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  let asked = 0
  const provider = createWslProvider(
    await preparedOptions(dir, {
      resolveInstallerMinBuild: async () => {
        asked += 1
        return 19041
      },
    }),
  )
  expect(await provider.availability()).toEqual({ supported: true, warning: null })
  expect(asked).toBe(0)
  await rm(dir, { recursive: true, force: true })
})

// A storage host that cannot be reached must sharpen nothing and break
// nothing; the machine still gets the tier it had before the manifest existed.
test("availability survives an unreachable installer manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, {
      osRelease: () => "10.0.18363",
      resolveInstallerMinBuild: async () => {
        throw new Error("offline")
      },
    }),
  )
  const availability = await provider.availability()
  expect(availability.supported && availability.warning).toContain("out of support")
  await rm(dir, { recursive: true, force: true })
})

// The machine that shaped the --status probe: the MSI is installed, so
// --version passes, but Windows 10 without the WSL optional component cannot
// run a distro — and --status names the missing piece.
test("availability surfaces why an installed WSL cannot run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const fake = join(dir, "fake-wsl-status.mjs")
  await writeFile(
    fake,
    `const out = (text) => process.stdout.write(Buffer.from(text, "utf16le"))
if (process.argv[2] === "--version") { out("WSL version: 2.3.24.0\\r\\n"); process.exit(0) }
out("This application requires the Windows Subsystem for Linux Optional Component.\\r\\nError code: Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\\r\\n")
process.exit(1)
`,
  )
  const provider = createWslProvider(await preparedOptions(dir, { wslCommand: fake }))
  const availability = await provider.availability()
  expect(availability.supported).toBe(false)
  if (!availability.supported) expect(availability.message).toContain("WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED")
  await rm(dir, { recursive: true, force: true })
})

// wsl.exe missing entirely (spawn fails): the one case with no wsl.exe output
// to show, so the generic install prompt is the message.
test("availability reports unsupported when wsl.exe is not there at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, { wslCommand: join(dir, "missing-wsl.exe"), spawnImpl: spawn }),
  )
  const availability = await provider.availability()
  expect(availability.supported).toBe(false)
  expect(availability.supported === false && availability.message).toContain("WSL 2 is not installed")
  await rm(dir, { recursive: true, force: true })
})

test("start refuses a sandbox that was never created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir))
  await expect(provider.start(config)).rejects.toThrow(`no WSL distribution ${wslDistroName(config.name)}`)
  await rm(dir, { recursive: true, force: true })
})

test("create imports the distro once and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir))
  await provider.create(config)
  await provider.create(config)
  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  expect(state.distros).toEqual([wslDistroName(config.name)])
  expect(state.imports).toBe(1)
  await rm(dir, { recursive: true, force: true })
})

// The failure a machine that installed WSL 2 but has not restarted shows:
// --import needs the WSL2 utility VM, wsl.exe puts the diagnostic on stdout in
// UTF-16LE, stderr stays empty, and the exit code is -1.
test("an import failure surfaces wsl.exe's stdout diagnostic and the restart hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const fake = join(dir, "fake-wsl-no-vm.mjs")
  await writeFile(
    fake,
    `const out = (text) => process.stdout.write(Buffer.from(text, "utf16le"))
const args = process.argv.slice(2)
if (args[0] === "--list") { out("\\r\\n"); process.exit(0) }
if (args[0] === "--import") {
  out("Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED\\r\\n")
  process.exit(255)
}
process.exit(1)
`,
  )
  const provider = createWslProvider(await preparedOptions(dir, { wslCommand: fake }))
  await expect(provider.create(config)).rejects.toThrow(/HCS_E_HYPERV_NOT_INSTALLED[^]*restart Windows/)
  await rm(dir, { recursive: true, force: true })
})

test("create rebuilds a registered distro when the image moved on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir))
  await provider.create(config)

  // Simulate a manifest bump: the recorded marker no longer matches.
  await Bun.write(
    join(dir, "data", config.name, "image.json"),
    JSON.stringify({ url: "u", sha256: "0".repeat(64), bytes: 1 }),
  )
  await provider.create(config)

  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  expect(state.distros).toEqual([wslDistroName(config.name)])
  expect(state.imports).toBe(2)
  await rm(dir, { recursive: true, force: true })
})

test("egress wires the broker bridge, guest config, and CODEV_CONFIG", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (request) => Response.json({ authorization: request.headers.get("authorization") }),
  })
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const seenStubPorts: number[] = []
  const provider = createWslProvider(
    await preparedOptions(dir, {
      resolveEgress: async (opts) => {
        seenStubPorts.push(opts.guestBrokerPort)
        return {
          routes: [
            {
              prefix: "/probe",
              upstream: `http://127.0.0.1:${upstream.port}`,
              headers: { authorization: "Bearer real" },
            },
          ],
          guestConfig: `{"marker":true}`,
        }
      },
    }),
  )
  await provider.create(config)
  const sandbox = await provider.start(config)

  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  expect(state.bootScript).toContain(`mount --bind '/mnt/hostpath' /codev-config`)
  // The stub port handed to resolveEgress (for the guest config) is the one
  // the socat bridge actually listens on, and it is reserved per sandbox
  // rather than shared: the WSL VM loopback is one namespace for all distros.
  const stubPort = Number(state.bootScript.match(/socat TCP-LISTEN:(\d+),bind=127\.0\.0\.1,fork,reuseaddr/)?.[1])
  expect(seenStubPorts).toEqual([stubPort])
  expect(stubPort).toBeGreaterThan(0)
  expect(state.bootScript).not.toContain("TCP-LISTEN:8788,")
  expect(state.codevConfigEnv).toBe("/codev-config/codev.json")
  expect(await Bun.file(join(dir, "data", config.name, "config", "codev.json")).text()).toBe(`{"marker":true}`)

  // The socat line carries the host broker port; the listener must be live and
  // must swap the placeholder credential for the route's real one.
  const brokerPort = Number(state.bootScript.match(/TCP:\$HOST_IP:(\d+)/)?.[1])
  const proxied = await fetch(`http://127.0.0.1:${brokerPort}/probe/x`, {
    headers: { authorization: "Bearer sandbox-broker" },
  })
  expect(await proxied.json()).toEqual({ authorization: "Bearer real" })

  sandbox.stop()
  await provider.destroy(config)
  upstream.stop(true)
  await rm(dir, { recursive: true, force: true })
})

test("configures automount at import and runs the server unprivileged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir))
  await provider.create(config)
  const imported = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  // Windows has no uid to match, so the guest's own codev user owns the
  // automounted drives — otherwise the dropped server cannot write them.
  expect(imported.wslConf).toContain("uid=1000,gid=1000")

  const sandbox = await provider.start(config)
  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  expect(state.bootScript).toContain("setpriv --reuid=codev --regid=codev --init-groups node")
  // Root still does the mounts and the bridge before dropping.
  expect(state.bootScript.indexOf("mount --bind")).toBeLessThan(state.bootScript.indexOf("setpriv"))

  sandbox.stop()
  await provider.destroy(config)
  await rm(dir, { recursive: true, force: true })
})

test("boot confines the server behind the cgroup firewall before socat starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, {
      resolveEgress: async () => ({
        routes: [{ prefix: "/probe", upstream: "http://127.0.0.1:9" }],
        guestConfig: `{}`,
      }),
    }),
  )
  await provider.create(config)
  const sandbox = await provider.start(config)

  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  const script = state.bootScript as string
  // Fail closed: no nft, no sandbox.
  expect(script).toContain("command -v nft >/dev/null 2>&1 ||")
  // The broker hole matches the socat bridge's target port.
  const brokerPort = Number(script.match(/TCP:\$HOST_IP:(\d+)/)?.[1])
  expect(script).toContain(`tcp dport ${brokerPort} accept`)
  // Confinement happens before the bridge exists, and the server inherits it.
  expect(script.indexOf("cgroup.procs")).toBeLessThan(script.indexOf("socat TCP-LISTEN"))
  expect(script.indexOf("cgroup.procs")).toBeLessThan(script.indexOf("setpriv"))

  sandbox.stop()
  await provider.destroy(config)
  await rm(dir, { recursive: true, force: true })
})

// The boot script must not trust the route table: under NAT the default
// gateway is the host, under mirrored networking it is the LAN router — and a
// host firewall can sever either. The probe picks the address that actually
// answers, and when nothing does the guest switches to the host-dialed
// reverse bridge instead of failing.
test("boot probes broker reachability, gateway first under NAT, with the tunnel fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, {
      resolveEgress: async () => ({
        routes: [{ prefix: "/probe", upstream: "http://127.0.0.1:9" }],
        guestConfig: `{}`,
      }),
    }),
  )
  await provider.create(config)
  const sandbox = await provider.start(config)

  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  const script = state.bootScript as string
  expect(script).toContain(`for CANDIDATE in $GATEWAY_IP 127.0.0.1`)
  expect(script).toContain("connect-timeout=2")
  // Neither candidate answering flips the guest into tunnel mode, announced
  // on stdout for the host, and boots the bridge daemon instead of socat.
  expect(script).toContain(`[ -n "$HOST_IP" ] || { echo "codev sandbox: cannot reach the host broker directly`)
  expect(script).toContain(`echo "codev-bridge-mode: $BRIDGE_MODE"`)
  expect(script).toContain("node /tmp/codev-bridge.mjs")
  // The probe runs unconfined — before the firewall moves the shell into the
  // sandbox cgroup — so it needs no allow rule of its own.
  expect(script.indexOf("HOST_IP=$CANDIDATE")).toBeLessThan(script.indexOf("cgroup.procs"))

  sandbox.stop()
  await provider.destroy(config)
  await rm(dir, { recursive: true, force: true })
})

// A guest that announces tunnel mode gets the host half of the reverse
// bridge: the provider must dial the rendezvous port parsed out of the boot
// script — the direction WSL always forwards and Windows does not firewall.
test("a tunnel-mode guest gets the host-dialed reverse bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, {
      resolveEgress: async () => ({
        routes: [{ prefix: "/probe", upstream: "http://127.0.0.1:9" }],
        guestConfig: `{}`,
      }),
    }),
  )
  await provider.create(config)
  const seeded = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  await Bun.write(join(dir, "state.json"), JSON.stringify({ ...seeded, bridgeMode: "tunnel" }))
  const sandbox = await provider.start(config)

  // Concurrent pool dials race the fake's read-modify-write state updates, so
  // at least one recorded dial is the assertion, not the pool size.
  const dialed = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
      if ((state.rendezvousDials ?? 0) >= 1) return true
      await Bun.sleep(50)
    }
    return false
  }
  expect(await dialed()).toBe(true)

  sandbox.stop()
  await provider.destroy(config)
  await rm(dir, { recursive: true, force: true })
})

// Mirrored networking shares the loopback between host and guest, so the host
// is 127.0.0.1 (the NAT gateway address does not exist) and the broker can
// stay off the LAN entirely.
test("mirrored networking prefers the shared loopback and binds the broker to it", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (request) => Response.json({ authorization: request.headers.get("authorization") }),
  })
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, {
      resolveEgress: async () => ({
        routes: [
          {
            prefix: "/probe",
            upstream: `http://127.0.0.1:${upstream.port}`,
            headers: { authorization: "Bearer real" },
          },
        ],
        guestConfig: `{}`,
      }),
    }),
  )
  await provider.create(config)
  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  await Bun.write(join(dir, "state.json"), JSON.stringify({ ...state, networkingMode: "mirrored" }))
  const sandbox = await provider.start(config)

  const started = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  const script = started.bootScript as string
  expect(script).toContain(`for CANDIDATE in 127.0.0.1 $GATEWAY_IP`)
  // The loopback-bound broker still serves the bridge's traffic.
  const brokerPort = Number(script.match(/TCP:\$HOST_IP:(\d+)/)?.[1])
  const proxied = await fetch(`http://127.0.0.1:${brokerPort}/probe/x`, {
    headers: { authorization: "Bearer sandbox-broker" },
  })
  expect(await proxied.json()).toEqual({ authorization: "Bearer real" })

  sandbox.stop()
  await provider.destroy(config)
  upstream.stop(true)
  await rm(dir, { recursive: true, force: true })
})

test("routeless egress still injects the guest config but starts no broker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(
    await preparedOptions(dir, {
      resolveEgress: async () => ({ routes: [], guestConfig: `{"permission":"allow"}` }),
    }),
  )
  await provider.create(config)
  const sandbox = await provider.start(config)

  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  expect(state.bootScript).not.toContain("socat")
  expect(state.bootScript).toContain("/codev-config")
  expect(state.codevConfigEnv).toBe("/codev-config/codev.json")
  expect(await Bun.file(join(dir, "data", config.name, "config", "codev.json")).text()).toBe(`{"permission":"allow"}`)

  sandbox.stop()
  await provider.destroy(config)
  await rm(dir, { recursive: true, force: true })
})

test("start skips missing extra mounts; applyMounts hot-validates and translates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir))
  await provider.create(config)
  const docs = join(dir, "docs")
  await mkdir(docs, { recursive: true })

  const sandbox = await provider.start({ ...config, mounts: [{ path: docs }, { path: join(dir, "missing") }] })
  // A folder deleted since it was added is skipped at start, never fatal.
  expect(sandbox.mounts).toEqual([{ path: docs, guestPath: "/mnt/hostpath" }])

  // The hot path is the validation gate: it throws instead of skipping.
  expect(await provider.applyMounts?.({ ...config, mounts: [{ path: docs }] })).toEqual([
    { path: docs, guestPath: "/mnt/hostpath" },
  ])
  expect(provider.applyMounts?.({ ...config, mounts: [{ path: join(dir, "missing") }] })).rejects.toThrow(
    "folder does not exist",
  )

  sandbox.stop()
  await provider.destroy(config)
  await rm(dir, { recursive: true, force: true })
})

test("create then start reaches an authenticated health check, and destroy unregisters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsl-test-"))
  const provider = createWslProvider(await preparedOptions(dir))
  await provider.create(config)
  const sandbox = await provider.start(config)
  expect(sandbox.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(sandbox.username).toBe("codev")
  sandbox.stop()
  await provider.destroy(config)
  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text())
  expect(state.distros).toEqual([])
  await rm(dir, { recursive: true, force: true })
})
