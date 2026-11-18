import { spawn as nodeSpawn } from "node:child_process"
import { existsSync } from "node:fs"
import { authFilePath } from "@codev/gateway"
import { currentTraceId, statsLog } from "./log"
import { metricsDisabled } from "./nudge"

// The launch-side half of the background stats push: fire-and-forget a
// detached `codev debug stats` child. Split from daemon.ts so the TUI can
// import it (via the `@codev/upload/spawn` subpath — the configure dialog
// respawns the daemon after a fresh sign-in) without dragging sqlite and the
// whole pipeline into its module graph.

// Test seam (codev-gateway/hub convention).
export const spawner = {
  spawn: nodeSpawn,
}

// Bun standalone executables run their entry from a virtual bunfs path; a
// spawned child must then get only the CLI args. In dev (bun run src/index.ts)
// the script path has to ride along.
function selfInvocation(): string[] {
  const script = process.argv[1]
  if (!script || script.startsWith("/$bunfs/") || script.startsWith("B:/~BUN/") || script.startsWith("B:\\~BUN\\")) {
    return []
  }
  return [script]
}

// Fire-and-forget `codev debug stats`, detached and unref'd so the agent
// starts immediately and the push survives a quick exit. Never blocks or
// fails the agent launch.
export function spawnStatsDaemon(): void {
  if (metricsDisabled()) return
  // Cheap pre-gate: no auth file means no session and no refresh token — the
  // child would only start up to skip. The child re-checks properly.
  if (!existsSync(authFilePath())) return
  try {
    const child = spawner.spawn(process.execPath, [...selfInvocation(), "debug", "stats"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, CODEV_TRACE_PARENT: currentTraceId() },
    })
    child.unref()
    statsLog.debug("spawned stats daemon", { extra: { pid: child.pid ?? null } })
  } catch (err) {
    statsLog.warn("could not spawn stats daemon", { err })
  }
}
