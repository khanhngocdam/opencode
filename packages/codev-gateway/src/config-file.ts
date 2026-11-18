import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { applyEdits, modify } from "jsonc-parser"

// v2 config documents, lowest to highest priority; the last existing one wins writes
// (same rule as Config.update in @opencode/core).
const NAMES = ["opencode.json", "opencode.jsonc"]

const FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true } }

/**
 * Merge a config fragment (see buildGatewayConfig) into the global v2 config document while
 * preserving unrelated JSONC content. Each provider entry is replaced as a whole; other
 * top-level objects merge one level deep so user settings such as `compaction.reserved` survive.
 * v2's `config.update` API only patches `shell`, so provider config has to be written to the file;
 * the server's config watcher reloads it. Returns the file written.
 */
export function mergeConfigFragment(directory: string, fragment: Record<string, unknown>) {
  const file =
    NAMES.map((name) => join(directory, name))
      .filter(existsSync)
      .at(-1) ?? join(directory, "opencode.jsonc")
  const original = existsSync(file) ? readFileSync(file, "utf8") : "{}\n"
  const updated = Object.entries(fragment).reduce((text, [key, value]) => {
    const entries = isRecord(value) ? Object.entries(value) : []
    if (entries.length === 0) return edit(text, [key], value)
    return entries.reduce((text, [child, childValue]) => edit(text, [key, child], childValue), text)
  }, original)
  mkdirSync(directory, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, updated.endsWith("\n") ? updated : `${updated}\n`)
  renameSync(tmp, file)
  return file
}

function edit(text: string, path: string[], value: unknown) {
  return applyEdits(text, modify(text, path, value, FORMAT))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
