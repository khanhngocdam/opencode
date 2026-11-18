import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSessionStatsFromServer, type ServerSource } from "../src/server-source"

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

// Fixture guest: one root work session with a subagent child, guest-side
// directories the host has never heard of.
const SESSIONS = [
  { id: "ws1", directory: "/mnt/proj", title: "Fix in sandbox", time: { created: T0, updated: T0 + 60_000 } },
  { id: "ws1-child", parentID: "ws1", directory: "/mnt/proj", title: "", time: { created: T0, updated: T0 } },
]

const MESSAGES: Record<string, object[]> = {
  ws1: [
    {
      info: { role: "user", time: { created: T0 } },
      parts: [{ type: "text", text: "run the tests" }],
    },
    {
      info: {
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        providerID: "aigw",
        agent: "build",
        cost: 0.5,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 0 } },
        time: { created: T0 + 30_000, completed: T0 + 40_000 },
      },
      parts: [
        { type: "text", text: "done" },
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "bun test" }, output: "1 pass" },
        },
      ],
    },
  ],
  "ws1-child": [
    { info: { role: "assistant", modelID: "m", tokens: { input: 5, output: 1 } }, parts: [{ type: "text", text: "12345" }] },
    // A message without info is dropped rather than failing the session.
    { parts: [{ type: "text", text: "orphan" }] },
  ],
}

function mockFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    calls.push(url.pathname + url.search)
    if (url.pathname === "/experimental/session") {
      return Response.json(SESSIONS)
    }
    const message = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (message) {
      return Response.json(MESSAGES[decodeURIComponent(message[1])] ?? [])
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

describe("readSessionStatsFromServer", () => {
  test("builds one sandbox-origin record per top-level session, rolling subagents in", async () => {
    const calls: string[] = []
    const stats = await readSessionStatsFromServer(source("/tmp/host-proj"), mockFetch(calls), () => false)
    expect(stats).toHaveLength(1)
    const record = stats[0]
    expect(record.session_id).toBe("ws1")
    expect(record.origin).toBe("sandbox")
    // Named after the HOST project dir, never the guest's /mnt path.
    expect(record.project).toBe("tmp-host-proj")
    expect(record.user_turns).toBe(1)
    expect(record.subagents).toBe(1)
    expect(record.agents).toEqual({ build: 1 })
    expect(record.started_at).toBe("2026-08-01T10:00:00.000Z")
    expect(record.active_ms).toBe(10_000)
    // Parent and subagent usage both count toward the totals.
    expect(record.totals.turns).toBe(2)
    expect(record.totals.tokens.input).toBe(105)
    expect(record.totals.tokens.cache_read).toBe(10)
    expect(record.totals.cost).toBe(0.5)
    expect(record.totals.tools).toEqual({ bash: { ok: 1, error: 0 } })
    // Requests include archived sessions and route messages by the session's
    // own (guest) directory.
    expect(calls[0]).toContain("archived=true")
    expect(calls.some((c) => c.includes("/session/ws1/message") && c.includes("directory=%2Fmnt%2Fproj"))).toBe(true)
  })

  test("an unreachable sandbox rejects, for the caller to log and skip", async () => {
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as typeof fetch
    await expect(readSessionStatsFromServer(source("/tmp/p"), failing, () => false)).rejects.toThrow("ECONNREFUSED")
  })
})
