import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { silentSso } from "@codev/gateway"
import { statsLog } from "./log"
import { metricsDisabled, type StatsStatus } from "./nudge"
import { statsLockPath, statsStatusPath } from "./paths"
import { pushSessionStats, type PushOptions, type PushSummary } from "./push"
import type { ServerSource } from "./server-source"

// Stats-push runner: `codev debug stats` and the desktop sidecar execute
// runStartupStats; the interactive `codev upload` calls runLockedPush with a
// browser login. The launch-side spawn lives in spawn.ts and the nudge
// gates/status shape in nudge.ts (both TUI-importable subpaths). One lockfile
// is shared by every pusher, so the desktop and the CLI never push
// concurrently.

const STALE_LOCK_MS = 60 * 60 * 1000

interface LockContents {
  pid: number
  startedAt: string
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function tryAcquireLock(): boolean {
  const path = statsLockPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx")
      const lock: LockContents = { pid: process.pid, startedAt: new Date().toISOString() }
      writeFileSync(fd, JSON.stringify(lock))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false
      let prior: LockContents | null = null
      try {
        prior = JSON.parse(readFileSync(path, "utf-8")) as LockContents
      } catch {
        prior = null
      }
      const ageMs = prior ? Date.now() - new Date(prior.startedAt).getTime() : Number.POSITIVE_INFINITY
      if (prior && Number.isFinite(ageMs) && ageMs < STALE_LOCK_MS && isPidAlive(prior.pid)) {
        return false
      }
      try {
        unlinkSync(path)
      } catch {
        // Race with another release; loop and retry the create.
      }
    }
  }
  return false
}

export function releaseLock(): void {
  try {
    unlinkSync(statsLockPath())
  } catch {
    // Already gone.
  }
}

function writeStatus(status: StatsStatus): void {
  try {
    const path = statsStatusPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(status, null, 2))
  } catch {
    // Best-effort.
  }
}

// One push under the shared lock, its outcome recorded in stats-status.json.
// Returns null when another push holds the lock; rethrows a failed push after
// recording it.
export async function runLockedPush(options: PushOptions): Promise<PushSummary | null> {
  if (!tryAcquireLock()) {
    statsLog.info("stats push skipped: another push is in progress", { extra: { reason: "lock-held" } })
    return null
  }
  const startedAt = new Date().toISOString()
  statsLog.info("starting stats push", { extra: { app: options.client.app, force: options.force ?? false } })
  try {
    const summary = await pushSessionStats(options)
    writeStatus({ ok: true, startedAt, finishedAt: new Date().toISOString(), summary })
    statsLog.info(
      summary.unsupported
        ? "stats push: backend has no upload-session-stats endpoint yet"
        : `stats push done: sent=${summary.sent} unchanged=${summary.unchanged}`,
      { outcome: "success", extra: { ...summary } },
    )
    return summary
  } catch (err) {
    statsLog.warn("stats push failed", { outcome: "failure", err })
    writeStatus({
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  } finally {
    releaseLock()
  }
}

// The daemon entry (`codev debug stats`, the desktop sidecar). Gates in
// order: opt-out env, signed-in (silent SSO — refreshes an expired session,
// never opens a browser), then the shared lock. Returns the process exit code.
export async function runStartupStats(options: {
  client: PushOptions["client"]
  servers?: ServerSource[]
}): Promise<number> {
  const startedAt = new Date().toISOString()
  if (metricsDisabled()) {
    statsLog.info("stats push skipped: CODEV_DISABLE_METRICS is set", { extra: { reason: "disabled" } })
    return 0
  }
  const auth = await silentSso()
  if (!auth) {
    statsLog.info("stats push skipped: not signed in", { extra: { reason: "not-logged-in" } })
    // Record the stall: the agent keeps working on the gateway api key alone,
    // so without this marker nothing would ever tell the user their usage
    // reporting stopped. The TUI and desktop read it via nudge.ts and show a
    // sign-in toast. The other skips deliberately write nothing — disabled is
    // an explicit opt-out, and lock-held means another push is running and
    // will write the real outcome.
    writeStatus({ ok: false, skipped: "not-logged-in", startedAt, finishedAt: new Date().toISOString() })
    return 0
  }
  return runLockedPush({ client: options.client, servers: options.servers, getAuth: async () => auth }).then(
    () => 0,
    () => 1,
  )
}
