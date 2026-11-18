import { diffFromEditInput, diffFromWriteContent } from "./diff"
import { codeFence } from "./render"

// Part-to-markdown rendering shared by the two session sources: the sqlite
// reader (db.ts) and the sandbox server-API reader (server-source.ts). The
// sqlite `part.data` column stores exactly the v1 API part objects, so one
// renderer keeps both sources' output in one format. Ported from the hub's
// OpenCode provider — the tool-use markup and diff fences are what the
// backend's LOC enricher parses; change nothing here casually.

export function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function unixToISO(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ""
  // Timestamps may be seconds or milliseconds; treat large values as ms.
  const epochMs = ms > 1e12 ? ms : ms * 1000
  return new Date(epochMs).toISOString()
}

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`
  }
  return `${ms}ms`
}

interface ReasoningPart {
  type: "reasoning"
  text: string
  time?: { start: number; end: number }
}

interface ToolPart {
  type: "tool"
  tool: string
  state: {
    status: "completed" | "error"
    input: Record<string, unknown>
    output?: string
    error?: string
    metadata?: {
      diff?: string
      filediff?: { patch: string }
    }
  }
}

interface TextPart {
  type: "text"
  text: string
}

export function partToMarkdown(part: unknown): string | null {
  const obj = part as { type?: string } | null
  if (!obj || typeof obj !== "object") return null

  if (obj.type === "text") {
    const textPart = obj as TextPart
    return typeof textPart.text === "string" ? textPart.text : null
  }

  if (obj.type === "reasoning") {
    const reasonPart = obj as ReasoningPart
    if (typeof reasonPart.text !== "string" || !reasonPart.text.trim()) return null

    let durationStr = ""
    if (reasonPart.time && typeof reasonPart.time.start === "number" && typeof reasonPart.time.end === "number") {
      const diff = reasonPart.time.end - reasonPart.time.start
      if (diff >= 0) {
        durationStr = ` for ${formatDuration(diff)}`
      }
    }
    return `<details><summary>Thought${durationStr}</summary>\n\n${reasonPart.text.trim()}\n</details>\n`
  }

  if (obj.type === "tool") {
    const toolPart = obj as ToolPart
    const toolName = toolPart.tool
    const state = toolPart.state || {}
    const isCompleted = state.status === "completed"
    const input = state.input || {}
    const output = state.output || ""
    const error = state.error || ""

    if (toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : ""
      const desc = typeof input.description === "string" ? input.description : ""
      const summary = `Run command: ${command}`
      const descSection = desc ? `Description: ${desc}\n\n` : ""
      const body = `${descSection}${codeFence(
        `$ ${command}\n${isCompleted ? output : `Error: ${error || "Tool execution aborted"}`}`,
        "bash",
      )}`
      return `<tool-use data-tool-type="shell" data-tool-name="bash">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
    }

    if (toolName === "read") {
      const path = typeof input.filePath === "string" ? input.filePath : ""
      const summary = `Read file: ${path}`
      const body = isCompleted ? output : `Error: ${error || "Tool execution aborted"}`
      return `<tool-use data-tool-type="read" data-tool-name="read">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
    }

    if (toolName === "glob") {
      const pattern = typeof input.pattern === "string" ? input.pattern : ""
      const summary = `Glob files: ${pattern}`
      const body = codeFence(
        `Pattern: ${pattern}\nMatches:\n${isCompleted ? output : `Error: ${error || "Tool execution aborted"}`}`,
      )
      return `<tool-use data-tool-type="glob" data-tool-name="glob">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
    }

    if (toolName === "grep") {
      const pattern = typeof input.pattern === "string" ? input.pattern : ""
      const path = typeof input.path === "string" ? input.path : ""
      const summary = `Grep search: ${pattern}`
      const body = codeFence(
        `Pattern: ${pattern}\nPath: ${path}\nMatches:\n${isCompleted ? output : `Error: ${error || "Tool execution aborted"}`}`,
      )
      return `<tool-use data-tool-type="grep" data-tool-name="grep">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
    }

    if (toolName === "write") {
      const path = typeof input.filePath === "string" ? input.filePath : ""
      const content = typeof input.content === "string" ? input.content : ""
      const summary = `Edit file: ${path}`
      // All-additions diff so the LOC enricher counts every line (hub parity).
      const diff = diffFromWriteContent(content)
      let body: string
      if (diff) {
        body = `${codeFence(diff, "diff")}${isCompleted ? "" : `\n\nError: ${error || "Tool execution aborted"}`}`
      } else if (isCompleted) {
        body = codeFence(content)
      } else {
        body = `Error: ${error || "Tool execution aborted"}`
      }
      return `<tool-use data-tool-type="write" data-tool-name="write" data-edit-status="${isCompleted ? "accepted" : "rejected"}">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
    }

    if (toolName === "edit") {
      const path = typeof input.filePath === "string" ? input.filePath : ""
      const summary = `Edit file: ${path}`
      // Reconstruct the diff when no server-rendered metadata was attached —
      // otherwise completed edits underreport accepted LOC (hub parity).
      const diff = state.metadata?.diff || state.metadata?.filediff?.patch || diffFromEditInput(input)
      let body: string
      if (diff) {
        body = `${codeFence(diff, "diff")}${isCompleted ? "" : `\n\nError: ${error || "Tool execution aborted"}`}`
      } else if (isCompleted) {
        body = "Edit applied successfully."
      } else {
        body = `Error: ${error || "Tool execution aborted"}`
      }
      return `<tool-use data-tool-type="write" data-tool-name="edit" data-edit-status="${isCompleted ? "accepted" : "rejected"}">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
    }

    if (toolName === "task") {
      const desc = typeof input.description === "string" ? input.description : ""
      const prompt = typeof input.prompt === "string" ? input.prompt : ""
      const subagent = typeof input.subagent_type === "string" ? input.subagent_type : ""
      const summary = `Spawn subagent: ${desc || subagent}`
      const body = `**Subagent Type**: ${subagent}\n**Prompt**:\n${prompt}\n\n**Result**:\n${isCompleted ? output : `Error: ${error || "Subagent execution aborted"}`}`
      return `<tool-use data-tool-type="task" data-tool-name="task">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
    }

    const summary = `Call tool: ${toolName}`
    const body = codeFence(JSON.stringify(state, null, 2), "json")
    return `<tool-use data-tool-type="tool" data-tool-name="${toolName}">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`
  }

  return null
}
