#!/usr/bin/env bun
// Boots a real sandbox VM end-to-end on macOS: serves a locally built vz
// image over loopback HTTP, creates the sandbox (download → verify → unpack →
// disk clone), starts it through codev-vmm, and waits for the codev server's
// authenticated health check through the vsock bridge. Dev utility.
//
// Usage:
//   bun script/e2e-vz.ts --image dist-images/vz-arm64.tar.gz \
//     --bundle ../opencode/dist/node [--project dir] [--hold]
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkSandboxHealth } from "../src/boot"
import type { SandboxConfig } from "../src/provider"
import { createVzProvider } from "../src/vz/provider"

const image = requireArg("--image")
const bundle = requireArg("--bundle")
const hold = process.argv.includes("--hold")

const work = await mkdtemp(join(tmpdir(), "codev-vz-e2e-"))
const projectDir = argValue("--project") ?? join(work, "project")
await mkdir(projectDir, { recursive: true })
await writeFile(join(projectDir, "hello.txt"), "hello from the host project\n")
// A second host folder mounted on top of the project dir, to prove the
// mounts.json path: the guest must see it at /mnt/extra.
const extraDir = join(work, "extra")
await mkdir(extraDir, { recursive: true })
await writeFile(join(extraDir, "marker.txt"), "extra-mount-ok\n")

const payload = Bun.file(image)
const hash = createHash("sha256")
for await (const chunk of payload.stream()) hash.update(chunk)
const server = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/broker-selftest" ? new Response("broker-ok") : new Response(Bun.file(image)),
})

const provider = createVzProvider({
  dataDir: join(work, "data"),
  cacheDir: join(work, "cache"),
  bundleDir: bundle,
  helperPath: fileURLToPath(new URL("../native/vzhelper/dist/codev-vmm", import.meta.url)),
  resolveImage: async () => ({
    url: `http://127.0.0.1:${server.port}/${image.split("/").pop()}`,
    sha256: hash.digest("hex"),
    bytes: payload.size,
  }),
  // The image server doubles as the broker upstream: guest 127.0.0.1:8788 →
  // vsock → host broker → this Bun.serve.
  resolveEgress: async () => ({
    routes: [{ prefix: "/probe", upstream: `http://127.0.0.1:${server.port}` }],
  }),
  startTimeoutMs: 180_000,
})

console.log("availability:", await provider.availability())
const config: SandboxConfig = {
  id: "sandbox:e2e",
  name: "e2e",
  backend: "vz",
  projectDir,
  mounts: [{ path: extraDir }],
}

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

// Egress: have the guest itself pull from the broker (curl over the guest's
// loopback stub) and drop the response into the shared workspace, then read
// it host-side — proves the whole guest→vsock→broker→upstream chain.
const auth = `Basic ${Buffer.from(`${sandbox.username ?? ""}:${sandbox.password}`).toString("base64")}`
await fetch(`${sandbox.url}/api/pty`, {
  method: "POST",
  headers: { authorization: auth, "content-type": "application/json" },
  body: JSON.stringify({
    command: "/bin/sh",
    args: [
      "-c",
      "curl -s --max-time 15 http://127.0.0.1:8788/probe/broker-selftest > /workspace/broker-probe.txt 2>&1",
    ],
    cwd: "/workspace",
  }),
}).catch(() => null)
const brokerOk = await (async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const text = await Bun.file(join(projectDir, "broker-probe.txt"))
      .text()
      .catch(() => "")
    if (text.trim() === "broker-ok") return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
})()
console.log(`broker: ${brokerOk ? "OK" : "FAILED"}`)

// Extra mount: the guest reads the marker from /mnt/extra (mounted by
// codev-init from mounts.json) and writes proof both into the workspace and
// back into the extra mount itself, exercising read and write.
console.log(`guest mounts: ${JSON.stringify(sandbox.mounts)}`)
await fetch(`${sandbox.url}/api/pty`, {
  method: "POST",
  headers: { authorization: auth, "content-type": "application/json" },
  body: JSON.stringify({
    command: "/bin/sh",
    args: [
      "-c",
      "cat /mnt/extra/marker.txt > /workspace/mount-probe.txt 2>&1; echo written-from-guest > /mnt/extra/guest-write.txt 2>/dev/null",
    ],
    cwd: "/workspace",
  }),
}).catch(() => null)
const mountOk = await (async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const read = await Bun.file(join(projectDir, "mount-probe.txt"))
      .text()
      .catch(() => "")
    const written = await Bun.file(join(extraDir, "guest-write.txt"))
      .text()
      .catch(() => "")
    if (read.trim() === "extra-mount-ok" && written.trim() === "written-from-guest") return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
})()
console.log(`extra mount: ${mountOk ? "OK" : "FAILED"}`)

if (hold) {
  console.log("holding the VM up; Ctrl-C to stop")
  await new Promise(() => {})
}

const exited = new Promise<void>((resolve) => sandbox.onExit(() => resolve()))
sandbox.stop()
await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
await provider.destroy(config)
server.stop(true)
await rm(work, { recursive: true, force: true })
if (!healthy || !pathsOk || !brokerOk || !mountOk) process.exit(1)
console.log("e2e OK")
process.exit(0)

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
