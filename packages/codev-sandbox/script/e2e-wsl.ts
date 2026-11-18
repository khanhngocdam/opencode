#!/usr/bin/env bun
// Boots a real sandbox end-to-end on Windows: serves a locally built rootfs
// tarball over loopback HTTP, creates the distribution (download -> verify ->
// wsl --import), starts the guest server, and waits for the codev server's
// authenticated health check over WSL2's localhost forwarding. Dev utility.
//
// Run from packages/codev-sandbox on the Windows machine:
//   bun script/e2e-wsl.ts --image dist-images\bwrap-x64.tar.gz ^
//     --bundle ..\opencode\dist\node [--project dir] [--hold] [--keep]
//
// --hold keeps the distribution running so you can poke at it; --keep skips the
// unregister so it survives the run (clean up with `wsl --unregister codev-e2e`).
//
// --egress serves a local broker upstream and probes the egress firewall from
// inside the running guest: the broker path must work from the sandbox's
// cgroup, direct egress from that cgroup must be rejected, and the same
// direct egress from outside the cgroup must still work (proving the rules
// are scoped to the sandbox, not the shared WSL network namespace).
// --egress-control <host> overrides the external endpoint the direct-egress
// probes dial (default: the host serving --image, which is loopback, so pass
// a real external host:443 for a meaningful control on locked-down networks).
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { lookup } from "node:dns/promises"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { checkSandboxHealth } from "../src/boot"
import type { SandboxConfig } from "../src/provider"
import { createWslProvider } from "../src/wsl/provider"

// Both paths cross into the distribution through wslpath, which resolves
// relative paths against the guest's cwd — so they have to be absolute here.
const image = resolve(requireArg("--image"))
const bundle = resolve(requireArg("--bundle"))
const hold = process.argv.includes("--hold")
const keep = process.argv.includes("--keep")
const egress = process.argv.includes("--egress")
// --name lets two instances run concurrently (distinct distros, brokers and
// stub ports) — which is exactly what the shared-VM-loopback regression needs.
const name = argValue("--name") ?? "e2e"

const work = await mkdtemp(join(tmpdir(), "codev-wsl-e2e-"))
const projectDir = argValue("--project") ? resolve(argValue("--project")!) : join(work, "project")
await mkdir(projectDir, { recursive: true })
await writeFile(join(projectDir, "hello.txt"), "hello from the host project\n")

// Digest once, outside resolveImage: a hash object cannot be digested twice, so
// computing it inside the callback breaks the moment the provider asks again.
const payload = Bun.file(image)
const hash = createHash("sha256")
for await (const chunk of payload.stream()) hash.update(chunk)
const sha256 = hash.digest("hex")

const server = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(image)) })
// The marker carries this instance's name so a stub that bridged to another
// sandbox's broker (the shared-loopback collision) shows up as a wrong marker
// rather than a false pass.
const upstream = egress ? Bun.serve({ port: 0, fetch: () => Response.json({ marker: `broker-${name}` }) }) : null

const provider = createWslProvider({
  dataDir: join(work, "data"),
  cacheDir: join(work, "cache"),
  bundleDir: bundle,
  resolveImage: async () => ({
    url: `http://127.0.0.1:${server.port}/${basename(image)}`,
    sha256,
    bytes: payload.size,
  }),
  ...(upstream
    ? {
        resolveEgress: async () => ({
          routes: [{ prefix: "/probe", upstream: `http://127.0.0.1:${upstream.port}` }],
          guestConfig: `{}`,
        }),
      }
    : {}),
  startTimeoutMs: 180_000,
})

const availability = await provider.availability()
console.log("availability:", availability)
if (!availability.supported) {
  console.error(`cannot run here: ${availability.message}`)
  await cleanup()
  process.exit(1)
}
if (availability.warning) console.log(`warning: ${availability.warning}`)

const config: SandboxConfig = { id: `sandbox:${name}`, name, backend: "wsl", projectDir }

console.time("create")
await provider.create(config)
console.timeEnd("create")

console.time("start")
const sandbox = await provider.start(config)
console.timeEnd("start")
console.log(`server: ${sandbox.url} (user ${sandbox.username})`)

const healthy = await checkSandboxHealth(sandbox.url, { username: sandbox.username ?? "", password: sandbox.password })
console.log(`health: ${healthy ? "OK" : "FAILED"}`)

// /global/health never touches the instance store; /path boots it, so this is
// the probe that catches a guest runtime the bundle cannot actually run on
// (e.g. a node:sqlite too old for the bundle's prepared statements).
const pathsOk = await fetch(`${sandbox.url}/path`, {
  headers: {
    authorization: `Basic ${Buffer.from(`${sandbox.username ?? ""}:${sandbox.password}`).toString("base64")}`,
  },
})
  .then((response) => response.ok)
  .catch(() => false)
