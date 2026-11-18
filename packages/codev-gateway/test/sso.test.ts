import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isLoginCancelled, login, logout, parseCallbackParams, probeSession, silentSso } from "../src/sso"
import { authFilePath, forceLoginPath, loadApiKey, saveApiKey, saveAuth } from "../src/auth-file"

describe("parseCallbackParams", () => {
  test("parses a full callback URL", () => {
    const params = parseCallbackParams("http://127.0.0.1:5173/callback?code=abc&state=xyz")
    expect(params?.get("code")).toBe("abc")
    expect(params?.get("state")).toBe("xyz")
  })

  test("parses a scheme-less host/path paste", () => {
    const params = parseCallbackParams("127.0.0.1:5173/callback?code=abc&state=xyz")
    expect(params?.get("code")).toBe("abc")
  })

  test("parses a bare query string with and without the leading ?", () => {
    expect(parseCallbackParams("?code=abc")?.get("code")).toBe("abc")
    expect(parseCallbackParams("code=abc&state=s")?.get("state")).toBe("s")
    expect(parseCallbackParams("error=denied")?.get("error")).toBe("denied")
  })

  test("returns null for a bare authorization code", () => {
    expect(parseCallbackParams("some-opaque-code")).toBeNull()
  })
})

describe("logout", () => {
  let tempDir: string
  let originalTestHome: string | undefined

  // CODEV_TEST_HOME rather than HOME: Bun's homedir() ignores runtime HOME
  // changes, so overriding HOME here would silently hit the real ~/.codev.
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "codev-gateway-sso-"))
    originalTestHome = process.env.CODEV_TEST_HOME
    process.env.CODEV_TEST_HOME = tempDir
  })

  afterEach(() => {
    if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
    if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("clears the session, marks force-login, and revokes both tokens", async () => {
    saveAuth({
      access_token: "at",
      id_token: "it",
      refresh_token: "rt",
      expires_at: Date.now() + 60_000,
      user: { sub: "s", email: "e@x", displayName: "E" },
    })
    saveApiKey({ apiKey: "sk-1" })

    const revoked: URLSearchParams[] = []
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toEndWith("/revoke")
      revoked.push(new URLSearchParams(String(init?.body)))
      return new Response("", { status: 200 })
    }) as typeof fetch

    expect(await logout({ fetchImpl })).toBe(true)
    expect(loadApiKey()).toEqual({ apiKey: "sk-1" })
    expect(existsSync(forceLoginPath())).toBe(true)
    expect(revoked.map((params) => [params.get("token"), params.get("token_type_hint")])).toEqual([
      ["at", "access_token"],
      ["rt", "refresh_token"],
    ])
  })

  test("survives a failing revocation endpoint", async () => {
    saveAuth({
      access_token: "at",
      id_token: "it",
      expires_at: Date.now() + 60_000,
      user: { sub: "s", email: "e@x", displayName: "E" },
    })
    const fetchImpl: typeof fetch = (async (_input: string | URL | Request): Promise<Response> => {
      throw new Error("network down")
    }) as typeof fetch
    expect(await logout({ fetchImpl })).toBe(true)
  })

  test("no-ops without a session", async () => {
    const fetchImpl: typeof fetch = (async (_input: string | URL | Request): Promise<Response> => {
      throw new Error("must not be called")
    }) as typeof fetch
    expect(await logout({ fetchImpl })).toBe(false)
    expect(existsSync(forceLoginPath())).toBe(false)
  })
})

