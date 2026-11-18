import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { httpApi } from "../src/http"
import { runStackList } from "../src/stack-search"

let tempDir: string
let savedHome: string | undefined

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const STACK = {
  id: "ns-1",
  slug: "data-eng",
  name: "Data Engineering",
  description: "Everything a data team needs",
  owner: { username: "ann", firstName: "Ann", lastName: "Lee", avatarUrl: null },
  memberCount: 4,
  skillCount: 9,
  updatedAt: "2026-08-01T00:00:00.000Z",
  skills: [],
}

function stubList(items: unknown[] = [STACK]) {
  return spyOn(httpApi, "fetch").mockResolvedValue(
    jsonResponse(200, {
      success: true,
      data: items,
      pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
      stats: { totalStacks: items.length },
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-stack-search-"))
  savedHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
})
afterEach(() => {
  mock.restore()
  if (savedHome === undefined) delete process.env.CODEV_TEST_HOME
  if (savedHome !== undefined) process.env.CODEV_TEST_HOME = savedHome
  rmSync(tempDir, { recursive: true, force: true })
})

describe("runStackList", () => {
  test("prints the slug, because that is what `stack pull` takes", async () => {
    stubList()
    const out = captureLog()
    expect(await runStackList({ json: false })).toBe(0)
    const text = out.join("\n")
    expect(text).toMatch(/Data Engineering by Ann Lee — 9 skill\(s\), 4 member\(s\)/)
    expect(text).toMatch(/slug: data-eng/)
  })

  test("--json prints one machine-readable line", async () => {
    stubList()
    const out = captureLog()
    expect(await runStackList({ json: true })).toBe(0)
    const parsed = JSON.parse(out[0] ?? "{}")
    expect(parsed.ok).toBe(true)
    expect(parsed.total).toBe(1)
    expect(parsed.items[0].slug).toBe("data-eng")
  })

  test("distinguishes an empty search from an empty hub", async () => {
    stubList([])
    const out = captureLog()
    await runStackList({ query: "nope", json: false })
    expect(out.join("\n")).toBe('No stacks match "nope".')
    mock.restore()
    stubList([])
    const out2 = captureLog()
    await runStackList({ json: false })
    expect(out2.join("\n")).toBe("No public stacks yet.")
  })

  test("truncates a long description instead of wrapping the listing", async () => {
    stubList([{ ...STACK, description: "x".repeat(200) }])
    const out = captureLog()
    await runStackList({ json: false })
    expect(out.join("\n")).toMatch(/x{87}\.\.\./)
  })

  test("strips control characters out of hub-supplied text", async () => {
    stubList([{ ...STACK, name: "Data\u0007Eng", slug: "data\u001b[31m-eng" }])
    const out = captureLog()
    await runStackList({ json: false })
    const text = out.join("\n")
    expect(text).toContain("DataEng")
    expect(text).not.toContain("\u0007")
    expect(text).not.toContain("\u001b")
  })

  test("reports a failure on stderr and exits non-zero", async () => {
    spyOn(httpApi, "fetch").mockResolvedValue(jsonResponse(500, {}))
    const errs = captureErr()
    expect(await runStackList({ json: false })).toBe(1)
    expect(errs.join("\n")).toBe("Stack search failed (500).")
  })
})
