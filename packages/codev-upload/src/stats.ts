import { diffFromEditInput, textValue } from "./diff"
import { unixToISO } from "./parts"

// Per-session usage statistics — what `upload-session-stats` receives instead
// of the rendered conversation. Built from the same v1 message/part objects
// the sqlite store and the server API both carry, so local and sandbox
// sessions produce identical records. Nothing here carries conversation
// content: counts, token totals, cost, tool outcomes, file extensions, skill
// names and hour buckets only.

export const STATS_VERSION = 1

export interface StatsMessage {
  info: StatsMessageInfo
  parts: unknown[]
}

interface StatsMessageInfo {
  role?: string
  modelID?: string
  providerID?: string
  agent?: string
  mode?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  time?: { created?: number; completed?: number }
}

export interface Usage {
  turns: number
  tokens: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number }
  cost: number
  tools: Record<string, { ok: number; error: number }>
  loc: { added: number; deleted: number; rejected_added: number; rejected_deleted: number }
}

export interface UsageBucket extends Usage {
  hour: string
  model: string
  provider: string
}

export interface SessionStats {
  session_id: string
  origin: "local" | "sandbox"
  project: string
  started_at: string
  ended_at: string
  active_ms: number
  user_turns: number
  subagents: number
  files_changed: number
  agents: Record<string, number>
  skills: Record<string, number>
  skills_created: Record<string, number>
  file_extensions: Record<string, number>
  totals: Usage
  buckets: UsageBucket[]
}

export interface SessionStatsInput {
  id: string
  origin: SessionStats["origin"]
  project: string
  messages: StatsMessage[]
  // One message list per descendant subagent session — their usage rolls up
  // into the parent rather than being reported standalone.
  descendants: StatsMessage[][]
}

interface ToolPart {
  type: "tool"
  tool: string
  state: {
    status: "completed" | "error"
    input?: Record<string, unknown>
    metadata?: {
      filediff?: { additions?: number; deletions?: number }
      files?: { filePath?: unknown; additions?: number; deletions?: number }[]
    }
  }
}

export function buildSessionStats(input: SessionStatsInput): SessionStats | null {
  if (input.messages.length === 0) return null
  const totals = emptyUsage()
  const buckets = new Map<string, UsageBucket>()
  const files = new Set<string>()
  for (const message of [...input.messages, ...input.descendants.flat()]) {
    if (message.info.role !== "assistant") continue
    const hour = hourOf(message.info.time?.created ?? 0)
    const model = message.info.modelID ?? ""
    const provider = message.info.providerID ?? ""
    const key = `${hour}|${provider}|${model}`
    const bucket = buckets.get(key) ?? { hour, model, provider, ...emptyUsage() }
    buckets.set(key, bucket)
    const usage = messageUsage(message, files)
    addUsage(totals, usage)
    addUsage(bucket, usage)
  }
  const starts = input.messages.map((message) => message.info.time?.created ?? 0).filter((time) => time > 0)
  const ends = input.messages
    .map((message) => message.info.time?.completed ?? message.info.time?.created ?? 0)
    .filter((time) => time > 0)
  return {
    session_id: input.id,
    origin: input.origin,
    project: input.project,
    started_at: starts.length > 0 ? unixToISO(starts.reduce((min, time) => Math.min(min, time))) : "",
    ended_at: ends.length > 0 ? unixToISO(ends.reduce((max, time) => Math.max(max, time))) : "",
    active_ms: input.messages
      .filter((message) => message.info.role === "assistant" && message.info.time?.completed)
      .reduce(
        (sum, message) => sum + Math.max(0, (message.info.time?.completed ?? 0) - (message.info.time?.created ?? 0)),
        0,
      ),
    user_turns: input.messages.filter(isUserPrompt).length,
    subagents: input.descendants.length,
    files_changed: files.size,
    agents: tally(
      input.messages.flatMap((message) =>
        message.info.role === "assistant" ? [message.info.agent || message.info.mode || ""].filter(Boolean) : [],
      ),
    ),
    ...fileBreakdowns([...input.messages, ...input.descendants.flat()]),
    totals,
    buckets: [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.model.localeCompare(b.model)),
  }
}

function emptyUsage(): Usage {
  return {
    turns: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    tools: {},
    loc: { added: 0, deleted: 0, rejected_added: 0, rejected_deleted: 0 },
  }
}

function addUsage(target: Usage, usage: Usage): void {
  target.turns += usage.turns
  target.cost += usage.cost
  for (const key of Object.keys(usage.tokens) as (keyof Usage["tokens"])[]) target.tokens[key] += usage.tokens[key]
  for (const key of Object.keys(usage.loc) as (keyof Usage["loc"])[]) target.loc[key] += usage.loc[key]
  for (const [tool, count] of Object.entries(usage.tools)) {
    const existing = target.tools[tool] ?? { ok: 0, error: 0 }
    target.tools[tool] = { ok: existing.ok + count.ok, error: existing.error + count.error }
  }
}

