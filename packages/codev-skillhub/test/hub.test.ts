import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { SKILLHUB_URL } from "../src/const"
import { httpApi } from "../src/http"
import { browseHubSkills, getSkillDetail } from "../src/hub"

let tempDir: string
let savedHome: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-skillhub-hub-"))
  savedHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEV_TEST_HOME
  if (savedHome !== undefined) process.env.CODEV_TEST_HOME = savedHome
  rmSync(tempDir, { recursive: true, force: true })
  mock.restore()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

type FetchSpy = ReturnType<typeof stubFetch>

function stubFetch(response: Response) {
  return spyOn(httpApi, "fetch").mockResolvedValue(response)
}

function lastUrl(spy: FetchSpy): string {
  const call = spy.mock.calls.at(-1)
  if (!call) throw new Error("httpApi.fetch was not called")
  return String(call[1])
}

function lastHeaders(spy: FetchSpy): Record<string, string> {
  const call = spy.mock.calls.at(-1)
  if (!call) throw new Error("httpApi.fetch was not called")
  return ((call[2] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>
}

const CARD = {
  id: "id-1",
  name: "pg-tuner",
  provider: "acme",
  description: "Tunes Postgres",
  version: "1.2.0",
  publishedAt: "2026-08-01T00:00:00Z",
  downloadCount: 42,
  stars: 4.5,
  totalRatings: 8,
  targetRole: "BACKEND",
  author: { name: "Ann", avatar: null, username: "ann" },
  metadata: { tags: ["db"], domain: "developer", publisher: "acme" },
  runtimes: [{ name: "Python", color: "#3776ab" }],
}

describe("browseHubSkills", () => {
  test("serializes every param and maps the full card", async () => {
    const spy = stubFetch(
      jsonResponse(200, {
        success: true,
        data: [CARD],
        pagination: { page: 2, limit: 24, total: 60, totalPages: 3 },
      }),
    )
    const result = await browseHubSkills({
      search: "pg tuner",
      page: 2,
      limit: 24,
      sort: "downloads",
      domain: "developer",
    })
    expect(lastUrl(spy)).toBe(
      `${SKILLHUB_URL}/api/v1/hub/skills?search=pg+tuner&page=2&limit=24&sort=downloads&domain=developer`,
    )
    expect(result.pagination).toEqual({ page: 2, limit: 24, total: 60, totalPages: 3 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: "id-1",
      name: "pg-tuner",
      stars: 4.5,
      downloadCount: 42,
      author: { username: "ann" },
      runtimes: [{ name: "Python", color: "#3776ab" }],
    })
  })

  test("turns the hub's nulls into absent fields so a strict consumer never sees them", async () => {
    // The hub sends unset columns as null; the server's response schema types
    // these as optional strings and would refuse the whole page over one.
    stubFetch(
      jsonResponse(200, {
        success: true,
        data: [
          {
            id: "id-1",
            name: "prism-noc",
            targetRole: null,
            author: { name: null, username: "ann", avatar: null },
            metadata: { tags: ["a", 7, null], category: null, domain: "developer", publisher: null },
            runtimes: [{ name: "Python", color: null }, { name: null }, "junk"],
          },
        ],
        pagination: { page: 1, limit: 12, total: 1, totalPages: 1 },
      }),
    )
    const card = (await browseHubSkills()).items[0]
    expect(card?.targetRole).toBeUndefined()
    expect(card?.author).toEqual({ name: undefined, username: "ann", avatar: null })
    expect(card?.metadata).toEqual({ tags: ["a"], category: undefined, domain: "developer", publisher: undefined })
    expect(card?.runtimes).toEqual([{ name: "Python", color: undefined }])
  })

  test("no params hits the bare endpoint and coerces missing fields", async () => {
    const spy = stubFetch(
      jsonResponse(200, {
        success: true,
        data: [{ id: "x", name: "n", provider: "p", description: "", version: "1" }],
      }),
    )
    const result = await browseHubSkills()
    expect(lastUrl(spy)).toBe(`${SKILLHUB_URL}/api/v1/hub/skills`)
    expect(result.items[0]).toMatchObject({ downloadCount: 0, stars: 0, totalRatings: 0, publishedAt: null })
    expect(result.pagination.page).toBe(1)
  })

  test("anonymous browse sends no credential header", async () => {
    const spy = stubFetch(jsonResponse(200, { success: true, data: [] }))
    await browseHubSkills({ search: "x" })
    const headers = lastHeaders(spy)
    expect(headers.Cookie).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
  })

  test("a stored session rides along as Bearer", async () => {
    const dir = join(tempDir, ".codev")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        access_token: "at",
        id_token: "it",
        expires_at: Date.now() + 3_600_000,
        user: { sub: "s", email: "e@x", displayName: "E" },
      }),
    )
    const spy = stubFetch(jsonResponse(200, { success: true, data: [] }))
    await browseHubSkills()
    expect(lastHeaders(spy).Authorization).toBe("Bearer at")
  })

  test("non-2xx and malformed bodies throw", async () => {
    stubFetch(jsonResponse(500, { success: false }))
    expect(browseHubSkills()).rejects.toThrow("Skill search failed (500).")
    mock.restore()
    stubFetch(new Response("not json", { status: 200 }))
    expect(browseHubSkills()).rejects.toThrow("SkillHub returned an unexpected response.")
  })
})

describe("getSkillDetail", () => {
  test("maps card fields plus detail extras and inlined files", async () => {
    const spy = stubFetch(
      jsonResponse(200, {
        success: true,
        data: {
          ...CARD,
          slug: "pg-tuner",
          displayName: "PG Tuner",
          summary: "short",
          changelog: "v1.2",
          files: [
            { id: "f1", filePath: "SKILL.md", content: "# PG Tuner" },
            { id: "f2", filePath: "scripts/run.sh" },
          ],
        },
      }),
    )
    const detail = await getSkillDetail("pg-tuner")
    expect(lastUrl(spy)).toBe(`${SKILLHUB_URL}/api/v1/skills/pg-tuner`)
    expect(detail.displayName).toBe("PG Tuner")
    expect(detail.files).toEqual([
      { filePath: "SKILL.md", content: "# PG Tuner" },
      { filePath: "scripts/run.sh", content: "" },
    ])
    expect(detail.stars).toBe(4.5)
  })

  test("encodes the target and reports 404 clearly", async () => {
    const spy = stubFetch(jsonResponse(404, { success: false }))
    expect(getSkillDetail("weird name")).rejects.toThrow('Skill "weird name" not found or not public.')
    expect(lastUrl(spy)).toBe(`${SKILLHUB_URL}/api/v1/skills/weird%20name`)
  })

  test("missing files array becomes empty, other errors surface", async () => {
    stubFetch(jsonResponse(200, { success: true, data: { id: "x", name: "n" } }))
    const detail = await getSkillDetail("x")
    expect(detail.files).toEqual([])
    mock.restore()
    stubFetch(jsonResponse(503, { success: false }))
    expect(getSkillDetail("x")).rejects.toThrow("Skill lookup failed (503).")
  })
})
