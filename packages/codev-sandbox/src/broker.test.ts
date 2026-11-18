import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createBrokerServer, forwardableRequestHeaders, parseBrokerRules, resolveBrokerTarget } from "./broker"

const routes = [{ prefix: "/llm", upstream: "https://gateway.test/api/" }]

test("resolves allowed prefixes onto the upstream and denies everything else", () => {
  expect(resolveBrokerTarget(routes, "/llm/v1/messages?beta=true")).toBe(
    "https://gateway.test/api/v1/messages?beta=true",
  )
  expect(resolveBrokerTarget(routes, "/llm")).toBe("https://gateway.test/api")
  expect(resolveBrokerTarget(routes, "/llmx/v1")).toBe(null)
  expect(resolveBrokerTarget(routes, "/")).toBe(null)
  expect(resolveBrokerTarget(routes, "/etc/passwd")).toBe(null)
})

test("strips hop-by-hop, host, and browser-controlled headers before forwarding", () => {
  expect(
    forwardableRequestHeaders({
      host: "127.0.0.1:9999",
      connection: "keep-alive",
      "content-length": "42",
      authorization: "Bearer token",
      "x-api-key": "key",
      accept: undefined,
      // Chromium refuses to send a request carrying these, so a host that
      // forwards through Electron's net stack fails outright on them.
      "sec-fetch-mode": "cors",
      "Sec-Fetch-Site": "cross-site",
      "sec-ch-ua": '"Chromium";v="1"',
    }),
  ).toEqual({ authorization: "Bearer token", "x-api-key": "key" })
})

test("proxies allowed requests end-to-end and rejects the rest", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      return Response.json({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      })
    },
  })
  const broker = createBrokerServer({
    routes: [{ prefix: "/llm", upstream: `http://127.0.0.1:${upstream.port}/v1` }],
  })
  const port = await broker.listen()

  const proxied = await fetch(`http://127.0.0.1:${port}/llm/messages?stream=false`, {
    method: "POST",
    headers: { authorization: "Bearer inside-sandbox", "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi" }),
  })
  expect(proxied.status).toBe(200)
  expect(await proxied.json()).toEqual({
    method: "POST",
    path: "/v1/messages?stream=false",
    authorization: "Bearer inside-sandbox",
    body: JSON.stringify({ prompt: "hi" }),
  })

  const denied = await fetch(`http://127.0.0.1:${port}/anything-else`)
  expect(denied.status).toBe(403)
  expect(await denied.json()).toEqual({ error: "sandbox egress denied", path: "/anything-else" })

  await broker.close()
  upstream.stop(true)
})

test("serves the same routes over a unix socket for netns-isolated guests", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
  })
  const broker = createBrokerServer({
    routes: [{ prefix: "/llm", upstream: `http://127.0.0.1:${upstream.port}/v1` }],
  })
  const socketPath = join(await mkdtemp(join(tmpdir(), "codev-broker-")), "broker.sock")
  await broker.listenUnix(socketPath)

  const proxied = await fetch("http://sandbox-broker.local/llm/models", { unix: socketPath })
  expect(proxied.status).toBe(200)
  expect(await proxied.json()).toEqual({ path: "/v1/models" })

  const denied = await fetch("http://sandbox-broker.local/direct", { unix: socketPath })
  expect(denied.status).toBe(403)

  await broker.close()
  upstream.stop(true)
  await rm(dirname(socketPath), { recursive: true, force: true })
})

test("parses named egress rules and rejects malformed ones", () => {
  expect(parseBrokerRules({ npm: "https://registry.npmjs.org", pypi: "http://mirror.corp/simple" })).toEqual([
    { prefix: "/npm", upstream: "https://registry.npmjs.org/" },
    { prefix: "/pypi", upstream: "http://mirror.corp/simple" },
  ])
  expect(parseBrokerRules({})).toEqual([])
  expect(() => parseBrokerRules(["npm"])).toThrow("object of name")
  expect(() => parseBrokerRules({ "Bad Name": "https://x.test" })).toThrow("invalid sandbox egress rule name")
  expect(() => parseBrokerRules({ llm: "https://x.test" })).toThrow("reserved")
  expect(() => parseBrokerRules({ npm: "ftp://x.test" })).toThrow("http(s) upstream")
  expect(() => parseBrokerRules({ npm: 5 })).toThrow("http(s) upstream")
})

test("route headers replace the guest's placeholder credential", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (request) =>
      Response.json({
        authorization: request.headers.get("authorization"),
        extra: request.headers.get("x-extra"),
      }),
  })
  const broker = createBrokerServer({
    routes: [
      {
        prefix: "/llm",
        upstream: `http://127.0.0.1:${upstream.port}/v1`,
        // Mixed case on purpose: node lowercases incoming header names, so the
        // override must land case-insensitively to actually replace.
        headers: { Authorization: "Bearer real-token", "x-extra": "host-side" },
      },
    ],
  })
  const port = await broker.listen()

  const proxied = await fetch(`http://127.0.0.1:${port}/llm/messages`, {
    headers: { authorization: "Bearer sandbox-broker" },
  })
  expect(await proxied.json()).toEqual({ authorization: "Bearer real-token", extra: "host-side" })

  await broker.close()
  upstream.stop(true)
})

test("rejects callers without the shared secret", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) })
  const broker = createBrokerServer({
    routes: [{ prefix: "/llm", upstream: `http://127.0.0.1:${upstream.port}/v1` }],
    auth: "secret-token",
  })
  const port = await broker.listen()

  const anonymous = await fetch(`http://127.0.0.1:${port}/llm/models`)
  expect(anonymous.status).toBe(401)
  const wrong = await fetch(`http://127.0.0.1:${port}/llm/models`, { headers: { authorization: "Bearer nope" } })
  expect(wrong.status).toBe(401)
  // An unauthorized caller must not be able to probe which routes exist.
  const denied = await fetch(`http://127.0.0.1:${port}/not-a-route`)
  expect(denied.status).toBe(401)

  const allowed = await fetch(`http://127.0.0.1:${port}/llm/models`, {
    headers: { authorization: "Bearer secret-token" },
  })
  expect(allowed.status).toBe(200)

  await broker.close()
  upstream.stop(true)
})

test("reports upstream failures as 502 instead of hanging", async () => {
  const broker = createBrokerServer({
    routes: [{ prefix: "/llm", upstream: "http://127.0.0.1:1/nowhere" }],
  })
  const port = await broker.listen()
  const response = await fetch(`http://127.0.0.1:${port}/llm/messages`)
  expect(response.status).toBe(502)
  const body = (await response.json()) as { error: string }
  expect(body.error).toBe("sandbox egress upstream failed")
  await broker.close()
})

test("binds over a socket a crash left behind, but not one still in use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-broker-"))
  const path = join(dir, "broker.sock")
  await writeFile(path, "")

  const broker = createBrokerServer({ routes: [] })
  await broker.listenUnix(path)
  await broker.close()

  // A socket with a live listener belongs to another instance: leave it alone
  // and let the bind fail rather than taking the sandbox out from under it.
  const live = createBrokerServer({ routes: [] })
  await live.listenUnix(path)
  const second = createBrokerServer({ routes: [] })
  await expect(second.listenUnix(path)).rejects.toThrow()
  await live.close()
  await rm(dir, { recursive: true, force: true })
})
