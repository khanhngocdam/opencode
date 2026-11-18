import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { currentTraceId, type LogCommand, type UploadLogDoc } from "./log"
import { uploadLogDir } from "./paths"

// Reader side of the uploader's diagnostics (`codev upload --diagnostics`),
// modeled on `codevhub logs`: print the most recent run, where a run is every
// document sharing one trace id — plus any child runs pointing at it via
// parent_trace_id (the detached daemon). Plain text out; by the time someone
// reaches for this something already went wrong, so no ceremony.

function listLogFiles(command: LogCommand): string[] {
  try {
    return readdirSync(uploadLogDir())
      .filter((name) => name.startsWith(`${command}-`) && /-\d{8}\.ndjson$/.test(name))
      .sort()
      .map((name) => join(uploadLogDir(), name))
  } catch {
    return []
  }
}

function readDocs(command: LogCommand): UploadLogDoc[] {
  const docs: UploadLogDoc[] = []
  for (const file of listLogFiles(command)) {
    let raw: string
    try {
      raw = readFileSync(file, "utf-8")
    } catch {
      continue
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        docs.push(JSON.parse(line) as UploadLogDoc)
      } catch {
        // Skip torn/corrupt lines.
      }
    }
  }
  return docs
}

function formatDoc(doc: UploadLogDoc): string {
  const ts = doc["@timestamp"] ?? ""
  const level = (doc.log?.level ?? "info").toUpperCase().padEnd(5)
  const outcome = doc.event?.outcome ? ` [${doc.event.outcome}]` : ""
  const error = doc.error?.message ? ` — ${doc.error.message}` : ""
  return `${ts} ${level} ${doc.message ?? ""}${outcome}${error}`
}

// Renders the most recent run's log lines for one command (`upload` for the
// session-log upload, `stats` for the metrics push). Returns null when there
// is nothing to show. The current process's own trace is excluded — `codev
// upload --diagnostics` must show the last real run, not itself.
export function renderLastRun(command: LogCommand): string | null {
  const docs = readDocs(command).filter((d) => d.trace?.id && d.trace.id !== currentTraceId())
  if (docs.length === 0) return null
  const lastTrace = docs[docs.length - 1].trace.id
  // The run is the last trace plus anything in its parent/child chain.
  const related = new Set([lastTrace])
  for (const doc of docs) {
    const parent = doc.codev?.parent_trace_id
    if (parent && (related.has(parent) || related.has(doc.trace.id))) {
      related.add(parent)
      related.add(doc.trace.id)
    }
  }
  const lines = docs.filter((d) => related.has(d.trace.id)).map(formatDoc)
  return lines.join("\n")
}
