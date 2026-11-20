import { existsSync } from "node:fs"
import { partToMarkdown, safeParse, unixToISO } from "./parts"
import { openSessionDb, type SessionDb } from "#sqlite"
import { networkVolumeFilter } from "./network"
import { projectFolderName, sessionDbPath } from "./paths"
import { buildSessionStats, type SessionStats, type StatsMessage } from "./stats"
import { toStatsMessage } from "./server-source"
import type { Message, Session } from "./types"

// Session-store reader: a port of the hub's OpenCode provider
// (src/providers/opencode.ts) widened from one project to the whole store —
// the uploader ships every top-level session on the machine. The SQL, the
// part-to-markdown rendering, and the subagent rollup are kept literal so a
// session renders byte-identically whichever side exports it.

interface SessionRow {
  id: string
  project_id: string
  title: string | null
  directory: string | null
  parent_id?: string | null
  time_created: number
  time_updated: number
}

interface MessageRow {
  id: string
  time_created: number
  data: string
}

interface PartRow {
  data: string
}

interface MessageMeta {
  role?: string
  modelID?: string
  model?: { providerID?: string; modelID?: string }
}

function readMessages(db: SessionDb, sessionId: string): MessageRow[] {
  return db
    .prepare<MessageRow>("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created")
    .all(sessionId)
}

function readParts(db: SessionDb, sessionId: string, messageId: string): PartRow[] {
  return db
    .prepare<PartRow>("SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created")
    .all(sessionId, messageId)
}

// The parent_id column arrived with subagents; older stores lack it (hub parity).
function sessionHasParentId(db: SessionDb): boolean {
  try {
    const cols = db.prepare<{ name: string }>("PRAGMA table_info(session)").all()
    return cols.some((c) => c.name === "parent_id")
  } catch {
    return false
  }
}

// Recursively sum descendant subagent character counts so the parent session
// reflects their cost even though child sessions are not uploaded (hub parity).
function collectDescendantChars(db: SessionDb, sessionId: string): { charsIn: number; charsOut: number } {
  const children = db.prepare<{ id: string }>("SELECT id FROM session WHERE parent_id = ?").all(sessionId)

  let charsIn = 0
  let charsOut = 0

  for (const child of children) {
    for (const msg of readMessages(db, child.id)) {
      const meta = safeParse<MessageMeta>(msg.data)
      const role = meta?.role === "assistant" ? "assistant" : "user"
      let chars = 0
      for (const part of readParts(db, child.id, msg.id)) {
        const text = parsePart(part.data)
        if (text) chars += text.length
      }
      if (role === "user") charsIn += chars
      else charsOut += chars
    }
    const nested = collectDescendantChars(db, child.id)
    charsIn += nested.charsIn
    charsOut += nested.charsOut
  }

  return { charsIn, charsOut }
}

function buildSession(db: SessionDb, row: SessionRow, hasParentId: boolean, projectDir: string): Session | null {
  const messages: Message[] = []
  let firstUserMessage = ""

  for (const msg of readMessages(db, row.id)) {
    const meta = safeParse<MessageMeta>(msg.data)
    const role = meta?.role === "assistant" ? "assistant" : "user"
    const textParts: string[] = []
    for (const part of readParts(db, row.id, msg.id)) {
      const text = parsePart(part.data)
      if (text) textParts.push(text)
    }
    const content = textParts.join("\n").trim()
    if (!content) continue
    const timestamp = unixToISO(msg.time_created)
    // Flat modelID on assistant rows, nested model object on user rows; only
    // assistant turns carry the model in the markdown heading (hub parity).
    const modelId = meta?.modelID || meta?.model?.modelID || undefined
    messages.push({
      role,
      content,
      timestamp: timestamp || undefined,
      model: role === "assistant" ? modelId : undefined,
    })
    if (role === "user" && !firstUserMessage) firstUserMessage = content
  }

  if (messages.length === 0) return null
  const createdMs = unixToISO(row.time_created)
  const updatedMs = unixToISO(row.time_updated)

  const { charsIn: subagentCharsIn, charsOut: subagentCharsOut } = hasParentId
    ? collectDescendantChars(db, row.id)
    : { charsIn: 0, charsOut: 0 }

  return {
    id: row.id,
    createdAt: createdMs ? new Date(createdMs) : new Date(),
    updatedAt: updatedMs ? new Date(updatedMs) : undefined,
    title: row.title || undefined,
    firstUserMessage,
    messages,
    projectDir,
    ...(subagentCharsIn > 0 || subagentCharsOut > 0 ? { subagentCharsIn, subagentCharsOut } : {}),
  }
}

// Every top-level session in the store, each tagged with the directory that
// decides its per-project export folder: the owning project's worktree, or the
// session's own directory for VCS-less ("global") sessions.
export function readAllSessions(dbPath = sessionDbPath()): Session[] {
  if (!existsSync(dbPath)) return []
  const db = openSessionDb(dbPath)
  try {
    const worktrees = readWorktrees(db)
    const hasParentId = sessionHasParentId(db)
    // parent_id IS NULL drops normal-mode subagent sessions — they're folded
    // into their spawning session. Schemas without the column export everything
    // rather than throwing (hub parity).
    const parentFilter = hasParentId ? " WHERE parent_id IS NULL" : ""
    const rows = db
      .prepare<SessionRow>(`SELECT ${sessionColumns(hasParentId)} FROM session${parentFilter} ORDER BY time_created`)
      .all()

    const sessions: Session[] = []
    for (const row of rows) {
      const projectDir = sessionProjectDir(row, worktrees)
      if (!projectDir) continue
      try {
        const session = buildSession(db, row, hasParentId, projectDir)
        if (session) sessions.push(session)
      } catch {
        // Skip malformed sessions (hub parity).
      }
    }
    return sessions
  } finally {
    db.close()
  }
}

