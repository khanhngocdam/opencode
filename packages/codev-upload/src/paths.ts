import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import type { Session } from "./types"

// TODO(hub-retirement): ~/.codev-hub/ is transitional. When CoDev Hub is
// retired, migrate the uploader's data home to ~/.codev/:
//   1. Rename ~/.codev-hub/agent-logs/ -> ~/.codev/agent-logs/ (one-time,
//      best-effort; exports regenerate from the session store on failure).
//   2. Re-key server-side dedup: `conversations.local_file_path` stores the
//      old absolute paths, so the uploader must fall back to the legacy-path
//      lookup and send that row's id as previousVersionId once per file —
//      otherwise every user's history re-uploads as duplicates.
//   3. Make ~/.codev/auth.json primary in codev-gateway (fallback exists).
// Blocked on: hub retired (or its codev-code provider dropped) — migrating
// while the hub still uploads would re-diverge the paths.
// Tracking: https://github.com/quickbeard/codev-code/issues/310

// Home is resolved per call via CODEV_TEST_HOME (the codev-gateway/core
// convention) because Bun's homedir() ignores runtime HOME changes, which
// tests rely on.
function home(): string {
  return process.env.CODEV_TEST_HOME ?? homedir()
}

// Conversation exports — the exact layout `codevhub upload` writes and dedups
// against, byte-for-byte, so hub and agent uploads are interchangeable during
// coexistence. See TODO(hub-retirement) above.
export function agentLogsDir(): string {
  return join(home(), ".codev-hub", "agent-logs")
}

// Codev2 preview data home (XDG_DATA_HOME or ~/.local/share/codev2). Keep the
// SSO/auth file under ~/.codev(-hub) via @codev/gateway; only the session DB
// and uploader state live under the isolated Codev2 root.
export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return join(xdg, "codev2")
  return join(home(), ".local", "share", "codev2")
}

// Prefer the Codev2 channel DB when present; fall back to the plain filename
// used by v1 readers and early Codev2 installs.
export function sessionDbPath(): string {
  const channel = process.env.OPENCODE_CHANNEL
  if (channel && channel !== "prod") {
    const channelPath = join(dataDir(), `opencode-${channel}.db`)
    try {
      realpathSync(channelPath)
      return channelPath
    } catch {
      // fall through
    }
  }
  return join(dataDir(), "opencode.db")
}

// The uploader's own NDJSON diagnostics (`codev upload --logs`). Lives in the
// AGENT's log home, not ~/.codev-hub/logs — that file set belongs to the hub's
// writer, and sharing it would add another retirement dependency for nothing.
export function uploadLogDir(): string {
  return join(dataDir(), "log")
}

// Cross-process mutual exclusion for the stats push — desktop sidecar and CLI
// daemon share it, so two pushes never race on stats-sent.json.
export function statsLockPath(): string {
  return join(dataDir(), "stats.lock")
}

// Outcome snapshot of the most recent stats push; the sign-in nudge reads its
// `skipped` marker.
export function statsStatusPath(): string {
  return join(dataDir(), "stats-status.json")
}

// session id -> sha256 of the last record sent, so unchanged sessions are not
// re-sent.
export function statsSentPath(): string {
  return join(dataDir(), "stats-sent.json")
}

// Maps a project directory to its per-project export subfolder. Byte-for-byte
// port of the hub's projectFolderName (src/lib/paths.ts) — the folder name is
// half of the absolute local_file_path the backend dedups on.
// resolve: false skips realpathSync — the stats reader passes it for
// directories on a network volume, where resolving can hang on a dead mount.
export function projectFolderName(dir: string, options: { resolve?: boolean } = {}): string {
  const real = options.resolve === false ? platformNormalize(dir) : resolveDir(dir)
  const h = home()
  if (real === h) return "home"
  let stripped = real
  if (real.startsWith(`${h}${sep}`)) stripped = real.slice(h.length + 1)
  const mangled = stripped
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return mangled || "home"
}

function resolveDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    // The stored project dir may no longer exist (or be a POSIX-style Windows
    // path). Normalize to platform separators + drive-letter case so the
    // mangled name still matches what the hub computes from a live cwd.
    return platformNormalize(dir)
  }
}

// The session store records paths POSIX-style even on Windows
// ("C:/Users/me/project"), while the hub mangles realpathSync output
// ("C:\Users\me\project"). Without unifying, the home-prefix strip above
// misses on Windows and the two sides export to different folders — which the
// backend then treats as different conversations.
function platformNormalize(p: string): string {
  const drive = p.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
  if (sep === "\\") return drive.replace(/\//g, "\\")
  return drive
}

export function projectLogsDir(projectDir: string): string {
  return join(agentLogsDir(), projectFolderName(projectDir))
}

// YYYY-MM-DD_HH-MM-SSZ — UTC, filesystem-safe, sortable. Hub port.
export function formatUtcTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const yyyy = date.getUTCFullYear()
  const mm = pad(date.getUTCMonth() + 1)
  const dd = pad(date.getUTCDate())
  const hh = pad(date.getUTCHours())
  const mi = pad(date.getUTCMinutes())
  const ss = pad(date.getUTCSeconds())
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}Z`
}

export function buildFilename(session: Session): string {
  const ts = formatUtcTimestamp(session.createdAt)
  const slug = generateSlug(session.firstUserMessage ?? "")
  return slug ? `${ts}-${slug}.md` : `${ts}.md`
}

// Hub port (src/lib/paths.ts generateSlug) — filenames must match the hub's
// for the shared-layout dedup story to hold.
export function generateSlug(message: string): string {
  if (!message) return ""
  const normalized = message
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/@/g, " at ")
    .replace(/&/g, " and ")
    .replace(/#/g, " hash ")
    .replace(/[^a-z0-9\s]+/g, " ")
  const words = normalized.split(/\s+/).filter(Boolean).slice(0, 4)
  if (words.length === 0) return ""
  return words
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}
