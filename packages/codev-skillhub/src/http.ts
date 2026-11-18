import { applySystemCaCertsOnce, isCertError } from "./tls"

// All hub-bound HTTP goes through this seam. On a certificate failure the OS
// trust store is merged into the default CA set once (corporate TLS-intercepting
// proxies re-sign every chain with a root only the OS store has) and the
// request retried. The hub's diagnostic NDJSON logging is deliberately not
// ported — the endpoint label survives only so error messages can name what
// failed.
async function hubFetch(endpoint: string, input: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await httpApi.transport(input, init)
  } catch (err) {
    if (!isCertError(err)) throw err
    const ca = applySystemCaCertsOnce()
    if (ca?.status !== "merged") throw err
    return await httpApi.transport(input, init)
  }
}

// Object indirection so tests can stub HTTP without module mocks (Bun spyOn on
// ESM namespaces is unreliable).
export const httpApi = {
  fetch: hubFetch,
  // The socket-level transport behind every hub request, including the silent
  // SSO refresh that authenticates them. Node's fetch ignores system proxies
  // and PAC files, so a host with a proxy-aware stack swaps its own in (see
  // setHubTransport); the CLI keeps the default.
  transport: fetch as typeof fetch,
}

// Route all hub traffic through `fetchImpl`. The desktop app's Electron main
// process passes Chromium's net.fetch so enterprise proxies, PAC scripts, and
// OS trust roots apply to Skill Hub browsing and installs the same way they
// already do to the gateway SSO calls.
export function setHubTransport(fetchImpl: typeof fetch) {
  httpApi.transport = fetchImpl
}
