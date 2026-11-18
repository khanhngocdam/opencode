import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { httpApi } from "../src/http"
import { runSkillSearch } from "../src/skill-search"
import type { HubSkill } from "../src/skillhub"

let tempDir: string
let savedHome: string | undefined

// runSkillSearch reaches the hub through listHubSkills → skillhubFetch →
// httpApi.fetch, so stubbing the HTTP seam is enough — no module mocks. The
// listing endpoint is optional-auth, so an empty CODEV_TEST_HOME (no auth
// file) exercises the logged-out path with no network.
function mockSearch(items: HubSkill[], total = items.length) {
  return spyOn(httpApi, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: items, pagination: { total } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  )
}

function captureLog() {
  const out: string[] = []
  spyOn(console, "log").mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
  return out
}

function captureErr() {
  const out: string[] = []
  spyOn(console, "error").mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
  return out
}

const SKILL: HubSkill = {
  id: "id-1",
  name: "pg-tuner",
  provider: "viettel",
  description: "Tune Postgres configs",
  version: "1.2.0",
  publishedAt: "2026-06-01",
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-skill-search-"))
  savedHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
})

afterEach(() => {
  mock.restore()
  if (savedHome === undefined) delete process.env.CODEV_TEST_HOME
  else process.env.CODEV_TEST_HOME = savedHome
  rmSync(tempDir, { recursive: true, force: true })
})

describe("runSkillSearch", () => {
  test("passes the query and the default limit to the hub request", async () => {
    const spy = mockSearch([SKILL])
    captureLog()

    const code = await runSkillSearch({ query: "postgres tuning", json: false })

    expect(code).toBe(0)
    expect(spy).toHaveBeenCalledTimes(1)
    const url = new URL(String(spy.mock.calls[0]?.[1]))
    expect(url.searchParams.get("search")).toBe("postgres tuning")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("an explicit limit rides along", async () => {
    const spy = mockSearch([SKILL])
    captureLog()

    await runSkillSearch({ query: "pg", limit: 5, json: false })

    const url = new URL(String(spy.mock.calls[0]?.[1]))
    expect(url.searchParams.get("limit")).toBe("5")
  })

  test("renders a human-readable list", async () => {
    mockSearch([SKILL], 7)
    const out = captureLog()

    await runSkillSearch({ query: "pg", json: false })

    const text = out.join("\n")
    expect(text).toContain("Found 7 skill(s) — showing 1:")
    expect(text).toContain("pg-tuner@1.2.0 by viettel")
    expect(text).toContain("Tune Postgres configs")
    expect(text).toContain("id: id-1")
  })

  test("strips control/ANSI characters from hub fields in the human list", async () => {
    const esc = String.fromCharCode(0x1b)
    const bel = String.fromCharCode(0x07)
    mockSearch([
      {
        ...SKILL,
        name: `pg${esc}[31m-tuner`,
        provider: `vie${bel}ttel`,
        description: `Tune${esc}[2J Postgres`,
      },
    ])
    const out = captureLog()

    await runSkillSearch({ query: "pg", json: false })

    const text = out.join("\n")
    // The escape/control bytes are gone; the surrounding text remains.
    expect(text).not.toContain(esc)
    expect(text).not.toContain(bel)
    expect(text).toContain("pg[31m-tuner@1.2.0 by viettel")
    expect(text).toContain("Tune[2J Postgres")
  })

  test("emits JSON with --json (no human text)", async () => {
    mockSearch([SKILL], 7)
    const out = captureLog()

    const code = await runSkillSearch({ query: "pg", json: true })

    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out[0] as string)
    expect(parsed).toEqual({ ok: true, total: 7, items: [SKILL] })
  })

  test("shows a query-specific message when there are no matches", async () => {
    mockSearch([])
    const out = captureLog()

    await runSkillSearch({ query: "nope", json: false })

    expect(out.join("\n")).toBe('No skills match "nope".')
  })

  test("returns exit code 1 and prints the error when the API fails", async () => {
    spyOn(httpApi, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 500 }))
    const errs = captureErr()

    const code = await runSkillSearch({ query: "pg", json: false })

    expect(code).toBe(1)
    expect(errs.join("\n")).toContain("Skill search failed (500).")
  })
})
