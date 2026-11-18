import { skillhubFetch } from "./skillhub"

// The desktop app's richer view of the hub, kept separate from skillhub.ts so
// the CLI surface stays byte-stable. Shapes mirror what /api/v1/hub/skills and
// /api/v1/skills/<id> actually return (skillhub src/services/hub.service.ts /
// skill.service.ts); fields the server may omit are optional or coerced so the
// types are total.

export interface HubSkillCard {
  id: string
  name: string
  provider: string
  description: string
  version: string
  publishedAt: string | null
  downloadCount: number
  stars: number
  totalRatings: number
  targetRole?: string
  author?: { name?: string; avatar?: string | null; username?: string }
  metadata?: { tags?: string[]; category?: string; domain?: string; publisher?: string }
  runtimes?: { name: string; color?: string }[]
}

export type HubSort = "featured" | "newest" | "downloads" | "rating"
export type HubDomain = "developer" | "personal-assistant" | "workflow-builder"

export interface HubBrowseParams {
  search?: string
  page?: number
  // Server clamps to 1-50 (default 12).
  limit?: number
  sort?: HubSort
  domain?: HubDomain
}

export interface HubBrowseResult {
  items: HubSkillCard[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

// Browse the public hub with the full card shape. Anonymous works — a stored
// session is attached when present, like listHubSkills.
export async function browseHubSkills(params: HubBrowseParams = {}): Promise<HubBrowseResult> {
  const query = new URLSearchParams()
  if (params.search) query.set("search", params.search)
  if (params.page) query.set("page", String(params.page))
  if (params.limit) query.set("limit", String(params.limit))
  if (params.sort) query.set("sort", params.sort)
  if (params.domain) query.set("domain", params.domain)
  const qs = query.toString()

  const res = await skillhubFetch(`/api/v1/hub/skills${qs ? `?${qs}` : ""}`, {
    label: "skillhub.hub-browse",
    optionalAuth: true,
  })
  if (!res.ok) {
    throw new Error(`Skill search failed (${res.status}).`)
  }
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean
    data?: unknown[]
    pagination?: { page?: number; limit?: number; total?: number; totalPages?: number }
  }
  if (!body.success || !body.data) {
    throw new Error("SkillHub returned an unexpected response.")
  }
  const items = body.data.map(toCard)
  return {
    items,
    pagination: {
      page: body.pagination?.page ?? params.page ?? 1,
      limit: body.pagination?.limit ?? params.limit ?? items.length,
      total: body.pagination?.total ?? items.length,
      totalPages: body.pagination?.totalPages ?? 1,
    },
  }
}

export interface HubSkillDetail extends HubSkillCard {
  slug?: string
  displayName?: string
  summary?: string
  changelog?: string
  // SKILL.md (and every other text file) arrives inlined — no second call.
  files: { filePath: string; content: string }[]
}

// Full skill detail by id OR name. Public for PUBLIC skills (optional auth);
// 404 gets the same clear message getSkillMeta uses.
export async function getSkillDetail(idOrName: string): Promise<HubSkillDetail> {
  const res = await skillhubFetch(`/api/v1/skills/${encodeURIComponent(idOrName)}`, {
    label: "skillhub.detail-full",
    optionalAuth: true,
  })
  if (res.status === 404) {
    throw new Error(`Skill "${idOrName}" not found or not public.`)
  }
  if (!res.ok) {
    throw new Error(`Skill lookup failed (${res.status}).`)
  }
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean
    data?: Record<string, unknown> & { id?: string; name?: string }
  }
  if (!body.success || !body.data?.id || !body.data.name) {
    throw new Error("SkillHub returned an unexpected response.")
  }
  const data = body.data
  const files = Array.isArray(data.files)
    ? (data.files as { filePath?: string; content?: string }[])
        .filter((f) => typeof f.filePath === "string")
        .map((f) => ({ filePath: f.filePath as string, content: typeof f.content === "string" ? f.content : "" }))
    : []
  return {
    ...toCard(data),
    slug: asString(data.slug),
    displayName: asString(data.displayName),
    summary: asString(data.summary),
    changelog: asString(data.changelog),
    files,
  }
}

function toCard(raw: unknown): HubSkillCard {
  const data = (raw ?? {}) as Record<string, unknown>
  const metadata = toMetadata(data.metadata)
  const author = toAuthor(data.author)
  const runtimes = toRuntimes(data.runtimes)
  return {
    id: asString(data.id) ?? "",
    name: asString(data.name) ?? "",
    provider: asString(data.provider) ?? "",
    description: asString(data.description) ?? "",
    version: asString(data.version) ?? "",
    publishedAt: asString(data.publishedAt) ?? null,
    downloadCount: asNumber(data.downloadCount),
    stars: asNumber(data.stars),
    totalRatings: asNumber(data.totalRatings),
    targetRole: asString(data.targetRole),
    author,
    metadata,
    runtimes,
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

// The hub stores unset columns as null and sends them as such (`publisher:
// null`, `avatar: null`), while the nested objects are typed with absent
// fields. Nulls become absent here, once, so every consumer — the CLI's
// printer, the server's strict response schema — sees the same total shape.
// Only `avatar` keeps its null: the hub means "no picture" by it.
function toAuthor(raw: unknown): HubSkillCard["author"] {
  if (typeof raw !== "object" || raw === null) return undefined
  const data = raw as Record<string, unknown>
  return {
    name: asString(data.name),
    avatar: asString(data.avatar) ?? null,
    username: asString(data.username),
  }
}

function toMetadata(raw: unknown): HubSkillCard["metadata"] {
  if (typeof raw !== "object" || raw === null) return undefined
  const data = raw as Record<string, unknown>
  return {
    tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    category: asString(data.category),
    domain: asString(data.domain),
    publisher: asString(data.publisher),
  }
}

function toRuntimes(raw: unknown): HubSkillCard["runtimes"] {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const data = item as Record<string, unknown>
    const name = asString(data.name)
    if (name === undefined) return []
    return [{ name, color: asString(data.color) }]
  })
}
