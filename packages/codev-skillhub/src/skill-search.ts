import { stripControlChars } from "./sanitize"
import { listHubSkills, type HubSkill } from "./skillhub"

export const DEFAULT_SEARCH_LIMIT = 20
const DESCRIPTION_MAX = 90

// `codev skill search <query> [--json] [--limit <n>]`. Plain console output so
// results pipe cleanly and `--json` is script-friendly. Arg parsing lives in
// the CLI's yargs layer; this runner takes the parsed values and returns the
// exit code.
export async function runSkillSearch(opts: { query: string; limit?: number; json: boolean }): Promise<number> {
  try {
    const { total, items } = await listHubSkills({
      search: opts.query,
      limit: opts.limit ?? DEFAULT_SEARCH_LIMIT,
    })

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, total, items }))
      return 0
    }
    if (items.length === 0) {
      console.log(`No skills match "${opts.query}".`)
      return 0
    }
    console.log(formatResults(total, items))
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}

function formatResults(total: number, items: HubSkill[]): string {
  const lines = [`Found ${total} skill(s) — showing ${items.length}:`, ""]
  for (const s of items) {
    // Hub-sourced fields are sanitized before printing (see stripControlChars).
    const name = stripControlChars(s.name)
    const version = stripControlChars(s.version)
    const provider = stripControlChars(s.provider)
    lines.push(`  ${name}@${version} by ${provider}`)
    const desc = stripControlChars(s.description ?? "")
    const trimmed = desc.length > DESCRIPTION_MAX ? `${desc.slice(0, DESCRIPTION_MAX - 3)}...` : desc
    if (trimmed) lines.push(`    ${trimmed}`)
    lines.push(`    id: ${stripControlChars(s.id)}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}