function messageUsage(message: StatsMessage, files: Set<string>): Usage {
  const usage = emptyUsage()
  const tokens = message.info.tokens
  usage.turns = 1
  usage.cost = finite(message.info.cost)
  usage.tokens = {
    input: finite(tokens?.input),
    output: finite(tokens?.output),
    reasoning: finite(tokens?.reasoning),
    cache_read: finite(tokens?.cache?.read),
    cache_write: finite(tokens?.cache?.write),
  }
  for (const part of message.parts.filter(isFinishedToolPart)) {
    const accepted = part.state.status === "completed"
    const count = usage.tools[part.tool] ?? { ok: 0, error: 0 }
    usage.tools[part.tool] = accepted ? { ...count, ok: count.ok + 1 } : { ...count, error: count.error + 1 }
    const edit = toolEdit(part)
    if (!edit) continue
    // A rejected edit (permission denied, failed apply) changed nothing on
    // disk — counted apart so accepted LOC stays what actually landed.
    if (!accepted) {
      usage.loc.rejected_added += edit.added
      usage.loc.rejected_deleted += edit.deleted
      continue
    }
    usage.loc.added += edit.added
    usage.loc.deleted += edit.deleted
    for (const file of edit.files) files.add(file)
  }
  return usage
}

function isFinishedToolPart(part: unknown): part is ToolPart {
  const candidate = part as Partial<ToolPart> | null
  if (!candidate || candidate.type !== "tool" || typeof candidate.tool !== "string") return false
  return candidate.state?.status === "completed" || candidate.state?.status === "error"
}

// Lines added/deleted by one file-mutating tool call. Prefers the tool's own
// metadata (exact, post-apply) and falls back to diffing the input.
function toolEdit(part: ToolPart): { added: number; deleted: number; files: string[] } | undefined {
  const input = part.state.input ?? {}
  const metadata = part.state.metadata ?? {}
  const completed = part.state.status === "completed"
  if (part.tool === "edit") {
    const files = [textValue(input.filePath)].filter(Boolean)
    const filediff = metadata.filediff
    if (completed && typeof filediff?.additions === "number")
      return { added: filediff.additions, deleted: finite(filediff.deletions), files }
    return { ...countDiffLines(diffFromEditInput(input)), files }
  }
  if (part.tool === "write") {
    const content = textValue(input.content)
    const lines = content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0
    return { added: lines, deleted: 0, files: [textValue(input.filePath)].filter(Boolean) }
  }
  if (part.tool === "apply_patch") {
    const changed = Array.isArray(metadata.files) ? metadata.files : []
    if (completed && changed.length > 0)
      return {
        added: changed.reduce((sum, file) => sum + finite(file.additions), 0),
        deleted: changed.reduce((sum, file) => sum + finite(file.deletions), 0),
        files: changed.map((file) => textValue(file.filePath)).filter(Boolean),
      }
    return { ...countDiffLines(textValue(input.patchText)), files: [] }
  }
  return undefined
}

// Skills used (the skill tool, or a read of a SKILL.md), skills created (a
// successful write/edit of a SKILL.md) and the extensions of every file
// touched — names only, never paths.
function fileBreakdowns(messages: StatsMessage[]) {
  const skills: string[] = []
  const created = new Set<string>()
  const touched = new Set<string>()
  for (const part of messages.flatMap((message) => message.parts.filter(isFinishedToolPart))) {
    const input = part.state.input ?? {}
    if (part.tool === "skill") {
      const name = textValue(input.name)
      if (name) skills.push(name)
      continue
    }
    const paths = toolPaths(part)
    for (const path of paths) touched.add(path)
    for (const name of paths.flatMap((path) => SKILL_FILE.exec(path)?.slice(1, 2) ?? [])) {
      if (part.tool === "read") skills.push(name)
      else if (part.state.status === "completed") created.add(name)
    }
  }
  return {
    skills: tally(skills),
    skills_created: tally([...created]),
    file_extensions: tally([...touched].map(extensionOf).filter(Boolean)),
  }
}

const SKILL_FILE = /[/\\]([^/\\]+)[/\\]SKILL\.md$/
const FILE_TOOLS = new Set(["read", "edit", "write"])

function toolPaths(part: ToolPart): string[] {
  const input = part.state.input ?? {}
  if (FILE_TOOLS.has(part.tool)) return [textValue(input.filePath)].filter(Boolean)
  const files = part.state.metadata?.files
  if (part.tool !== "apply_patch" || !Array.isArray(files)) return []
  return files.map((file) => textValue(file.filePath)).filter(Boolean)
}

function extensionOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot).toLowerCase() : ""
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function countDiffLines(diff: string): { added: number; deleted: number } {
  const lines = diff.split("\n")
  return {
    added: lines.filter((line) => line.startsWith("+")).length,
    deleted: lines.filter((line) => line.startsWith("-")).length,
  }
}

// A user turn the person typed — synthetic parts (attachments the agent
// injected, compaction summaries) do not count.
function isUserPrompt(message: StatsMessage): boolean {
  if (message.info.role !== "user") return false
  return message.parts.some((part) => {
    const text = part as { type?: string; synthetic?: boolean; text?: unknown } | null
    return text?.type === "text" && !text.synthetic && typeof text.text === "string" && text.text.trim() !== ""
  })
}

function hourOf(ms: number): string {
  const iso = unixToISO(ms)
  if (!iso) return ""
  return `${iso.slice(0, 13)}:00:00.000Z`
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
