import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readCodevCodeBaseUrl } from "./config"
import { readAllSessions } from "./db"
import { logDebug, logInfo, logWarn } from "./log"
import { agentLogsDir, buildFilename, projectLogsDir, sessionDbPath } from "./paths"
import { renderMarkdown } from "./render"
import { computeSessionStatistics, StatisticsCollector } from "./statistics"
import type { Session } from "./types"

export interface ExportSummary {
  outDir: string
  exported: number
  projects: number
  // Where the exporter looked, for the "found nothing" explanation.
  dbPath: string
}

export type StatusReporter = (message: string) => void

// Exports every top-level session into the hub's per-project layout:
// <agent-logs>/<project>/codev-code/<timestamp>-<slug>.md, plus a
// statistics.json per project dir, from the local sqlite store. Unlike the hub
// (which exports only the launch cwd's project), the standalone uploader owns
// the whole store. Work (sandbox) sessions are not exported as logs — they
// are reported through the stats push only (see server-source.ts).
export async function runExport(onStatus: StatusReporter = () => {}): Promise<ExportSummary> {
  const dbPath = sessionDbPath()
  const summary: ExportSummary = { outDir: agentLogsDir(), exported: 0, projects: 0, dbPath }

  onStatus("Reading codev sessions...")
  const sessions: Session[] = []
  try {
    sessions.push(...readAllSessions(dbPath))
  } catch (err) {
    // A store we can't read exports nothing from it this run; the next run
    // retries.
    logWarn("session store read failed", { err, extra: { db_path: dbPath } })
  }

  if (sessions.length === 0) {
    logDebug("no sessions to export", { extra: { db_path: dbPath } })
    return summary
  }

  const baseUrl = readCodevCodeBaseUrl()
  const byProject = new Map<string, Session[]>()
  for (const session of sessions) {
    const dir = projectLogsDir(session.projectDir)
    const group = byProject.get(dir)
    if (group) group.push(session)
    else byProject.set(dir, [session])
  }

  for (const [projectDir, group] of byProject) {
    onStatus(`Writing ${group.length} session(s)...`)
    const agentDir = join(projectDir, "codev-code")
    mkdirSync(agentDir, { recursive: true })
    const stats = new StatisticsCollector()
    for (const session of group) {
      session.baseUrl = baseUrl
      const md = renderMarkdown(session)
      writeFileSync(join(agentDir, buildFilename(session)), md)
      stats.add(session.id, computeSessionStatistics(session, md))
      summary.exported++
    }
    stats.flush(join(projectDir, "statistics.json"))
    summary.projects++
  }

  logInfo(`exported ${summary.exported} session(s) across ${summary.projects} project(s)`, {
    outcome: "success",
    extra: { exported: summary.exported, projects: summary.projects },
  })
  return summary
}
