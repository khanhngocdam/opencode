import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { httpApi, setHubTransport } from "../src/http"
import { browseHubSkills } from "../src/hub"

let tempDir: string
let savedHome: string | undefined
const savedTransport = httpApi.transport

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-skillhub-transport-"))
  savedHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEV_TEST_HOME
  if (savedHome !== undefined) process.env.CODEV_TEST_HOME = savedHome
  rmSync(tempDir, { recursive: true, force: true })
  setHubTransport(savedTransport)
  mock.restore()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

describe("setHubTransport", () => {
  test("hub requests go through the installed transport", async () => {
    const transport = mock(async (_input: string | URL | Request, _init?: RequestInit) =>
      json({ success: true, data: [], pagination: { total: 0 } }),
    )
    setHubTransport(transport as unknown as typeof fetch)
    await browseHubSkills({ search: "pg" })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(String(transport.mock.calls[0]?.[0])).toContain("/api/v1/hub/skills?search=pg")
  })

  test("the silent SSO refresh behind a request uses the same transport", async () => {
    // An expired access token with a refresh token forces silentSso to call
    // the SSO token endpoint before the hub request.
    mkdirSync(join(tempDir, ".codev"), { recursive: true })
    writeFileSync(
      join(tempDir, ".codev", "auth.json"),
      JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: 1 }),
    )
    const transport = mock(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith("/token")) {
        return json({ access_token: "fresh", id_token: "id", refresh_token: "r2", expires_in: 3600 })
      }
      if (String(input).endsWith("/userinfo")) {
        return json({ sub: "u1", email: "u1@example.com" })
      }
      return json({ success: true, data: [], pagination: { total: 0 } })
    })
    setHubTransport(transport as unknown as typeof fetch)
    await browseHubSkills()
    const urls = transport.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.endsWith("/token"))).toBe(true)
    const hub = transport.mock.calls.find((call) => String(call[0]).includes("/api/v1/hub/skills"))
    const headers = (hub?.[1] as RequestInit | undefined)?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer fresh")
  })
})
