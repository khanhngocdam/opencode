import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { SKILLHUB_URL } from "../src/const"
import { httpApi } from "../src/http"
import { browseStacks, downloadStack, findStack, ownerLabel } from "../src/stack"

let tempDir: string
let savedHome: string | undefined

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function stubFetch(response: Response) {
  return spyOn(httpApi, "fetch").mockResolvedValue(response)
}

function lastUrl(spy: ReturnType<typeof stubFetch>): string {
  const call = spy.mock.calls.at(-1)
  if (!call) throw new Error("httpApi.fetch was not called")
  return String(call[1])
}

const STACK = {
  id: "ns-1",
  slug: "data-eng",
  name: "Data Engineering",
  description: "Everything a data team needs",
  status: "ACTIVE",
  isPublic: true,
  updatedAt: "2026-08-01T00:00:00.000Z",
  owner: { username: "ann", firstName: "Ann", lastName: "Lee", avatarUrl: null },
  memberCount: 4,
  skillCount: 9,
  skills: [{ id: "s1", name: "pg-tuner", description: "d", version: "1.0.0", stars: 4, downloadCount: 12 }],
}

function listBody(items: unknown[] = [STACK], overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: items,
    pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
    stats: { totalStacks: 7 },
    ...overrides,
  }
}

beforeEach(() => {
  // No auth file: every stack endpoint is optionalAuth, so anonymous must work.
  tempDir = mkdtempSync(join(tmpdir(), "codev-stack-"))
  savedHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
})
afterEach(() => {
  mock.restore()
  if (savedHome === undefined) delete process.env.CODEV_TEST_HOME
  if (savedHome !== undefined) process.env.CODEV_TEST_HOME = savedHome
  rmSync(tempDir, { recursive: true, force: true })
})

describe("browseStacks", () => {
  test("hits the public explore endpoint and passes the query through", async () => {
    const spy = stubFetch(jsonResponse(200, listBody()))
    await browseStacks({ search: "data", page: 2, limit: 5 })
    const url = new URL(lastUrl(spy))
    expect(`${url.origin}${url.pathname}`).toBe(`${SKILLHUB_URL}/api/v1/explore/namespaces`)
    expect(url.searchParams.get("search")).toBe("data")
    expect(url.searchParams.get("page")).toBe("2")
    expect(url.searchParams.get("limit")).toBe("5")
  })

  test("works anonymously — no auth header when there is no session", async () => {
    const spy = stubFetch(jsonResponse(200, listBody()))
    await browseStacks()
    const init = spy.mock.calls.at(-1)?.[2] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers.Cookie).toBeUndefined()
  })

  test("maps the card and carries pagination plus the global stack count", async () => {
    stubFetch(jsonResponse(200, listBody()))
    const result = await browseStacks()
    expect(result.items[0]).toMatchObject({
      slug: "data-eng",
      name: "Data Engineering",
      memberCount: 4,
      skillCount: 9,
    })
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 })
    expect(result.totalStacks).toBe(7)
  })

  test("flags the preview as truncated when skillCount exceeds the listed skills", async () => {
    stubFetch(jsonResponse(200, listBody()))
    const result = await browseStacks()
    // The server returns at most six skills per stack whatever skillCount says.
    expect(result.items[0]?.skills).toHaveLength(1)
    expect(result.items[0]?.previewTruncated).toBe(true)
  })

  test("coerces missing and wrong-typed fields rather than trusting the hub", async () => {
    stubFetch(jsonResponse(200, listBody([{ slug: "x", skillCount: "nope", owner: null, skills: "nope" }])))
    const result = await browseStacks()
    expect(result.items[0]).toMatchObject({ id: "", name: "", description: "", skillCount: 0, memberCount: 0 })
    expect(result.items[0]?.skills).toEqual([])
    expect(result.items[0]?.previewTruncated).toBe(false)
  })

  test("rejects a non-OK status and an unexpected body", async () => {
    stubFetch(jsonResponse(500, {}))
    expect(browseStacks()).rejects.toThrow("Stack search failed (500).")
    mock.restore()
    stubFetch(jsonResponse(200, { success: false }))
    expect(browseStacks()).rejects.toThrow("SkillHub returned an unexpected response.")
  })
})

describe("findStack", () => {
  test("returns the exact slug match from the public listing", async () => {
    stubFetch(jsonResponse(200, listBody([{ ...STACK, slug: "data-eng-extra" }, STACK])))
    expect((await findStack("data-eng"))?.name).toBe("Data Engineering")
  })

  test("returns null instead of throwing when the listing has no match", async () => {
    // A private stack the caller is a member of is absent from the public
    // listing but still downloads, so a miss must not abort the pull.
    stubFetch(jsonResponse(200, listBody([])))
    expect(await findStack("private-one")).toBeNull()
  })

  test("returns null when the listing itself fails", async () => {
    stubFetch(jsonResponse(500, {}))
    expect(await findStack("data-eng")).toBeNull()
  })
})

describe("downloadStack", () => {
  test("requests the bulk endpoint with the slug encoded", async () => {
    const spy = stubFetch(new Response(new Uint8Array([1, 2, 3])))
    const buffer = await downloadStack("data eng")
    expect(lastUrl(spy)).toBe(`${SKILLHUB_URL}/api/v1/namespaces/data%20eng/download-all`)
    expect([...buffer]).toEqual([1, 2, 3])
  })

  test("names the private case rather than reporting a bare 403", async () => {
    stubFetch(jsonResponse(403, {}))
    expect(downloadStack("secret")).rejects.toThrow('Stack "secret" is private.')
  })

  test("names the not-found case, including a stack with no public skills", async () => {
    stubFetch(jsonResponse(404, {}))
    expect(downloadStack("ghost")).rejects.toThrow('Stack "ghost" not found, or it has no public skills.')
  })

  test("surfaces any other status", async () => {
    stubFetch(jsonResponse(502, {}))
    expect(downloadStack("data-eng")).rejects.toThrow("Stack download failed (502).")
  })

  test("allows far more time than a JSON handshake", async () => {
    const spy = stubFetch(new Response(new Uint8Array()))
    await downloadStack("data-eng")
    const init = spy.mock.calls.at(-1)?.[2] as RequestInit
    // Not the 15s default skillhubFetch would otherwise apply.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })
})

describe("ownerLabel", () => {
  test("prefers the full name, falls back to the username, then to unknown", () => {
    expect(ownerLabel({ firstName: "Ann", lastName: "Lee", username: "ann" })).toBe("Ann Lee")
    expect(ownerLabel({ username: "ann" })).toBe("ann")
    expect(ownerLabel({ firstName: "Ann" })).toBe("Ann")
    expect(ownerLabel({})).toBe("unknown")
  })
})
