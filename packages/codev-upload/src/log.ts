import { randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { uploadLogDir } from "./paths"

// The uploader's own NDJSON diagnostics — what `codev upload --diagnostics`
// prints. One file set per command: `upload` for the session-log upload,
// `stats` for the usage-metrics push.
// Ground rules ported from the hub's lib/log.ts: (1) logging can never break
// or block an upload — every disk touch is wrapped and degrades to a no-op;
// (2) no secrets on disk — the serialized line is scrubbed before writing;
// (3) nothing goes to stdout/stderr from here.

const MAX_AGE_DAYS = 14

// One trace id per process; the detached daemon carries its spawner's id in
// CODEV_TRACE_PARENT so `--diagnostics` can tie the chain together.
const traceId = randomBytes(8).toString("hex")
const parentTraceId = process.env.CODEV_TRACE_PARENT || undefined

export function currentTraceId(): string {
  return traceId
}

// Hub SCRUB_PATTERNS parity — one definition of "this must never hit disk".
const SCRUB_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/eyJ[\w-]{4,}\.[\w-]{4,}(?:\.[\w-]+)?/g, "[REDACTED:jwt]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED:key]"],
  [
    /([?&](?:code|state|token|apikey|api_key|access_token|refresh_token|id_token|signature|sig|x-amz-[a-z-]+)=)[^&"\\\s]+/gi,
    "$1[REDACTED]",
  ],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [re, replacement] of SCRUB_PATTERNS) {
    out = out.replace(re, replacement)
  }
  return out
}

export type LogCommand = "upload" | "stats"

export interface UploadLogDoc {
  "@timestamp": string
  log: { level: string }
  message: string
  trace: { id: string }
  codev: { command: LogCommand; parent_trace_id?: string; [key: string]: unknown }
  event?: { outcome?: string }
  error?: { message?: string }
}

function fileFor(command: LogCommand, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return join(
    uploadLogDir(),
    `${command}-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.ndjson`,
  )
}

let initialized = false
function ensureInit(): void {
  if (initialized) return
  initialized = true
  try {
    mkdirSync(uploadLogDir(), { recursive: true })
    prune()
  } catch {
    // Best-effort — a failed init just means writes below no-op too.
  }
}

// Drop upload-*/stats-*.ndjson files older than the retention window. Only
// this package's own file patterns are ever touched.
function prune(): void {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(uploadLogDir())) {
    const m = name.match(/^(?:upload|stats)-(\d{4})(\d{2})(\d{2})\.ndjson$/)
    if (!m) continue
    const stamp = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (stamp < cutoff) {
      try {
        rmSync(join(uploadLogDir(), name), { force: true })
      } catch {
        // Best-effort.
      }
    }
  }
}

type LogFields = { outcome?: string; err?: unknown; extra?: Record<string, unknown> }

function write(command: LogCommand, level: string, message: string, fields?: LogFields): void {
  try {
    ensureInit()
    const doc: UploadLogDoc = {
      "@timestamp": new Date().toISOString(),
      log: { level },
      message,
      trace: { id: traceId },
      codev: { command, ...(parentTraceId ? { parent_trace_id: parentTraceId } : {}), ...fields?.extra },
      ...(fields?.outcome ? { event: { outcome: fields.outcome } } : {}),
      ...(fields?.err !== undefined
        ? { error: { message: fields.err instanceof Error ? fields.err.message : String(fields.err) } }
        : {}),
    }
    appendFileSync(fileFor(command, new Date()), `${redactSecrets(JSON.stringify(doc))}\n`)
  } catch {
    // Logging must never break the upload.
  }
}

export function createLogger(command: LogCommand) {
  return {
    debug: (message: string, fields?: LogFields) => write(command, "debug", message, fields),
    info: (message: string, fields?: LogFields) => write(command, "info", message, fields),
    warn: (message: string, fields?: LogFields) => write(command, "warn", message, fields),
    error: (message: string, fields?: LogFields) => write(command, "error", message, fields),
  }
}

const uploadLog = createLogger("upload")
export const { debug: logDebug, info: logInfo, warn: logWarn, error: logError } = uploadLog
export const statsLog = createLogger("stats")
