import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readAllSessionStats } from "../src/db"

const directories: string[] = []
// Windows keeps a closed SQLite file locked until its handle is collected.
afterEach(() => {
  Bun.gc(true)
  directories
    .splice(0)
    .forEach((directory) => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
})

// A minimal Codev2 store: the v2 session tables with one parent session and one subagent child.
function store() {
  const directory = mkdtempSync(join(tmpdir(), "codev2-stats-"))
  directories.push(directory)
  const path = join(directory, "opencode.db")
  const db = new Database(path)
  db.run("CREATE TABLE project (id TEXT, worktree TEXT)")
  db.run(
    "CREATE TABLE session_v2 (id TEXT, project_id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER)",
  )
  db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)")
  db.run("INSERT INTO project VALUES ('p1', '/work/codev-app')")
  db.run("INSERT INTO session_v2 VALUES ('ses_parent', 'p1', 'Parent', '/work/codev-app/packages/cli', NULL, 1, 2)")
  db.run("INSERT INTO session_v2 VALUES ('ses_child', 'p1', 'Child', '/work/codev-app', 'ses_parent', 3, 4)")
  const message = (id: string, session: string, type: string, seq: number, data: unknown) =>
    db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)", [id, session, type, seq, JSON.stringify(data)])
  message("m1", "ses_parent", "user", 1, { time: { created: 1_000 }, text: "hello" })
  message("m2", "ses_parent", "assistant", 2, {
    time: { created: 2_000, completed: 5_000 },
    agent: "build",
    model: { id: "glm-5", providerID: "aigw" },
    cost: 0.5,
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [],
  })
  message("m3", "ses_parent", "idle", 3, { time: { created: 6_000 }, outcome: "succeeded" })
  message("m4", "ses_child", "assistant", 1, {
    time: { created: 3_000, completed: 4_000 },
    agent: "explore",
    model: { id: "glm-5", providerID: "aigw" },
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [],
  })
  db.close()
  return path
}

test("a Codev2 store reports its top-level sessions from the v2 tables", () => {
  const stats = readAllSessionStats(store(), () => false)
  expect(stats.map((item) => item.session_id)).toEqual(["ses_parent"])
  const [session] = stats
  expect(session!.project).toContain("codev-app")
  expect(session!.user_turns).toBe(1)
  expect(session!.subagents).toBe(1)
  expect(JSON.stringify(session)).toContain("glm-5")
})