describe("probeSession", () => {
  let tempDir: string
  let originalTestHome: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "codev-gateway-probe-"))
    originalTestHome = process.env.CODEV_TEST_HOME
    process.env.CODEV_TEST_HOME = tempDir
  })

  afterEach(() => {
    if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
    if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
    rmSync(tempDir, { recursive: true, force: true })
  })

  const user = { sub: "s", email: "e@x", displayName: "E" }
  const respond = (fn: () => Promise<Response>): typeof fetch =>
    (async (_input: string | URL | Request) => fn()) as typeof fetch
  const noFetch: typeof fetch = (async (_input: string | URL | Request): Promise<Response> => {
    throw new Error("must not be called")
  }) as typeof fetch

  test("an unexpired access token is live without a network call", async () => {
    saveAuth({ access_token: "at", id_token: "it", expires_at: Date.now() + 60_000, user })
    expect(await probeSession({ fetchImpl: noFetch })).toBe("live")
  })

  test("nothing to refresh with is dead without a network call", async () => {
    expect(await probeSession({ fetchImpl: noFetch })).toBe("dead")
    saveAuth({ access_token: "at", id_token: "it", expires_at: Date.now() - 1000, user })
    expect(await probeSession({ fetchImpl: noFetch })).toBe("dead")
  })

  test("a definite rejection of the refresh token is dead", async () => {
    saveAuth({ access_token: "at", id_token: "it", refresh_token: "rt", expires_at: Date.now() - 1000, user })
    const fetchImpl = respond(async () => new Response("invalid_grant", { status: 400 }))
    expect(await probeSession({ fetchImpl })).toBe("dead")
  })

  test("network failures and server errors prove nothing", async () => {
    saveAuth({ access_token: "at", id_token: "it", refresh_token: "rt", expires_at: Date.now() - 1000, user })
    const down = respond(async () => {
      throw new Error("network down")
    })
    expect(await probeSession({ fetchImpl: down })).toBe("unknown")
    const flaky = respond(async () => new Response("oops", { status: 502 }))
    expect(await probeSession({ fetchImpl: flaky })).toBe("unknown")
  })

  test("a successful refresh is live and persists the rotated tokens", async () => {
    saveAuth({ access_token: "old-at", id_token: "it", refresh_token: "old-rt", expires_at: Date.now() - 1000, user })
    // First call is the token refresh; the userinfo round-trip fails, so the
    // stale user block must survive the rewrite.
    let calls = 0
    const fetchImpl = respond(async () => {
      calls++
      if (calls === 1)
        return Response.json({ access_token: "new-at", id_token: "new-it", refresh_token: "new-rt", expires_in: 3600 })
      throw new Error("userinfo down")
    })
    expect(await probeSession({ fetchImpl })).toBe("live")
    const raw = JSON.parse(readFileSync(authFilePath(), "utf-8"))
    expect(raw.access_token).toBe("new-at")
    expect(raw.refresh_token).toBe("new-rt")
    expect(raw.user).toEqual(user)
    // The persisted session now short-circuits: no further network calls.
    expect(await probeSession({ fetchImpl: noFetch })).toBe("live")
  })
})

