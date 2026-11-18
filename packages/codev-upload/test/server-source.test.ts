import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSessionStatsFromServer, toStatsMessage, type ServerSource } from "../src/server-source"

let tempDir: string
let originalTestHome: string | undefined
let originalXdgData: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-upload-srv-"))
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

const T0 = Date.UTC(2026, 7, 1, 10, 0, 0)

const SESSIONS = [
  { id: "ws1", time: { created: T0, updated: T0 + 60_000 } },
  { id: "ws1-child", parentID: "ws1", time: { created: T0, updated: T0 } },
]

const MESSAGES: Record<string, object[]> = {
  ws1: [
    {
      type: "user",
      text: "run the tests",
      time: { created: T0 },
    },
    {
      type: "assistant",
      agent: "build",
      model: { providerID: "aigw", modelID: "claude-sonnet-4-5" },
      cost: 0.5,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 0 } },
      time: { created: T0 + 30_000, completed: T0 + 40_000 },
      content: [
        { type: "text", text: "done" },
        {
          type: "tool",
          name: "bash",
          state: { status: "completed", input: { command: "bun test" } },
        },
      ],
    },
  ],
  "ws1-child": [
    {
      type: "assistant",
      model: { providerID: "aigw", modelID: "m" },
      tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text: "12345" }],
      time: { created: T0 },
    },
    { type: "idle", time: { created: T0 } },
  ],
}

function mockFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push(url.pathname + url.search)
    if (url.pathname === "/api/session") {
      return Response.json({ data: SESSIONS, cursor: {} })
    }
    const message = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/)
    if (message) {
      return Response.json({ data: MESSAGES[decodeURIComponent(message[1])] ?? [], cursor: {} })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
}

const source = (hostDir: string): ServerSource => ({
  url: "http://127.0.0.1:14100",
  username: "codev",
  password: "secret",
  projectDir: hostDir,
})

describe("toStatsMessage", () => {
  test("maps v2 user and assistant messages", () => {
    expect(toStatsMessage({ type: "user", text: "hi", time: { created: 1 } })).toEqual({
      info: { role: "user", time: { created: 1 } },
      parts: [{ type: "text", text: "hi" }],
    })
    expect(toStatsMessage({ type: "idle" })).toBeUndefined()
  })
})

describe("readSessionStatsFromServer", () => {
  test("builds one sandbox-origin record per top-level session, rolling subagents in", async () => {
    const calls: string[] = []
    const stats = await readSessionStatsFromServer(source("/tmp/host-proj"), mockFetch(calls), () => false)
    expect(stats).toHaveLength(1)
    const record = stats[0]
    expect(record.session_id).toBe("ws1")
    expect(record.origin).toBe("sandbox")
    expect(record.project).toBe("tmp-host-proj")
    expect(record.user_turns).toBe(1)
    expect(record.subagents).toBe(1)
    expect(record.agents).toEqual({ build: 1 })
    expect(record.started_at).toBe("2026-08-01T10:00:00.000Z")
    expect(record.active_ms).toBe(10_000)
    expect(record.totals.turns).toBe(2)
    expect(record.totals.tokens.input).toBe(105)
    expect(record.totals.tokens.cache_read).toBe(10)
    expect(record.totals.cost).toBe(0.5)
    expect(record.totals.tools).toEqual({ bash: { ok: 1, error: 0 } })
    expect(calls[0]).toContain("/api/session?")
    expect(calls.some((c) => c.includes("/api/session/ws1/message"))).toBe(true)
  })

  test("an unreachable sandbox rejects, for the caller to log and skip", async () => {
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as typeof fetch
    await expect(readSessionStatsFromServer(source("/tmp/p"), failing, () => false)).rejects.toThrow("ECONNREFUSED")
  })
})
