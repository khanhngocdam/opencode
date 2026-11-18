import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { type AuthData, fetchCodevConfig, saveCodevConfig, supabaseExchange } from "@codev/gateway"
import { readCodevCodeBaseUrl } from "./config"
import { readAllSessionStats } from "./db"
import { statsLog } from "./log"
import { networkVolumeFilter } from "./network"
import { sessionDbPath, statsSentPath } from "./paths"
import { readSessionStatsFromServer, type ServerSource } from "./server-source"
import { STATS_VERSION, type SessionStats } from "./stats"
import { getAnalysisBackendConfig, isRefreshableError } from "./upload"

// The usage-metrics push: build a stats record per session (local store plus
// any sandbox servers), skip the ones whose record hashes the same as last
// time, and POST the rest in batches to the analysis backend's
// upload-session-stats function. The SSO exchange and the refresh-retry
// trigger are the session-log upload's (upload.ts).

export interface StatsClient {
  app: "cli" | "desktop"
  version: string
}

export interface PushOptions {
  client: StatsClient
  // Re-send every record even when it is unchanged. Wired to
  // `codev upload --force`.
  force?: boolean
  onStatus?: (message: string) => void
  // Resolves the SSO session; null aborts with a sign-in hint.
  getAuth: () => Promise<AuthData | null>
  // Running sandbox servers whose work sessions to include (desktop only —
  // see server-source.ts).
  servers?: ServerSource[]
  // Test seam (codev-gateway FetchOptions convention).
  fetchImpl?: typeof fetch
}

export interface PushSummary {
  found: number
  sent: number
  unchanged: number
  // The backend has no upload-session-stats function yet (404). Nothing was
  // sent; the next run retries.
  unsupported?: boolean
}

const BATCH_SIZE = 200
const REQUEST_TIMEOUT_MS = 60_000

export async function pushSessionStats(options: PushOptions): Promise<PushSummary> {
  const fetchImpl = options.fetchImpl ?? fetch
  options.onStatus?.("Reading sessions...")
  const records = await collectStats(options.servers ?? [], fetchImpl)
  const sent = options.force ? {} : readSentHashes()
  const pending = records.flatMap((record) => {
    const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex")
    return sent[record.session_id] === hash ? [] : [{ record, hash }]
  })
  const summary: PushSummary = { found: records.length, sent: 0, unchanged: records.length - pending.length }
  if (pending.length === 0) return summary

  const auth = await options.getAuth()
  if (!auth) throw new Error("Not signed in. Run `codev upload` interactively to sign in first.")

  const send = async () => {
    const config = getAnalysisBackendConfig()
    options.onStatus?.("Exchanging SSO session for analysis backend session...")
    const session = await supabaseExchange(auth.access_token, { fetchImpl })
    // A retry after a config refresh resumes where the failed attempt stopped.
    const unsent = pending.filter((item) => sent[item.record.session_id] !== item.hash)
    for (let start = 0; start < unsent.length; start += BATCH_SIZE) {
      const batch = unsent.slice(start, start + BATCH_SIZE)
      options.onStatus?.(`Sending ${start + batch.length}/${unsent.length} session(s)...`)
      const res = await fetchImpl(`${config.url}/functions/v1/upload-session-stats`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          v: STATS_VERSION,
          client: { ...options.client, base_url: readCodevCodeBaseUrl() },
          sessions: batch.map((item) => item.record),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.status === 404) {
        summary.unsupported = true
        return
      }
      if (!res.ok) throw new Error(`upload-session-stats failed (${res.status}): ${await res.text()}`)
      // Recorded per batch, so a failure later in the run keeps what landed.
      for (const item of batch) sent[item.record.session_id] = item.hash
      writeSentHashes(sent)
      summary.sent += batch.length
    }
  }

  try {
    await send()
  } catch (err) {
    if (!isRefreshableError(err)) throw err
    statsLog.warn("refreshable stats push error; refreshing config and retrying", { err })
    saveCodevConfig(await fetchCodevConfig(auth.access_token, { fetchImpl }))
    await send()
  }
  return summary
}

// Every source is best-effort: an unreadable store or a sandbox that went
// down mid-run costs only its own records this run.
async function collectStats(servers: ServerSource[], fetchImpl: typeof fetch): Promise<SessionStats[]> {
  const onNetworkVolume = networkVolumeFilter()
  const records: SessionStats[] = []
  try {
    records.push(...readAllSessionStats(sessionDbPath(), onNetworkVolume))
  } catch (err) {
    statsLog.warn("session store read failed", { err, extra: { db_path: sessionDbPath() } })
  }
  for (const server of servers) {
    try {
      records.push(...(await readSessionStatsFromServer(server, fetchImpl, onNetworkVolume)))
    } catch (err) {
      statsLog.warn("sandbox server read failed", { err })
    }
  }
  return records
}

function readSentHashes(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(statsSentPath(), "utf-8")) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeSentHashes(sent: Record<string, string>): void {
  mkdirSync(dirname(statsSentPath()), { recursive: true })
  writeFileSync(statsSentPath(), JSON.stringify(sent))
}
