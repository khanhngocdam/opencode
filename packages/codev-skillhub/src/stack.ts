import { skillhubFetch } from "./skillhub"

// Skill Stacks are the hub's public namespaces: a curated set of skills that
// installs as one unit. Shapes mirror what /api/v1/explore/namespaces and
// /api/v1/namespaces/<slug>/download-all actually return (skillhub
// src/services/namespace.service.ts#explorePublicNamespaces / #downloadAllSkills);
// neither endpoint is schema'd in the hub's openapi.json, so every field is
// coerced and the types are total.

// A stack ZIP is every public skill in the namespace at once — up to
// STACK_LIMITS, five times one skill's cap — so it needs far more headroom than
// the JSON handshakes skillhub.ts caps at 15s.
const STACK_DOWNLOAD_TIMEOUT_MS = 300_000

export interface StackSkillPreview {
  id: string
  name: string
  description: string
  version: string
  stars: number
  downloadCount: number
}

export interface StackCard {
  id: string
  slug: string
  name: string
  description: string
  owner: { username?: string; firstName?: string; lastName?: string; avatarUrl?: string | null }
  memberCount: number
  // Every PUBLIC skill in the namespace — which is more than `skills` holds.
  skillCount: number
  updatedAt: string | null
  // The listing returns at most six skills per stack whatever skillCount says
  // (`take: 6` server-side), so this is a preview, not the contents.
  skills: StackSkillPreview[]
  previewTruncated: boolean
}

export interface StackBrowseParams {
  search?: string
  page?: number
  // Server clamps to 1-50 (default 20).
  limit?: number
}

export interface StackBrowseResult {
  items: StackCard[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
  // Public stacks on the hub overall, ignoring the search filter.
  totalStacks: number
}

// Browse the public stacks. Anonymous works — the listing is public — and a
// stored session rides along when present, like browseHubSkills.
export async function browseStacks(params: StackBrowseParams = {}): Promise<StackBrowseResult> {
  const query = new URLSearchParams()
  if (params.search) query.set("search", params.search)
  if (params.page) query.set("page", String(params.page))
  if (params.limit) query.set("limit", String(params.limit))
  const qs = query.toString()

  const res = await skillhubFetch(`/api/v1/explore/namespaces${qs ? `?${qs}` : ""}`, {
    label: "skillhub.stack-browse",
    optionalAuth: true,
  })
  if (!res.ok) {
    throw new Error(`Stack search failed (${res.status}).`)
  }
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean
    data?: unknown[]
    pagination?: { page?: number; limit?: number; total?: number; totalPages?: number }
    stats?: { totalStacks?: number }
  }
  if (!body.success || !body.data) {
    throw new Error("SkillHub returned an unexpected response.")
  }
  const items = body.data.map(toStack)
  return {
    items,
    pagination: {
      page: body.pagination?.page ?? params.page ?? 1,
      limit: body.pagination?.limit ?? params.limit ?? items.length,
      total: body.pagination?.total ?? items.length,
      totalPages: body.pagination?.totalPages ?? 1,
    },
    totalStacks: asNumber(body.stats?.totalStacks),
  }
}

// Resolve one stack by slug so a pull can name it before downloading. There is
// no public per-slug endpoint — GET /api/v1/namespaces/<slug> requires
// membership — so this searches the public listing instead. Returns null rather
// than throwing when nothing matches: a private stack the caller is a member of
// is absent from the listing but still downloads, so a miss must not abort.
export async function findStack(slug: string): Promise<StackCard | null> {
  const result = await browseStacks({ search: slug, limit: 50 }).catch(() => null)
  return result?.items.find((stack) => stack.slug === slug) ?? null
}

// Download a stack's composite ZIP. Public when the namespace is public;
// otherwise the server allows members, owners, and site admins, which the
// stored session covers when there is one.
export async function downloadStack(slug: string): Promise<Buffer> {
  const res = await skillhubFetch(`/api/v1/namespaces/${encodeURIComponent(slug)}/download-all`, {
    label: "skillhub.stack-download",
    optionalAuth: true,
    signal: AbortSignal.timeout(STACK_DOWNLOAD_TIMEOUT_MS),
  })
  if (res.status === 403) {
    throw new Error(`Stack "${slug}" is private. Sign in with an account that can see it and re-run.`)
  }
  if (res.status === 404) {
    throw new Error(`Stack "${slug}" not found, or it has no public skills.`)
  }
  if (!res.ok) {
    throw new Error(`Stack download failed (${res.status}).`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function toStack(raw: unknown): StackCard {
  const data = (raw ?? {}) as Record<string, unknown>
  const owner = (data.owner ?? {}) as Record<string, unknown>
  const skills = Array.isArray(data.skills) ? data.skills.map(toSkillPreview) : []
  const skillCount = asNumber(data.skillCount)
  return {
    id: asString(data.id) ?? "",
    slug: asString(data.slug) ?? "",
    name: asString(data.name) ?? "",
    description: asString(data.description) ?? "",
    owner: {
      username: asString(owner.username),
      firstName: asString(owner.firstName),
      lastName: asString(owner.lastName),
      avatarUrl: asString(owner.avatarUrl) ?? null,
    },
    memberCount: asNumber(data.memberCount),
    skillCount,
    updatedAt: asString(data.updatedAt) ?? null,
    skills,
    previewTruncated: skillCount > skills.length,
  }
}

function toSkillPreview(raw: unknown): StackSkillPreview {
  const data = (raw ?? {}) as Record<string, unknown>
  return {
    id: asString(data.id) ?? "",
    name: asString(data.name) ?? "",
    description: asString(data.description) ?? "",
    version: asString(data.version) ?? "",
    stars: asNumber(data.stars),
    downloadCount: asNumber(data.downloadCount),
  }
}

// The owner's display name the way the hub's own Skill Stack page builds it.
export function ownerLabel(owner: StackCard["owner"]): string {
  const full = [owner.firstName, owner.lastName].filter((part) => part).join(" ")
  return full || owner.username || "unknown"
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
