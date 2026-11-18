import { createServer } from "node:http"
import { rm } from "node:fs/promises"
import { connect } from "node:net"
import { Readable } from "node:stream"

// The broker is the sandbox's only egress path. The guest has no network
// device; a guest-side stub tunnels to this host-side server, which forwards
// exclusively to configured upstreams (default: the LLM gateway). Everything
// else is denied — there is deliberately no full-outbound mode.
export type BrokerRoute = {
  prefix: string
  upstream: string
  // Applied over the forwarded headers. The guest sends a placeholder
  // credential and the broker swaps in the real one, so tokens never enter
  // the guest and rotation stays a host-side concern.
  headers?: Record<string, string>
}

// What a provider needs to grant a sandbox egress: the broker's route table
// plus an optional codev config written where the guest can read it and
// announced via CODEV_CONFIG — typically pointing the model provider at the
// guest-side broker stub (127.0.0.1:8788).
export type SandboxEgress = {
  routes: BrokerRoute[]
  guestConfig?: string
  fetchImpl?: typeof fetch
  // Shared secret the guest must present. Required in practice: the WSL
  // backend can only reach the host over TCP, so without it any local (or
  // LAN-reachable) process could use the broker as an open proxy to the
  // gateway, spending the real token the broker attaches host-side.
  auth?: string
}

// Named egress rules: the admin-editable shape for extra routes beyond the
// LLM gateway — an object of name → upstream URL, e.g.
// { "npm": "https://registry.npmjs.org" }. Each becomes /name on the guest
// broker stub (http://127.0.0.1:8788/npm/...). Deliberately an allowlist of
// named upstreams, never a general proxy. Throws on anything malformed so a
// bad config file fails the sandbox start with a message instead of silently
// granting nothing.
export function parseBrokerRules(input: unknown): BrokerRoute[] {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("sandbox egress rules must be an object of name → upstream URL")
  return Object.entries(input as Record<string, unknown>).map(([name, upstream]) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new Error(
        `invalid sandbox egress rule name: ${JSON.stringify(name)} (use lowercase letters, digits, dashes)`,
      )
    if (name === "llm") throw new Error(`sandbox egress rule name "llm" is reserved for the model gateway`)
    if (typeof upstream !== "string" || !/^https?:\/\//.test(upstream))
      throw new Error(`sandbox egress rule ${JSON.stringify(name)} needs an http(s) upstream URL`)
    return { prefix: `/${name}`, upstream: new URL(upstream).toString() }
  })
}

export function resolveBrokerRoute(routes: BrokerRoute[], requestUrl: string) {
  const url = new URL(requestUrl, "http://sandbox-broker.local")
  const route = routes.find(
    (candidate) => url.pathname === candidate.prefix || url.pathname.startsWith(`${candidate.prefix}/`),
  )
  if (!route) return null
  return {
    route,
    target: `${route.upstream.replace(/\/+$/, "")}${url.pathname.slice(route.prefix.length)}${url.search}`,
  }
}

export function resolveBrokerTarget(routes: BrokerRoute[], requestUrl: string) {
  return resolveBrokerRoute(routes, requestUrl)?.target ?? null
}

const REQUEST_HEADER_DROP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
])

// fetch transparently decompresses, so passing these through would describe a
// body we no longer send.
const RESPONSE_HEADER_DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"])

// Browser-controlled headers a client may not set. A host that forwards with
// Chromium's network stack (the desktop's Electron net.fetch) rejects the
// entire request with net::ERR_INVALID_ARGUMENT if one is present, so they are
// dropped here rather than at one caller.
const REQUEST_HEADER_DROP_PREFIX = ["sec-fetch-", "sec-ch-", "proxy-"]

export function forwardableRequestHeaders(headers: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => {
        if (value === undefined) return false
        const lower = name.toLowerCase()
        return !REQUEST_HEADER_DROP.has(lower) && !REQUEST_HEADER_DROP_PREFIX.some((p) => lower.startsWith(p))
      })
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : (value as string)]),
  )
}

export function forwardableResponseHeaders(headers: Headers) {
  return Object.fromEntries([...headers.entries()].filter(([name]) => !RESPONSE_HEADER_DROP.has(name.toLowerCase())))
}

export function createBrokerServer(options: { routes: BrokerRoute[]; fetchImpl?: typeof fetch; auth?: string }) {
  const fetchImpl = options.fetchImpl ?? fetch
  const server = createServer(async (request, response) => {
    // Checked before the route table is consulted, so an unauthorized caller
    // learns nothing about which upstreams exist.
    if (options.auth && request.headers.authorization !== `Bearer ${options.auth}`) {
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "sandbox egress unauthorized" }))
      return
    }
    const resolved = resolveBrokerRoute(options.routes, request.url ?? "/")
    if (!resolved) {
      response.writeHead(403, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "sandbox egress denied", path: request.url ?? "/" }))
      return
    }
    // node lowercases incoming header names, so overrides must match case to
    // actually replace the guest's placeholder values.
    const overrides = Object.fromEntries(
      Object.entries(resolved.route.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    )
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : (Readable.toWeb(request) as RequestInit["body"])
    const upstream = await fetchImpl(resolved.target, {
      method: request.method,
      headers: { ...forwardableRequestHeaders(request.headers), ...overrides },
      body,
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    if (upstream instanceof Error) {
      response.writeHead(502, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "sandbox egress upstream failed", message: upstream.message }))
      return
    }
    response.writeHead(upstream.status, forwardableResponseHeaders(upstream.headers))
    if (!upstream.body) {
      response.end()
      return
    }
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response)
  })

  return {
    async listen(host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, host, () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("sandbox broker failed to bind")
      return address.port
    },
    // For bwrap guests the broker listens on a unix socket bind-mounted into
    // the sandbox; unix sockets cross the guest's network namespace.
    async listenUnix(path: string) {
      // A socket file outlives the process that bound it. Node unlinks it on a
      // clean close, so what is left here is the residue of a crash or a force
      // quit — and binding onto it fails EADDRINUSE, which left the sandbox
      // unable to start at all until someone deleted a file out of the temp
      // directory. (The vz helper already unlinks its own; this one is bound
      // here.) Only remove it when nothing answers: a socket with a listener
      // behind it belongs to another instance of this sandbox, and failing
      // loudly is the right outcome there.
      if (await socketIsStale(path)) await rm(path, { force: true })
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(path, () => resolve())
      })
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function socketIsStale(path: string) {
  return new Promise<boolean>((resolve) => {
    const probe = connect(path)
    const settle = (stale: boolean) => {
      probe.destroy()
      resolve(stale)
    }
    probe.once("connect", () => settle(false))
    // Refused (nothing listening) or absent — either way binding is safe.
    probe.once("error", () => settle(true))
  })
}
