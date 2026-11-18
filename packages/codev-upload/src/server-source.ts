import { networkVolumeFilter } from "./network"
import { projectFolderName } from "./paths"
import { buildSessionStats, type SessionStats, type StatsMessage } from "./stats"

// Second session source for the stats push: a running codev server, read over
// its v1 HTTP API. Exists for the desktop's work (sandbox) sessions — each
// sandbox runs a full server against its own guest-private database, holds
// only broker-placeholder credentials (so it cannot report itself), and its
// disk is opaque to the host (a VZ image on macOS) — the authenticated HTTP
// surface the desktop already uses to render those sessions is the one
// uniform way in.
//
// The v1 routes are used deliberately: their payloads are the same objects the
// sqlite `data` columns store, so the stats builder (stats.ts) reads API- and
// sqlite-sourced sessions identically.

export interface ServerSource {
  url: string
  username?: string | null
  password?: string | null
  // Host directory that names the project for every session from this
  // server. Guest paths (/mnt/..., /workspace) are meaningless on
  // the host, and keying on the host project dir puts a project's local and
  // sandboxed sessions in one analysis bucket.
  projectDir: string
}

interface ApiSessionInfo {
  id: string
  parentID?: string
  directory: string
  title?: string
  time?: { created?: number; updated?: number }
}

interface ApiMessage {
  info?: StatsMessage["info"]
  parts?: unknown[]
}

const REQUEST_TIMEOUT_MS = 60_000
// The global listing defaults to 100 rows; page explicitly. The cursor is
// strictly-less-than on time_updated, so rows sharing one updated timestamp
// across a page boundary can be skipped — acceptable for a push that runs
// again on every launch.
const PAGE_LIMIT = 1000
const MAX_PAGES = 100

async function apiGet<T>(source: ServerSource, path: string, fetchImpl: typeof fetch): Promise<T> {
  const headers = new Headers({ accept: "application/json" })
  if (source.username && source.password) {
    headers.set("authorization", `Basic ${btoa(`${source.username}:${source.password}`)}`)
  }
  const res = await fetchImpl(`${source.url.replace(/\/+$/, "")}${path}`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`sandbox server GET ${path} failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as T
}

// All sessions in the server's store, children included — parentID on the
// listing rows is what lets the subagent rollup work from one sweep.
// archived=true matches the sqlite source, which never filters archived rows.
async function listAllSessions(source: ServerSource, fetchImpl: typeof fetch): Promise<ApiSessionInfo[]> {
  const all: ApiSessionInfo[] = []
  let cursor: number | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), archived: "true" })
    if (cursor !== undefined) params.set("cursor", String(cursor))
    const rows = await apiGet<ApiSessionInfo[]>(source, `/experimental/session?${params}`, fetchImpl)
    all.push(...rows)
    if (rows.length < PAGE_LIMIT) break
    cursor = rows[rows.length - 1]?.time?.updated
    if (cursor === undefined) break
  }
  return all
}

async function readMessages(
  source: ServerSource,
  info: ApiSessionInfo,
  fetchImpl: typeof fetch,
): Promise<StatsMessage[]> {
  // No limit param: the v1 handler returns the full timeline when unpaged.
  // directory routes the request to the session's workspace instance.
  const params = new URLSearchParams({ directory: info.directory })
  const messages = await apiGet<ApiMessage[]>(
    source,
    `/session/${encodeURIComponent(info.id)}/message?${params}`,
    fetchImpl,
  )
  return messages.flatMap((message) => (message.info ? [{ info: message.info, parts: message.parts ?? [] }] : []))
}

// Stats for every top-level session on the server, subagent sessions rolled
// into their parent — the same contract as the sqlite source.
export async function readSessionStatsFromServer(
  source: ServerSource,
  fetchImpl: typeof fetch = fetch,
  onNetworkVolume = networkVolumeFilter(),
): Promise<SessionStats[]> {
  const all = await listAllSessions(source, fetchImpl)
  const childrenOf = new Map<string, ApiSessionInfo[]>()
  for (const info of all) {
    if (!info.parentID) continue
    childrenOf.set(info.parentID, [...(childrenOf.get(info.parentID) ?? []), info])
  }
  const descendantsOf = (id: string): ApiSessionInfo[] =>
    (childrenOf.get(id) ?? []).flatMap((child) => [child, ...descendantsOf(child.id)])
  const project = projectFolderName(source.projectDir, { resolve: !onNetworkVolume(source.projectDir) })
  const stats: SessionStats[] = []
  for (const info of all) {
    if (info.parentID) continue
    try {
      const built = buildSessionStats({
        id: info.id,
        origin: "sandbox",
        project,
        messages: await readMessages(source, info, fetchImpl),
        descendants: await Promise.all(descendantsOf(info.id).map((child) => readMessages(source, child, fetchImpl))),
      })
      if (built) stats.push(built)
    } catch {
      // Skip a session whose messages cannot be read — the rest still report.
    }
  }
  return stats
}