console.log(`path api: ${pathsOk ? "OK" : "FAILED"}`)

// The firewall confines the boot cgroup, so meaningful probes must run inside
// it (as the agent would) and the scoping control outside it (as a neighbour
// distro would).
let firewallOk = true
if (egress) {
  const distro = `codev-${config.name}`
  const enterCgroup = `echo $$ > /sys/fs/cgroup/net_cls/${distro}/cgroup.procs || exit 9`
  const connectProbe = (host: string, port: number) =>
    `node -e "const s=require('net').connect({host:'${host}',port:${port},timeout:7000});` +
    `s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});` +
    `s.on('timeout',()=>{console.log('TIMEOUT');process.exit(2)});` +
    `s.on('error',(e)=>{console.log('BLOCKED:'+e.code);process.exit(3)})"`

  // The stub port is per sandbox now; read it off the running socat bridge
  // instead of assuming a fixed number.
  const broker = await runGuestScript([
    enterCgroup,
    `STUB_PORT=$(ps -eo args | sed -n 's/.*TCP-LISTEN:\\([0-9]*\\),bind=127.*/\\1/p' | head -1)`,
    `[ -n "$STUB_PORT" ] || { echo BROKER-FAILED:no-stub; exit 4; }`,
    `STUB_PORT=$STUB_PORT setpriv --reuid=codev --regid=codev --init-groups node -e "fetch('http://127.0.0.1:'+process.env.STUB_PORT+'/probe/x').then((r)=>r.text()).then((t)=>console.log('BROKER:'+t)).catch((e)=>{console.log('BROKER-FAILED:'+e.message);process.exit(4)})"`,
  ])
  const brokerOk = broker.includes(`BROKER:{"marker":"broker-${name}"}`)
  console.log(`broker via cgroup: ${brokerOk ? "OK" : `FAILED (${broker.trim()})`}`)

  const control = argValue("--egress-control") ?? `${await hostAddress()}:443`
  const [controlHost, controlPort] = control.split(":")
  const inside = await runGuestScript([enterCgroup, connectProbe(controlHost!, Number(controlPort ?? 443))])
  const insideBlocked = inside.includes("BLOCKED:")
  console.log(
    `direct egress inside cgroup: ${insideBlocked ? `blocked OK (${inside.trim()})` : `NOT BLOCKED (${inside.trim()})`}`,
  )

  const outside = await runGuestScript([connectProbe(controlHost!, Number(controlPort ?? 443))])
  const outsideOk = outside.includes("CONNECTED")
  console.log(`direct egress outside cgroup: ${outsideOk ? "OK" : `FAILED (${outside.trim()})`}`)

  firewallOk = brokerOk && insideBlocked && outsideOk
  console.log(`firewall: ${firewallOk ? "OK" : "FAILED"}`)
}

if (hold) {
  console.log("holding the distribution up; Ctrl-C to stop")
  await new Promise(() => {})
}

const exited = new Promise<void>((resolve) => sandbox.onExit(() => resolve()))
sandbox.stop()
await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
if (keep) console.log(`keeping the distribution; remove it with: wsl --unregister codev-${config.name}`)
if (!keep) await provider.destroy(config)
await cleanup()
if (!healthy || !pathsOk || !firewallOk) process.exit(1)
console.log("e2e OK")
process.exit(0)

async function cleanup() {
  server.stop(true)
  upstream?.stop(true)
  await rm(work, { recursive: true, force: true })
}

// Runs a root shell script inside the distro over stdin — the same channel the
// provider boots through, and for the same reason: wsl.exe corrupts quoted
// spaces in argv.
function runGuestScript(lines: string[]) {
  return new Promise<string>((done) => {
    const child = spawn("wsl.exe", ["-d", `codev-${config.name}`, "-u", "root", "--", "/bin/sh"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk))
    child.once("close", () => done(Buffer.concat(output).toString("utf8")))
    child.stdin.end(`${lines.join("\n")}\n`)
  })
}

// Default direct-egress control endpoint: the host that served the image is
// the one address guaranteed reachable from this network.
async function hostAddress() {
  const url = new URL(argValue("--image-host") ?? "https://netmind.viettel.vn")
  return (await lookup(url.hostname)).address
}

function argValue(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function requireArg(flag: string) {
  const value = argValue(flag)
  if (!value) {
    console.error(`${flag} is required`)
    process.exit(1)
  }
  return value
}
