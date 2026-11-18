import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs"
import { basename, join } from "node:path"
import { gzipSync } from "node:zlib"
import {
  type AuthData,
  type CodevConfig,
  fetchCodevConfig,
  loadCodevConfig,
  saveCodevConfig,
  supabaseExchange,
} from "@codev/gateway"
import { runExport, type StatusReporter } from "./export"
import { logDebug, logError, logInfo, logWarn } from "./log"
import { agentLogsDir } from "./paths"

// The wire pipeline, ported from the hub's src/lib/upload.ts: exchange the
// SSO session for an analysis-backend session, page prior uploads for dedup,
// then presign → PUT gzipped markdown → confirm per new/changed file. The
// shapes on the wire, the dedup keying (absolute path + sha256), and the
// refresh-retry trigger are contracts shared with the hub — change them there
// or not at all.

export interface UploadOptions {
  // Re-upload every exported log even when its hash matches a prior upload.
  // The previous-version link is still sent, so a forced re-upload supersedes
  // instead of duplicating. Wired to `codev upload --logs --force`.
  force?: boolean
  onStatus?: StatusReporter
  // Resolves the SSO session. The daemon passes a silent resolver and
  // pre-gates on it; the interactive command runs a browser login. A resolver
  // returning null aborts with a sign-in hint.
  getAuth: () => Promise<AuthData | null>
  // Test seam (codev-gateway FetchOptions convention).
  fetchImpl?: typeof fetch
}

export interface UploadSummary {
  outDir: string
  found: number
  uploaded: number
  skipped: number
  failed: number
  errors: { file: string; message: string }[]
  // Populated when found === 0: where the exporter looked, so the UI can
  // explain an empty result instead of a bare "Uploaded 0/0".
  dbPath?: string
}

interface PresignResponse {
  uploadUrl: string
  conversationId: string
  storagePath: string
}

export interface ExistingConversation {
  id: string
  local_file_path: string | null
  local_content_hash: string | null
  uploaded_at: string | null
}

interface UploadCandidate {
  path: string
  hash: string
  previousVersionId: string
}

const UPLOAD_TIMEOUT_MS = 60_000

// PostgREST caps responses per deployment (commonly 1000); page until a short
// page or the safety cap (hub parity — without paging, heavy users re-upload
// on every run).
const PAGE_SIZE = 1000
const MAX_PAGES = 100

export async function runUpload(options: UploadOptions): Promise<UploadSummary> {
  const fetchImpl = options.fetchImpl ?? fetch
  // Tee every status line into the diagnostic log so a failed run can be
  // reconstructed from `codev upload --logs --diagnostics` alone.
  const status = (message: string) => {
    logDebug(message)
    options.onStatus?.(message)
  }

  status("Exporting codev sessions...")
  const exportSummary = await runExport(status)

  const outDir = agentLogsDir()
  const files = listMarkdownLogs(outDir)
  if (files.length === 0) {
    return {
      outDir,
      found: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      dbPath: exportSummary.dbPath,
    }
  }

  const auth = await options.getAuth()
  if (!auth) {
    throw new Error("Not signed in. Run `codev configure` (or `codev upload --logs` interactively) to sign in first.")
  }

  // Try once; on a refreshable failure (missing cached config, or the backend
  // rejecting our credentials) refresh the CoDev config and retry exactly
  // once. 5xx/network errors/timeouts are not retried — refreshing won't help
  // and we'd amplify the outage (hub parity).
  try {
    return await runBackendUpload(outDir, files, auth, status, options.force ?? false, fetchImpl)
  } catch (err) {
    if (!isRefreshableError(err)) {
      logError("upload failed", { err })
      throw err
    }
    logWarn("refreshable upload error; refreshing config and retrying", { err })
    status("Refreshing CoDev config and retrying...")
    saveCodevConfig(await fetchCodevConfig(auth.access_token, { fetchImpl }))
    try {
      return await runBackendUpload(outDir, files, auth, status, options.force ?? false, fetchImpl)
    } catch (retryErr) {
      logError("upload failed after config refresh", { err: retryErr })
      throw retryErr
    }
  }
}