describe("login", () => {
  let tempDir: string
  let originalTestHome: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "codev-gateway-login-"))
    originalTestHome = process.env.CODEV_TEST_HOME
    process.env.CODEV_TEST_HOME = tempDir
  })

  afterEach(() => {
    if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
    if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
    rmSync(tempDir, { recursive: true, force: true })
  })

  const user = { sub: "s", email: "e@x", displayName: "E" }
  const noFetch: typeof fetch = (async (_input: string | URL | Request): Promise<Response> => {
    throw new Error("must not be called")
  }) as typeof fetch

  // The first browser window a fresh machine opened used to be the wrapper's
  // /logout, which answers a sign-in that has no live IdP session with its
  // refusal page: the first attempt always failed, and only the dialog's own
  // link (a plain /authorize) ever reached a login form.
  test("a fresh home opens the authorize URL with prompt=login", async () => {
    const abort = new AbortController()
    const opened = await new Promise<string>((resolve) => {
      void login({
        onLog: () => {},
        onReady: (open) => open(),
        openUrl: async (url) => resolve(url),
        fetchImpl: noFetch,
        signal: abort.signal,
      }).catch(() => {})
    })
    abort.abort()
    const url = new URL(opened)
    expect(url.pathname.endsWith("/authorize")).toBe(true)
    expect(url.searchParams.get("prompt")).toBe("login")
    const redirect = new URL(url.searchParams.get("redirect_uri")!)
    expect(redirect.hostname).toBe("127.0.0.1")
    expect(redirect.pathname).toBe("/callback")
  })

  // The interactive flow up to onReady is pure loopback: no IdP round-trip
  // happens until a callback or paste lands, so the abort contract can be
  // exercised against the real login() with the browser launcher stubbed.
  test("abort rejects as a cancellation and closes the loopback server", async () => {
    const abort = new AbortController()
    const ready = new Promise<string>((resolve) => {
      void login({
        onLog: () => {},
        onReady: (open) => open(),
        openUrl: async (url) => resolve(url),
        fetchImpl: noFetch,
        signal: abort.signal,
      }).then(
        () => {
          throw new Error("must not resolve")
        },
        (error) => {
          expect(isLoginCancelled(error)).toBe(true)
        },
      )
    })
    // openUrl receives the loopback authorize URL, whose redirect_uri names
    // the callback port.
    const port = new URL(new URL(await ready).searchParams.get("redirect_uri")!).port
    expect(await loopbackAlive(port)).toBe(true)
    abort.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await loopbackAlive(port)).toBe(false)
    expect(existsSync(authFilePath())).toBe(false)
  })

  // Any local process can reach the loopback port during the sign-in wait,
  // and a request with a Host header that is not a valid URL authority used to
  // throw inside the request listener — an uncaught exception that took the
  // whole process down.
  test("a malformed Host header is answered instead of crashing the process", async () => {
    const abort = new AbortController()
    const ready = new Promise<string>((resolve) => {
      void login({
        onLog: () => {},
        onReady: (open) => open(),
        openUrl: async (url) => resolve(url),
        fetchImpl: noFetch,
        signal: abort.signal,
      }).catch(() => {})
    })
    const port = Number(new URL(new URL(await ready).searchParams.get("redirect_uri")!).port)
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("GET /nope HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n")
      })
      socket.once("data", (data) => {
        resolve(data.toString().split("\r\n")[0])
        socket.destroy()
      })
      socket.once("error", reject)
    })
    expect(status).toBe("HTTP/1.1 404 Not Found")
    // The login is still waiting on the real callback.
    expect(await loopbackAlive(String(port))).toBe(true)
    abort.abort()
  })

  test("an already-aborted signal never opens a server", async () => {
    const abort = new AbortController()
    abort.abort()
    let opened = false
    const error = await login({
      onLog: () => {},
      onReady: () => {
        opened = true
      },
      openUrl: async () => {
        opened = true
      },
      fetchImpl: noFetch,
      signal: abort.signal,
    }).catch((error) => error)
    expect(isLoginCancelled(error)).toBe(true)
    expect(opened).toBe(false)
  })

  test("the silent refresh and its userinfo round-trip use the injected fetch", async () => {
    saveAuth({ access_token: "old-at", id_token: "it", refresh_token: "old-rt", expires_at: Date.now() - 1000, user })
    const urls: string[] = []
    const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      if (urls.length === 1)
        return Response.json({ access_token: "new-at", id_token: "new-it", refresh_token: "new-rt", expires_in: 3600 })
      return Response.json(user)
    }) as typeof fetch
    const auth = await silentSso({ fetchImpl })
    expect(auth?.access_token).toBe("new-at")
    expect(urls.map((url) => new URL(url).pathname.split("/").at(-1))).toEqual(["token", "userinfo"])
    // login() takes the same path before ever opening a browser.
    const again = await login({ onLog: () => {}, onReady: () => {}, openUrl: async () => {}, fetchImpl: noFetch })
    expect(again.access_token).toBe("new-at")
  })
})

async function loopbackAlive(port: string): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/nope`, { signal: AbortSignal.timeout(500) })
    .then(() => true)
    .catch(() => false)
}
