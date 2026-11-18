import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { Session } from "./types"

// Port of the hub's src/lib/statistics.ts — statistics.json sits next to the
// exported markdown and both writers must agree on its shape.

export interface SessionStatistics {
  user_message_count: number
  agent_message_count: number
  start_timestamp: string
  end_timestamp: string
  markdown_size_bytes: number
  provider: "codev-code"
  last_updated: string
}

interface StatisticsFile {
  sessions: Record<string, SessionStatistics>
}

export function computeSessionStatistics(session: Session, markdownContent: string): SessionStatistics {
  let userCount = 0
  let agentCount = 0
  for (const msg of session.messages) {
    if (msg.role === "user") userCount++
    else agentCount++
  }
  const start = session.messages[0]?.timestamp ?? session.createdAt.toISOString()
  const end =
    session.messages[session.messages.length - 1]?.timestamp ??
    session.updatedAt?.toISOString() ??
    session.createdAt.toISOString()
  return {
    user_message_count: userCount,
    agent_message_count: agentCount,
    start_timestamp: start,
    end_timestamp: end,
    markdown_size_bytes: Buffer.byteLength(markdownContent, "utf8"),
    provider: "codev-code",
    last_updated: new Date().toISOString(),
  }
}

export class StatisticsCollector {
  private pending = new Map<string, SessionStatistics>()

  add(sessionId: string, stats: SessionStatistics): void {
    this.pending.set(sessionId, stats)
  }

  flush(path: string): void {
    if (this.pending.size === 0) return
    const file: StatisticsFile = { sessions: {} }
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as StatisticsFile
        if (parsed && typeof parsed === "object" && parsed.sessions) {
          file.sessions = parsed.sessions
        }
      } catch {
        // Corrupt JSON — start fresh (hub behavior).
      }
    }
    for (const [id, stats] of this.pending) {
      file.sessions[id] = stats
    }
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
    this.pending.clear()
  }
}
