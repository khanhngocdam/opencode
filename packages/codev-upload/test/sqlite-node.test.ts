import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSessionDb } from "../src/sqlite.bun"

// The desktop's Electron sidecar runs the reader on the node driver
// (node:sqlite), which Bun does not implement — so the node half of this
// parity check builds the real driver for node and runs it in a spawned
// `node` child against the same fixture the bun half reads in-process.
// Requires a node with node:sqlite (>= 22.5 behind a flag); skips otherwise.

const EXPECTED = JSON.stringify([{ id: "s1" }])

function seedFixture(dir: string): string {
  const path = join(dir, "fixture.db")
  const seed = new Database(path, { create: true })
  seed.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, time_created INTEGER)")
  seed.run("INSERT INTO session VALUES ('s1', 'p1', 1), ('s2', 'p2', 2)")
  seed.close()
  return path
}

describe("sqlite driver parity", () => {
  test("bun driver answers the reader's query shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "codev-upload-sqlite-"))
    const db = openSessionDb(seedFixture(dir))
    expect(
      db.prepare<{ id: string }>("SELECT id FROM session WHERE project_id = ? ORDER BY time_created").all("p1"),
    ).toEqual([{ id: "s1" }])
    expect(
      db
        .prepare<{ name: string }>("PRAGMA table_info(session)")
        .all()
        .map((c) => c.name),
    ).toEqual(["id", "project_id", "time_created"])
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("node driver (the desktop sidecar's) returns the same rows under real node", async () => {
    const node = Bun.which("node")
    if (!node) return // no node on this machine — the bun half still ran
    const dir = mkdtempSync(join(tmpdir(), "codev-upload-sqlite-node-"))
    const fixture = seedFixture(dir)
    const built = join(dir, "sqlite.node.mjs")
    const build = Bun.spawnSync([
      "bun",
      "build",
      join(import.meta.dir, "../src/sqlite.node.ts"),
      "--target=node",
      "--outfile",
      built,
    ])
    expect(build.exitCode).toBe(0)

    const script = `
      import { openSessionDb } from ${JSON.stringify(built)}
      const db = openSessionDb(${JSON.stringify(fixture)})
      const rows = db.prepare("SELECT id FROM session WHERE project_id = ? ORDER BY time_created").all("p1")
      db.close()
      process.stdout.write(JSON.stringify(rows))
    `
    const run = Bun.spawnSync([node, "--experimental-sqlite", "--no-warnings", "--input-type=module", "-e", script])
    const stderr = run.stderr.toString()
    if (run.exitCode !== 0 && stderr.includes("No such built-in module")) return // node too old — skip
    expect(stderr).toBe("")
    expect(run.stdout.toString()).toBe(EXPECTED)
    rmSync(dir, { recursive: true, force: true })
  })
})