async function runBackendUpload(
  outDir: string,
  files: string[],
  auth: AuthData,
  onStatus: StatusReporter,
  force: boolean,
  fetchImpl: typeof fetch,
): Promise<UploadSummary> {
  const summary: UploadSummary = {
    outDir,
    found: files.length,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  const config = getAnalysisBackendConfig()
  onStatus("Exchanging SSO session for analysis backend upload session...")
  const session = await supabaseExchange(auth.access_token, { fetchImpl })
  const uploadToken = session.access_token
  onStatus("Checking existing uploads...")
  const existing = await fetchExistingUploads(config, uploadToken, fetchImpl)
  const candidates = filterNewFiles(files, existing, force)
  summary.skipped = files.length - candidates.length

  for (const candidate of candidates) {
    onStatus(`Uploading ${basename(candidate.path)}...`)
    try {
      await uploadFile(config, uploadToken, candidate, fetchImpl)
      summary.uploaded++
      logDebug(`uploaded ${basename(candidate.path)}`, {
        outcome: "success",
        extra: { file: basename(candidate.path) },
      })
    } catch (err) {
      summary.failed++
      summary.errors.push({ file: candidate.path, message: String(err) })
      logWarn(`upload failed: ${basename(candidate.path)}`, {
        outcome: "failure",
        err,
        extra: { file: candidate.path },
      })
    }
  }
  logInfo(
    `upload summary: ${summary.uploaded}/${summary.found} uploaded, ${summary.skipped} skipped, ${summary.failed} failed`,
    {
      outcome: summary.failed === 0 ? "success" : "failure",
      extra: { found: summary.found, uploaded: summary.uploaded, skipped: summary.skipped, failed: summary.failed },
    },
  )
  return summary
}

export interface AnalysisBackendConfig {
  url: string
  anonKey: string
}

// The "Missing supabase_" prefix is the on-disk key name and is exactly what
// isRefreshableError matches — the hub's contract, kept verbatim. Shared with
// the stats push (push.ts), which talks to the same backend.
export function getAnalysisBackendConfig(): AnalysisBackendConfig {
  const config: CodevConfig | null = loadCodevConfig()
  if (!config) {
    throw new Error("Missing supabase_url/supabase_anon_key in the CoDev auth file")
  }
  return { url: config.supabaseUrl.replace(/\/+$/, ""), anonKey: config.supabaseAnonKey }
}

// Narrow refresh trigger: empty cache, or a 401/403 from the analysis backend
// or CoDev backend. Anchored to the `failed (NNN)` shape every thrower here
// and in codev-gateway emits (hub parity).
export function isRefreshableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("Missing supabase_")) return true
  const match = msg.match(/failed \((\d{3})\)/)
  if (!match?.[1]) return false
  const stat = Number.parseInt(match[1], 10)
  return stat === 401 || stat === 403
}

// Every exported codev-code markdown across every project folder. The hub
// walks one project and four agents; the standalone uploader walks every
// project and exactly its own agent dir.
export function listMarkdownLogs(outDir: string): string[] {
  const files: string[] = []
  let projects: string[]
  try {
    projects = readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  for (const project of projects) {
    const dir = join(outDir, project, "codev-code")
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(join(dir, entry.name))
      }
    }
  }
  return files.sort()
}

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function filterNewFiles(
  paths: string[],
  existing: Map<string, ExistingConversation>,
  force = false,
): UploadCandidate[] {
  const out: UploadCandidate[] = []
  for (const path of paths) {
    const abs = realpathSync(path)
    const hash = fileSha256(abs)
    const previous = existing.get(abs)
    // An unchanged file (hash matches the stored row) is skipped unless
    // forcing; either way the previous version id rides along so a re-upload
    // supersedes rather than duplicates.
    if (!force && previous?.local_content_hash === hash) continue
    out.push({ path: abs, hash, previousVersionId: previous?.id ?? "" })
  }
  return out
}

async function fetchExistingUploads(
  config: AnalysisBackendConfig,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Map<string, ExistingConversation>> {
  const byPath = new Map<string, ExistingConversation>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const url = new URL(`${config.url}/rest/v1/conversations`)
    url.searchParams.set("select", "id,local_file_path,local_content_hash,uploaded_at")
    url.searchParams.set("order", "uploaded_at.desc")
    const res = await fetchImpl(url, {
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        // count=exact is expensive on big tables; a short page tells us when
        // we're done.
        Prefer: "count=none",
        Range: `${from}-${to}`,
      },
      // Per-page timeout: a hung endpoint must not hold the upload lock until
      // the stale reclaim.
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`conversations API failed (${res.status}): ${await res.text()}`)
    }
    const rows = (await res.json()) as ExistingConversation[]
    for (const row of rows) {
      if (row.local_file_path && !byPath.has(row.local_file_path)) {
        byPath.set(row.local_file_path, row)
      }
    }
    if (rows.length < PAGE_SIZE) break
  }
  return byPath
}

async function uploadFile(
  config: AnalysisBackendConfig,
  accessToken: string,
  candidate: UploadCandidate,
  fetchImpl: typeof fetch,
): Promise<void> {
  const filename = basename(candidate.path)
  const stat = statSync(candidate.path)
  const presign = await presignUpload(config, accessToken, filename, fetchImpl)
  await putGzip(candidate.path, presign.uploadUrl, fetchImpl)
  await confirmUpload(config, accessToken, presign, candidate, stat, fetchImpl)
}

async function presignUpload(
  config: AnalysisBackendConfig,
  accessToken: string,
  filename: string,
  fetchImpl: typeof fetch,
): Promise<PresignResponse> {
  const res = await fetchImpl(`${config.url}/functions/v1/presign-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`presign-upload failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as PresignResponse
}

async function putGzip(path: string, uploadUrl: string, fetchImpl: typeof fetch): Promise<void> {
  const payload = gzipSync(readFileSync(path))
  const res = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "text/markdown",
      "Content-Encoding": "gzip",
    },
    body: payload,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`signed upload failed (${res.status}): ${await res.text()}`)
  }
}

async function confirmUpload(
  config: AnalysisBackendConfig,
  accessToken: string,
  presign: PresignResponse,
  candidate: UploadCandidate,
  stat: Stats,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(`${config.url}/functions/v1/confirm-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversationId: presign.conversationId,
      storagePath: presign.storagePath,
      filename: basename(candidate.path),
      fileSizeBytes: stat.size,
      fileFormat: "markdown",
      fileLastModified: stat.mtime.toISOString(),
      localFilePath: candidate.path,
      localContentHash: candidate.hash,
      previousVersionId: candidate.previousVersionId,
      encoding: "gzip",
    }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`confirm-upload failed (${res.status}): ${await res.text()}`)
  }
}
