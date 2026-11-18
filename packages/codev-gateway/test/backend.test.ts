import { afterAll, describe, expect, test } from "bun:test"
import { BackendError, fetchApiKey, fetchModels, fetchModelWindows, isKeyRefusal, validateApiKey } from "../src/backend"

// A real loopback server (not a mock) that records the path + auth header of the
// last request, so tests assert the exact endpoint fetchModels/validateApiKey
// build from a user-pasted base URL. Each test installs its own handler.
let handler: (req: Request, url: URL) => Response = () => new Response("unset", { status: 500 })
const seen: { path: string; auth: string | null }[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    seen.push({ path: url.pathname, auth: req.headers.get("authorization") })
    return handler(req, url)
  },
})
const base = `http://127.0.0.1:${server.port}`

afterAll(() => server.stop(true))

describe("fetchApiKey", () => {
  // fetchApiKey targets the baked-in BACKEND_URL, so these go through the
  // fetchImpl seam rather than the loopback server.
  const respond = (res: Response) => ({ fetchImpl: (async () => res) as unknown as typeof fetch })

  test("returns the api_key on a 2xx", async () => {
    expect(await fetchApiKey("t", respond(Response.json({ api_key: "sk-1" })))).toBe("sk-1")
  })

  test("a 403 key_refused becomes a BackendError carrying the code and reason", async () => {
    const reason = "The gateway declined to issue a key for u@os.example.com: Only @example.com emails are supported"
    const err = await fetchApiKey("t", respond(Response.json({ error: reason, code: "key_refused" }, { status: 403 })))
      .then(() => undefined)
      .catch((e: unknown) => e)
    if (!(err instanceof BackendError)) throw new Error("expected a BackendError")
    expect(err.status).toBe(403)
    expect(err.code).toBe("key_refused")
    expect(err.reason).toBe(reason)
    expect(err.message).toBe(`Backend /auth/exchange failed (403): ${reason}`)
    expect(isKeyRefusal(err)).toBe(true)
  })

  test("a plain 502 is a BackendError but not a refusal", async () => {
    const err = await fetchApiKey("t", respond(Response.json({ error: "upstream" }, { status: 502 })))
      .then(() => undefined)
      .catch((e: unknown) => e)
    if (!(err instanceof BackendError)) throw new Error("expected a BackendError")
    expect(err.code).toBeUndefined()
    expect(isKeyRefusal(err)).toBe(false)
    expect(isKeyRefusal(new Error("x"))).toBe(false)
  })
})

describe("fetchModels", () => {
  test("returns the model ids from an OpenAI-shaped /v1/models response", async () => {
    handler = () => Response.json({ data: [{ id: "a" }, { id: "b" }] })
    seen.length = 0
    const ids = await fetchModels("sk-test", base)
    expect(ids).toEqual(["a", "b"])
    // Hits <base>/v1/models with a bearer token; base carried no /v1 suffix.
    expect(seen.at(-1)).toEqual({ path: "/v1/models", auth: "Bearer sk-test" })
  })

  test("does not double the /v1 segment when the base already has one", async () => {
    handler = () => Response.json({ data: [{ id: "a" }] })
    seen.length = 0
    await fetchModels("k", `${base}/v1`)
    expect(seen.at(-1)?.path).toBe("/v1/models")
  })

  test("drops empty and non-string ids", async () => {
    handler = () => Response.json({ data: [{ id: "a" }, { id: "" }, {}, { id: "b" }] })
    const ids = await fetchModels("k", base)
    expect(ids).toEqual(["a", "b"])
  })

  test("throws on a non-2xx response, surfacing the backend error", async () => {
    handler = () => Response.json({ error: "bad key" }, { status: 401 })
    await expect(fetchModels("k", base)).rejects.toThrow(/401.*bad key/)
  })

  test("throws when the gateway returns no models", async () => {
    handler = () => Response.json({ data: [] })
    await expect(fetchModels("k", base)).rejects.toThrow(/no models/)
  })
})

describe("fetchModelWindows", () => {
  test("reads windows from /model_group/info at the gateway root", async () => {
    handler = () =>
      Response.json({
        data: [
          { model_group: "big", max_input_tokens: 1000000, max_output_tokens: 65536 },
          { model_group: "small", max_input_tokens: 200000 },
        ],
      })
    seen.length = 0
    const windows = await fetchModelWindows("sk-test", `${base}/v1`)
    expect(windows).toEqual({ big: { context: 1000000, output: 65536 }, small: { context: 200000 } })
    // The endpoint lives at the root — the /v1 the base carried is stripped.
    expect(seen.at(-1)).toEqual({ path: "/model_group/info", auth: "Bearer sk-test" })
  })

  // LiteLLM's max_input_tokens is nullable and unset until an admin fills it
  // in — those entries carry no information and must not shadow the table.
  test("skips entries without a positive max_input_tokens", async () => {
    handler = () =>
      Response.json({
        data: [{ model_group: "a", max_input_tokens: null }, { model_group: "b" }, { max_input_tokens: 5 }],
      })
    expect(await fetchModelWindows("k", base)).toEqual({})
  })

  // A window is an optimization over a sane default: a gateway build without
  // the endpoint (404) or an unreachable one must not fail the configure flow.
  test("returns {} instead of throwing on errors", async () => {
    handler = () => new Response("nope", { status: 404 })
    expect(await fetchModelWindows("k", base)).toEqual({})
    expect(await fetchModelWindows("k", "http://127.0.0.1:9")).toEqual({})
  })
})

describe("validateApiKey", () => {
  test("returns true on a 2xx from /key/info at the gateway root", async () => {
    handler = () => Response.json({ ok: true })
    seen.length = 0
    expect(await validateApiKey("sk-test", base)).toBe(true)
    // /key/info lives at the root, so a trailing /v1 is stripped before joining.
    expect(seen.at(-1)).toEqual({ path: "/key/info", auth: "Bearer sk-test" })
  })

  test("strips a trailing /v1 before appending /key/info", async () => {
    handler = () => Response.json({ ok: true })
    seen.length = 0
    await validateApiKey("k", `${base}/v1`)
    expect(seen.at(-1)?.path).toBe("/key/info")
  })

  test("returns false on 401/403 (invalid or revoked key)", async () => {
    handler = () => new Response("nope", { status: 401 })
    expect(await validateApiKey("k", base)).toBe(false)
    handler = () => new Response("nope", { status: 403 })
    expect(await validateApiKey("k", base)).toBe(false)
  })

  test("throws on other errors so callers can distinguish unreachable from bad key", async () => {
    handler = () => new Response("boom", { status: 500 })
    await expect(validateApiKey("k", base)).rejects.toThrow(/500/)
  })
})