// Usage statistics for every top-level session in the store — the stats
// push's local source. Subagent sessions are not reported on their own; their
// messages roll up into the session that spawned them. Project dirs on a
// network volume are named without resolving them (see network.ts).
export function readAllSessionStats(dbPath = sessionDbPath(), onNetworkVolume = networkVolumeFilter()): SessionStats[] {
  if (!existsSync(dbPath)) return []
  const db = openSessionDb(dbPath)
  try {
    const worktrees = readWorktrees(db)
    if (hasTable(db, "session_v2")) return readV2SessionStats(db, worktrees, onNetworkVolume)
    const hasParentId = sessionHasParentId(db)
    const rows = db
      .prepare<SessionRow>(`SELECT ${sessionColumns(hasParentId)} FROM session ORDER BY time_created`)
      .all()
    const childrenOf = new Map<string, string[]>()
    for (const row of rows) {
      if (!row.parent_id) continue
      childrenOf.set(row.parent_id, [...(childrenOf.get(row.parent_id) ?? []), row.id])
    }
    const descendantsOf = (id: string): string[] =>
      (childrenOf.get(id) ?? []).flatMap((child) => [child, ...descendantsOf(child)])
    return rows.flatMap((row) => {
      if (row.parent_id) return []
      const projectDir = sessionProjectDir(row, worktrees)
      if (!projectDir) return []
      try {
        const stats = buildSessionStats({
          id: row.id,
          origin: "local",
          project: projectFolderName(projectDir, { resolve: !onNetworkVolume(projectDir) }),
          messages: readStatsMessages(db, row.id),
          descendants: descendantsOf(row.id).map((id) => readStatsMessages(db, id)),
        })
        return stats ? [stats] : []
      } catch {
        // Skip malformed sessions — the rest still report.
        return []
      }
    })
  } finally {
    db.close()
  }
}

// One session's messages with their parts attached, in the v1 API shape the
// stats builder reads. A row without its own time falls back to the column.
function readStatsMessages(db: SessionDb, sessionId: string): StatsMessage[] {
  const parts = new Map<string, unknown[]>()
  for (const row of db
    .prepare<{
      message_id: string
      data: string
    }>("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created")
    .all(sessionId)) {
    const part = safeParse<unknown>(row.data)
    if (part) parts.set(row.message_id, [...(parts.get(row.message_id) ?? []), part])
  }
  return readMessages(db, sessionId).flatMap((msg) => {
    const info = safeParse<StatsMessage["info"]>(msg.data)
    if (!info) return []
    return [{ info: { ...info, time: info.time ?? { created: msg.time_created } }, parts: parts.get(msg.id) ?? [] }]
  })
}

// Codev2 keeps sessions in the v2 tables. A `session_message` row holds the same projected message the server API
// returns (`type` column plus JSON `data`), so the API mapper turns it into stats input.
function readV2SessionStats(
  db: SessionDb,
  worktrees: Map<string, string>,
  onNetworkVolume: (path: string) => boolean,
): SessionStats[] {
  const rows = db
    .prepare<SessionRow>(
      "SELECT id, project_id, title, directory, parent_id, time_created, time_updated FROM session_v2 ORDER BY time_created",
    )
    .all()
  const childrenOf = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.parent_id) continue
    childrenOf.set(row.parent_id, [...(childrenOf.get(row.parent_id) ?? []), row.id])
  }
  const descendantsOf = (id: string): string[] =>
    (childrenOf.get(id) ?? []).flatMap((child) => [child, ...descendantsOf(child)])
  const messages = (sessionID: string) =>
    db
      .prepare<{ type: string; data: string }>(
        "SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionID)
      .flatMap((row) => {
        const data = safeParse<Record<string, unknown>>(row.data)
        const message = data ? toStatsMessage({ ...data, type: row.type }) : undefined
        return message ? [message] : []
      })
  return rows.flatMap((row) => {
    if (row.parent_id) return []
    const projectDir = sessionProjectDir(row, worktrees)
    if (!projectDir) return []
    try {
      const stats = buildSessionStats({
        id: row.id,
        origin: "local",
        project: projectFolderName(projectDir, { resolve: !onNetworkVolume(projectDir) }),
        messages: messages(row.id),
        descendants: descendantsOf(row.id).map(messages),
      })
      return stats ? [stats] : []
    } catch {
      return []
    }
  })
}

function hasTable(db: SessionDb, name: string) {
  return (
    db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(name).length >
    0
  )
}

function readWorktrees(db: SessionDb): Map<string, string> {
  const worktrees = new Map<string, string>()
  for (const project of db.prepare<{ id: string; worktree: string | null }>("SELECT id, worktree FROM project").all()) {
    if (project.worktree) worktrees.set(project.id, project.worktree)
  }
  return worktrees
}

function sessionColumns(hasParentId: boolean): string {
  return hasParentId
    ? "id, project_id, title, directory, parent_id, time_created, time_updated"
    : "id, project_id, title, directory, time_created, time_updated"
}

// The owning project's worktree, or the session's own directory for VCS-less
// ("global") sessions.
function sessionProjectDir(row: SessionRow, worktrees: Map<string, string>): string | null {
  if (row.project_id === "global") return row.directory
  return worktrees.get(row.project_id) ?? row.directory
}

// Rows store the part JSON as text; parse then render via the shared renderer.
function parsePart(raw: string): string | null {
  const obj = safeParse<{ type?: string }>(raw)
  if (!obj) return null
  return partToMarkdown(obj)
}
