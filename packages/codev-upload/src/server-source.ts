import { networkVolumeFilter } from "./network"
import { projectFolderName } from "./paths"
import { buildSessionStats, type SessionStats, type StatsMessage } from "./stats"

// Session source for the stats push over a running Codev2 server. Desktop Work
// sandboxes expose only this HTTP surface; the host cannot read their guest DB.
// Routes follow OpenCode v2 (`/api/session`, `/api/session/:id/message`).

export interface ServerSource {
  url: string
  username?: string | null
  password?: string | null
  // Host directory that names the project for every session from this server.
  projectDir: string
}

interface ApiSessionInfo {
  id: string
  parentID?: string
  time?: { created?: number; updated?: number }
}

interface ApiMessage {
  type?: string
  agent?: string
  model?: { providerID?: string; modelID?: string; id?: string } | string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  time?: { created?: number; completed?: number }
  text?: string
  content?: unknown[]
  name?: string
}

interface Page<T> {
  data: T[]
  cursor?: { next?: string; previous?: string }
}

const REQUEST_TIMEOUT_MS = 60_000
const PAGE_LIMIT = 200
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

async function listAllSessions(source: ServerSource, fetchImpl: typeof fetch): Promise<ApiSessionInfo[]> {
  const all: ApiSessionInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), order: "desc" })
    if (cursor) params.set("cursor", cursor)
    const response = await apiGet<Page<ApiSessionInfo>>(source, `/api/session?${params}`, fetchImpl)
    all.push(...(response.data ?? []))
    const next = response.cursor?.next
    if (!next || (response.data?.length ?? 0) < PAGE_LIMIT) break
    cursor = next
  }
  return all
}

async function readMessages(
  source: ServerSource,
  info: ApiSessionInfo,
  fetchImpl: typeof fetch,
): Promise<StatsMessage[]> {
  const messages: StatsMessage[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), order: "asc" })
    if (cursor) params.set("cursor", cursor)
    const response = await apiGet<Page<ApiMessage>>(
      source,
      `/api/session/${encodeURIComponent(info.id)}/message?${params}`,
      fetchImpl,
    )
    for (const message of response.data ?? []) {
      const mapped = toStatsMessage(message)
      if (mapped) messages.push(mapped)
    }
    const next = response.cursor?.next
    if (!next || (response.data?.length ?? 0) < PAGE_LIMIT) break
    cursor = next
  }
  return messages
}

/** Map a v2 projected message into the v1-shaped stats builder input. */
export function toStatsMessage(message: ApiMessage): StatsMessage | undefined {
  if (message.type === "user") {
    return {
      info: { role: "user", time: { created: message.time?.created } },
      parts: message.text === undefined ? [] : [{ type: "text", text: message.text }],
    }
  }
  if (message.type !== "assistant") return undefined
  const model =
    typeof message.model === "string"
      ? { modelID: message.model, providerID: undefined }
      : { modelID: message.model?.modelID ?? message.model?.id, providerID: message.model?.providerID }
  return {
    info: {
      role: "assistant",
      modelID: model.modelID,
      providerID: model.providerID,
      agent: message.agent,
      cost: message.cost,
      tokens: message.tokens,
      time: { created: message.time?.created, completed: message.time?.completed },
    },
    parts: (message.content ?? []).map(mapAssistantPart),
  }
}

function mapAssistantPart(part: unknown): unknown {
  if (!part || typeof part !== "object") return part
  const value = part as { type?: string; name?: string; text?: string; state?: { status?: string; input?: unknown } }
  if (value.type === "tool") {
    return {
      type: "tool",
      tool: value.name ?? "tool",
      state: {
        status: value.state?.status === "error" ? "error" : "completed",
        input: value.state?.input,
      },
    }
  }
  if (value.type === "text" || value.type === "reasoning") {
    return { type: "text", text: value.text ?? "" }
  }
  return part
}

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
