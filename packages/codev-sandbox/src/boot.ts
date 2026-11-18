import { randomUUID } from "node:crypto"

export type SandboxCredentials = {
  username: string
  password: string
}

export function generateSandboxCredentials(): SandboxCredentials {
  return { username: "codev", password: randomUUID() }
}

// Mirrors the WSL sidecar env contract (packages/desktop/src/main/wsl/sidecar.ts)
// so the same server bundle boots identically in every backend. The guest
// launcher (image/guest/server-launch.mjs) reads the hostname/port from here
// and calls Server.listen — the bundle is a library, not a CLI.
export function sandboxBootEnv(
  credentials: SandboxCredentials,
  guestHome: string,
  server: { hostname: string; port: number },
): Record<string, string> {
  return {
    CODEV_SERVER_USERNAME: credentials.username,
    CODEV_SERVER_PASSWORD: credentials.password,
    CODEV_SERVER_HOSTNAME: server.hostname,
    CODEV_SERVER_PORT: String(server.port),
    CODEV_CLIENT: "desktop",
    CODEV_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    XDG_STATE_HOME: `${guestHome}/.local/state`,
    // One database for the sandbox, whatever the host is doing. A dev build
    // takes its channel from `git branch --show-current` (packages/script),
    // and the server files its database as `opencode-<channel>.db` for any
    // channel that is not a release one — so the guest, which runs the host's
    // bundle, quietly switched to a different database every time the host
    // repo changed branch, and every session in the sandbox vanished from the
    // UI. Nothing was lost, but nothing could be reached either. The guest is
    // its own machine and has no business tracking the host's branch.
    //
    // Packaged builds already resolve to the same `opencode.db` (their channel
    // is a release one), so this only changes what a dev build does. It also
    // means one guest database shared across branches: a branch that adds a
    // migration migrates it for the others, which is the trade upstream avoids
    // on the host and which is worth making here.
    CODEV_DISABLE_CHANNEL_DB: "1",
    // Commit to the disk, not to the guest's page cache. Stopping a sandbox
    // cuts the VM's power (Virtualization.framework's stop is documented as
    // pulling the cable, and the guest gets no chance to sync), so the
    // server's default WAL + synchronous=NORMAL — durable across a crashed
    // process, not across a lost machine — dropped every session created in
    // the last seconds before a stop, a restart to apply a mount, or a force
    // quit. Measured: a file written in the guest and left unsynced is gone
    // after a plain Stop/Start.
    CODEV_SQLITE_SYNCHRONOUS: "FULL",
  }
}

// Absolute guest path of the launcher baked into every image.
export const SANDBOX_GUEST_LAUNCHER = "/opt/codev-guest/server-launch.mjs"

// A probe must not be able to outlive its usefulness. pollSandboxHealth awaits
// each attempt in turn, so one request that opens and then never answers stalls
// every later attempt forever — the sandbox never comes up, and the start
// timeout is the only thing left to end it. That happens in practice: the
// forwarder accepts the TCP connection and dials through to the guest while its
// server is still binding the port, and the connection can be left hanging
// rather than refused. A healthy guest answers in single-digit milliseconds, so
// a short deadline costs a live probe nothing and turns a permanent hang into
// one skipped attempt.
const HEALTH_REQUEST_TIMEOUT_MS = 2_000

export async function checkSandboxHealth(
  url: string,
  credentials: SandboxCredentials,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)
  const response = await fetchImpl(`${url}/global/health`, {
    headers: { authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}` },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  }).catch(() => null)
  return !!response?.ok
}

export async function pollSandboxHealth(check: () => Promise<boolean>, signal: AbortSignal, interval = 100) {
  while (!signal.aborted) {
    if (await check()) return
    await abortableDelay(interval, signal)
  }
}

function abortableDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timeout = setTimeout(done, duration)
    signal.addEventListener("abort", done, { once: true })
  })
}
