import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let tempDir: string
let originalTestHome: string | undefined

// CODEV_TEST_HOME rather than HOME: Bun's homedir() ignores runtime HOME
// changes, so overriding HOME here would silently hit the real ~/.codev.
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-gateway-auth-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(tempDir, { recursive: true, force: true })
})

describe("auth-file", () => {
  test("blocks merge without clobbering each other", async () => {
    const { saveApiKey, saveCodevConfig, loadApiKey, authFilePath } = await import("../src/auth-file")
    saveApiKey({ apiKey: "sk-1", baseUrl: "https://gw.test", model: "m" })
    saveCodevConfig({ supabaseUrl: "https://sb.test", supabaseAnonKey: "anon", gatewayUrl: "https://gw.test" })

    expect(loadApiKey()).toEqual({ apiKey: "sk-1", baseUrl: "https://gw.test", model: "m" })
    const raw = JSON.parse(readFileSync(authFilePath(), "utf-8"))
    expect(raw.api_key).toBe("sk-1")
    expect(raw.gateway_url).toBe("https://gw.test")
  })

  test("round-trips the provider pair and clears it on a save without one", async () => {
    const { saveApiKey, loadApiKey, authFilePath } = await import("../src/auth-file")
    saveApiKey({ apiKey: "sk-1", providerId: "acme-ai-gateway", providerName: "Acme AI Gateway" })
    expect(loadApiKey()).toEqual({
      apiKey: "sk-1",
      providerId: "acme-ai-gateway",
      providerName: "Acme AI Gateway",
    })

    // A provider-less save (a fresh SSO key) must clear the stale manual
    // identity, or the hub would misattribute the new key.
    saveApiKey({ apiKey: "sk-2" })
    expect(loadApiKey()).toEqual({ apiKey: "sk-2" })
    const raw = JSON.parse(readFileSync(authFilePath(), "utf-8"))
    expect(raw).not.toHaveProperty("provider_id")
    expect(raw).not.toHaveProperty("provider_name")
  })

  test("preserves unknown fields like the hub's skillhub_cookie", async () => {
    const { saveApiKey, authFilePath } = await import("../src/auth-file")
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(tempDir, ".codev"), { recursive: true })
    writeFileSync(authFilePath(), JSON.stringify({ skillhub_cookie: "skill-hub-session=abc" }))

    saveApiKey({ apiKey: "sk-2" })
    const raw = JSON.parse(readFileSync(authFilePath(), "utf-8"))
    expect(raw.skillhub_cookie).toBe("skill-hub-session=abc")
    expect(raw.api_key).toBe("sk-2")
  })

  test("loadSkillhubCookie reads the hub cookie and survives our own saves", async () => {
    const { loadSkillhubCookie, saveApiKey, authFilePath } = await import("../src/auth-file")
    const { mkdirSync, writeFileSync } = await import("node:fs")
    expect(loadSkillhubCookie()).toBeNull()

    mkdirSync(join(tempDir, ".codev"), { recursive: true })
    writeFileSync(authFilePath(), JSON.stringify({ skillhub_cookie: "skill-hub-session=abc" }))
    expect(loadSkillhubCookie()).toBe("skill-hub-session=abc")

    saveApiKey({ apiKey: "sk-1" })
    expect(loadSkillhubCookie()).toBe("skill-hub-session=abc")
  })

  test.skipIf(process.platform === "win32")("writes the file 0600", async () => {
    const { saveApiKey, authFilePath } = await import("../src/auth-file")
    saveApiKey({ apiKey: "sk-3" })
    expect(statSync(authFilePath()).mode & 0o777).toBe(0o600)
  })

  test("prefers ~/.codev-hub only when its auth.json exists", async () => {
    const { authFilePath, forceLoginPath } = await import("../src/auth-file")
    const { mkdirSync, writeFileSync } = await import("node:fs")
    expect(authFilePath()).toBe(join(tempDir, ".codev", "auth.json"))

    // A bare ~/.codev-hub dir (created by unrelated hub code) is not a session.
    mkdirSync(join(tempDir, ".codev-hub"), { recursive: true })
    expect(authFilePath()).toBe(join(tempDir, ".codev", "auth.json"))
    expect(forceLoginPath()).toBe(join(tempDir, ".codev", "force-login"))

    writeFileSync(join(tempDir, ".codev-hub", "auth.json"), "{}")
    expect(authFilePath()).toBe(join(tempDir, ".codev-hub", "auth.json"))
    expect(forceLoginPath()).toBe(join(tempDir, ".codev-hub", "force-login"))
  })

  test("reads a hub session and writes back into the hub file", async () => {
    const { loadAuth, saveApiKey } = await import("../src/auth-file")
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(tempDir, ".codev-hub"), { recursive: true })
    writeFileSync(
      join(tempDir, ".codev-hub", "auth.json"),
      JSON.stringify({
        access_token: "hub-at",
        id_token: "hub-it",
        expires_at: Date.now() + 60_000,
        user: { sub: "s", email: "hub@x", displayName: "Hub" },
        skillhub_cookie: "skill-hub-session=abc",
      }),
    )

    expect(loadAuth()?.user.email).toBe("hub@x")

    saveApiKey({ apiKey: "sk-hub" })
    const raw = JSON.parse(readFileSync(join(tempDir, ".codev-hub", "auth.json"), "utf-8"))
    expect(raw.api_key).toBe("sk-hub")
    expect(raw.access_token).toBe("hub-at")
    expect(raw.skillhub_cookie).toBe("skill-hub-session=abc")
    expect(existsSync(join(tempDir, ".codev", "auth.json"))).toBe(false)
  })

  test("loadAccount shows only sessions that are live or revivable", async () => {
    const { loadAccount, saveAuth } = await import("../src/auth-file")
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const account = { email: "e@x", displayName: "Erin Xu" }
    const user = { sub: "s", email: "e@x", displayName: "Erin Xu" }
    expect(loadAccount()).toBeNull()

    // Unexpired access token, no refresh token: live.
    saveAuth({ access_token: "at", id_token: "it", expires_at: Date.now() + 60_000, user })
    expect(loadAccount()).toEqual(account)

    // Expired access token with a refresh token: revivable by silentSso.
    saveAuth({ access_token: "at", id_token: "it", refresh_token: "rt", expires_at: Date.now() - 1000, user })
    expect(loadAccount()).toEqual(account)

    // Dead-dead: expired access token and nothing to refresh with.
    saveAuth({ access_token: "at", id_token: "it", expires_at: Date.now() - 1000, user })
    expect(loadAccount()).toBeNull()

    // A user block with no tokens at all is a logged-out file.
    mkdirSync(join(tempDir, ".codev"), { recursive: true })
    const { authFilePath } = await import("../src/auth-file")
    writeFileSync(authFilePath(), JSON.stringify({ user }))
    expect(loadAccount()).toBeNull()
  })

  test("clearSsoSession drops the SSO block, keeps the rest, returns the tokens", async () => {
    const { clearSsoSession, loadApiKey, saveApiKey, saveAuth, authFilePath } = await import("../src/auth-file")
    saveAuth({
      access_token: "at",
      id_token: "it",
      refresh_token: "rt",
      expires_at: Date.now() + 60_000,
      user: { sub: "s", email: "e@x", displayName: "E" },
    })
    saveApiKey({ apiKey: "sk-1", model: "m" })

    expect(clearSsoSession()).toEqual({ accessToken: "at", refreshToken: "rt" })
    expect(loadApiKey()).toEqual({ apiKey: "sk-1", model: "m" })
    const raw = JSON.parse(readFileSync(authFilePath(), "utf-8"))
    expect(raw).not.toHaveProperty("access_token")
    expect(raw).not.toHaveProperty("refresh_token")
    expect(raw).not.toHaveProperty("user")
  })

  test("clearSsoSession deletes an SSO-only file and no-ops without tokens", async () => {
    const { clearSsoSession, saveAuth, authFilePath } = await import("../src/auth-file")
    const { existsSync } = await import("node:fs")
    expect(clearSsoSession()).toBeNull()

    saveAuth({
      access_token: "at",
      id_token: "it",
      expires_at: Date.now() + 60_000,
      user: { sub: "s", email: "e@x", displayName: "E" },
    })
    expect(clearSsoSession()).toEqual({ accessToken: "at", refreshToken: undefined })
    expect(existsSync(authFilePath())).toBe(false)
    expect(clearSsoSession()).toBeNull()
  })

  test("clearSkillhubCookie drops only the cookie", async () => {
    const { clearSkillhubCookie, saveApiKey, authFilePath } = await import("../src/auth-file")
    expect(clearSkillhubCookie()).toBe(false)

    saveApiKey({ apiKey: "sk-1" })
    const { writeFileSync } = await import("node:fs")
    writeFileSync(authFilePath(), JSON.stringify({ api_key: "sk-1", skillhub_cookie: "skill-hub-session=abc" }))
    expect(clearSkillhubCookie()).toBe(true)
    const raw = JSON.parse(readFileSync(authFilePath(), "utf-8"))
    expect(raw.api_key).toBe("sk-1")
    expect(raw).not.toHaveProperty("skillhub_cookie")
  })

  test("markForceLogin writes the sentinel next to the auth file", async () => {
    const { markForceLogin, forceLoginPath } = await import("../src/auth-file")
    const { existsSync } = await import("node:fs")
    markForceLogin()
    expect(existsSync(forceLoginPath())).toBe(true)
  })

  test("loadAuth rejects expired or partial sessions", async () => {
    const { loadAuth, saveAuth } = await import("../src/auth-file")
    expect(loadAuth()).toBeNull()
    saveAuth({
      access_token: "at",
      id_token: "it",
      expires_at: Date.now() - 1000,
      user: { sub: "s", email: "e@x", displayName: "E" },
    })
    expect(loadAuth()).toBeNull()
    saveAuth({
      access_token: "at",
      id_token: "it",
      expires_at: Date.now() + 60_000,
      user: { sub: "s", email: "e@x", displayName: "E" },
    })
    expect(loadAuth()?.user.email).toBe("e@x")
  })
})
