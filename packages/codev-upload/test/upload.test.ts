import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveCodevConfig, type AuthData } from "@codev/gateway"
import { agentLogsDir } from "../src/paths"
import { fileSha256, isRefreshableError, listMarkdownLogs, runUpload } from "../src/upload"

let tempDir: string
let originalTestHome: string | undefined
let originalXdgData: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-upload-net-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  originalXdgData = process.env.XDG_DATA_HOME
  process.env.CODEV_TEST_HOME = tempDir
  process.env.XDG_DATA_HOME = join(tempDir, "share")
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  else process.env.CODEV_TEST_HOME = originalTestHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  rmSync(tempDir, { recursive: true, force: true })
})

const AUTH: AuthData = {
  access_token: "sso-token",
  id_token: "id",
  expires_at: Date.now() + 3_600_000,
  user: { sub: "u1", email: "u@test", displayName: "U" },
}

function seedExportedFile(name: string, content: string): string {
  const dir = join(agentLogsDir(), "proj", "codev-code")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, content)
  return realpathSync(path)
}

interface Call {
  url: string
  method: string
  body?: string
  headers: Record<string, string>
}

// Records every request and answers by URL substring. The conversations
// endpoint returns `rows`; presign/confirm/put succeed; /config serves fresh
// backend coordinates.
function mockFetch(state: {
  calls: Call[]
  rows: object[]
  exchangeStatus?: number
  exchangeStatusOnce?: number
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    state.calls.push({ url, method: init?.method ?? "GET", body: init?.body?.toString(), headers })
    if (url.includes("/supabase/exchange")) {
      const status = state.exchangeStatusOnce ?? state.exchangeStatus ?? 200
      state.exchangeStatusOnce = undefined
      if (status !== 200) return new Response(JSON.stringify({ error: "denied" }), { status })
      return Response.json({ access_token: "sb-token", user: { id: "u1", email: "u@test" } })
    }
    if (url.includes("/codev-backend/config")) {
      return Response.json({
        supabaseUrl: "https://sb.test",
        supabaseAnonKey: "anon-key",
        gatewayUrl: "https://gw.test",
      })
    }
    if (url.includes("/rest/v1/conversations")) {
      return Response.json(state.rows)
    }
    if (url.includes("/functions/v1/presign-upload")) {
      return Response.json({ uploadUrl: "https://sb.test/storage/put1", conversationId: "c1", storagePath: "s1" })
    }
    if (url.includes("/storage/put1")) {
      return new Response("", { status: 200 })
    }
    if (url.includes("/functions/v1/confirm-upload")) {
      return new Response("{}", { status: 200 })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
}

describe("runUpload", () => {
  test("uploads a new file via presign → put → confirm", async () => {
    saveCodevConfig({ supabaseUrl: "https://sb.test", supabaseAnonKey: "anon", gatewayUrl: "https://gw.test" })
    seedExportedFile("a.md", "# hello\n")
    const state = { calls: [] as Call[], rows: [] as object[] }

    const summary = await runUpload({ getAuth: async () => AUTH, fetchImpl: mockFetch(state) })
    expect(summary).toMatchObject({ found: 1, uploaded: 1, skipped: 0, failed: 0 })

    const urls = state.calls.map((c) => c.url)
    expect(urls.some((u) => u.includes("/supabase/exchange"))).toBe(true)
    expect(urls.some((u) => u.includes("/rest/v1/conversations"))).toBe(true)
    const put = state.calls.find((c) => c.url.includes("/storage/put1"))
    expect(put?.headers["content-encoding"]).toBe("gzip")
    const confirm = state.calls.find((c) => c.url.includes("/functions/v1/confirm-upload"))
    const body = JSON.parse(confirm?.body ?? "{}")
    expect(body.localContentHash).toHaveLength(64)
    expect(body.previousVersionId).toBe("")
  })

  test("skips unchanged files, supersedes changed ones via previousVersionId", async () => {
    saveCodevConfig({ supabaseUrl: "https://sb.test", supabaseAnonKey: "anon", gatewayUrl: "https://gw.test" })
    const unchanged = seedExportedFile("same.md", "# same\n")
    const changed = seedExportedFile("changed.md", "# new content\n")
    const state = {
      calls: [] as Call[],
      rows: [
        { id: "row-same", local_file_path: unchanged, local_content_hash: fileSha256(unchanged), uploaded_at: "t" },
        { id: "row-old", local_file_path: changed, local_content_hash: "stale-hash", uploaded_at: "t" },
      ],
    }

    const summary = await runUpload({ getAuth: async () => AUTH, fetchImpl: mockFetch(state) })
    expect(summary).toMatchObject({ found: 2, uploaded: 1, skipped: 1, failed: 0 })
    const confirm = state.calls.find((c) => c.url.includes("/functions/v1/confirm-upload"))
    expect(JSON.parse(confirm?.body ?? "{}").previousVersionId).toBe("row-old")
  })

  test("--force re-uploads unchanged files, still superseding", async () => {
    saveCodevConfig({ supabaseUrl: "https://sb.test", supabaseAnonKey: "anon", gatewayUrl: "https://gw.test" })
    const path = seedExportedFile("same.md", "# same\n")
    const state = {
      calls: [] as Call[],
      rows: [{ id: "row-1", local_file_path: path, local_content_hash: fileSha256(path), uploaded_at: "t" }],
    }

    const summary = await runUpload({ getAuth: async () => AUTH, force: true, fetchImpl: mockFetch(state) })
    expect(summary).toMatchObject({ found: 1, uploaded: 1, skipped: 0 })
    const confirm = state.calls.find((c) => c.url.includes("/functions/v1/confirm-upload"))
    expect(JSON.parse(confirm?.body ?? "{}").previousVersionId).toBe("row-1")
  })

  test("missing cached config refreshes from the backend and retries once", async () => {
    // No saveCodevConfig — the first attempt throws the Missing supabase_
    // shape, the refresh fetches /config, and the retry succeeds.
    seedExportedFile("a.md", "# hello\n")
    const state = { calls: [] as Call[], rows: [] as object[] }

    const summary = await runUpload({ getAuth: async () => AUTH, fetchImpl: mockFetch(state) })
    expect(summary).toMatchObject({ found: 1, uploaded: 1, failed: 0 })
    expect(state.calls.some((c) => c.url.includes("/codev-backend/config"))).toBe(true)
  })

  test("a 403 exchange refreshes config and retries exactly once", async () => {
    saveCodevConfig({ supabaseUrl: "https://sb.test", supabaseAnonKey: "anon", gatewayUrl: "https://gw.test" })
    seedExportedFile("a.md", "# hello\n")
    const state = { calls: [] as Call[], rows: [] as object[], exchangeStatusOnce: 403 }

    const summary = await runUpload({ getAuth: async () => AUTH, fetchImpl: mockFetch(state) })
    expect(summary).toMatchObject({ uploaded: 1, failed: 0 })
    expect(state.calls.filter((c) => c.url.includes("/supabase/exchange"))).toHaveLength(2)
    expect(state.calls.some((c) => c.url.includes("/codev-backend/config"))).toBe(true)
  })

  test("a persistent 500 is not retried", async () => {
    saveCodevConfig({ supabaseUrl: "https://sb.test", supabaseAnonKey: "anon", gatewayUrl: "https://gw.test" })
    seedExportedFile("a.md", "# hello\n")
    const state = { calls: [] as Call[], rows: [] as object[], exchangeStatus: 500 }

    await expect(runUpload({ getAuth: async () => AUTH, fetchImpl: mockFetch(state) })).rejects.toThrow("failed (500)")
    expect(state.calls.filter((c) => c.url.includes("/supabase/exchange"))).toHaveLength(1)
  })

  test("returns the store location when nothing was exported", async () => {
    const summary = await runUpload({ getAuth: async () => AUTH, fetchImpl: mockFetch({ calls: [], rows: [] }) })
    expect(summary.found).toBe(0)
    expect(summary.dbPath).toContain("opencode.db")
  })
})

describe("isRefreshableError", () => {
  test("matches missing config and 401/403, nothing else", () => {
    expect(isRefreshableError(new Error("Missing supabase_url/supabase_anon_key in the CoDev auth file"))).toBe(true)
    expect(isRefreshableError(new Error("Backend /supabase/exchange failed (401): x"))).toBe(true)
    expect(isRefreshableError(new Error("conversations API failed (403): x"))).toBe(true)
    expect(isRefreshableError(new Error("presign-upload failed (500): x"))).toBe(false)
    expect(isRefreshableError(new Error("fetch failed"))).toBe(false)
    expect(isRefreshableError(new Error("body mentions (403) but not the shape"))).toBe(false)
  })
})

describe("listMarkdownLogs", () => {
  test("walks every project folder but only the codev-code agent dir", () => {
    const mine = seedExportedFile("a.md", "x")
    const otherDir = join(agentLogsDir(), "proj", "claude-code")
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, "b.md"), "y")
    writeFileSync(join(agentLogsDir(), "proj", "statistics.json"), "{}")
    const files = listMarkdownLogs(agentLogsDir())
    expect(files.map((f) => realpathSync(f))).toEqual([mine])
  })
})
