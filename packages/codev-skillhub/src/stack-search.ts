import { stripControlChars } from "./sanitize"
import { browseStacks, ownerLabel, type StackCard } from "./stack"

export const DEFAULT_STACK_LIMIT = 20
const DESCRIPTION_MAX = 90

// `codev skill stack list [query] [--json] [--limit <n>]`. Plain console output
// so results pipe cleanly and `--json` is script-friendly. Arg parsing lives in
// the CLI's yargs layer; this runner takes the parsed values and returns the
// exit code.
export async function runStackList(opts: { query?: string; limit?: number; json: boolean }): Promise<number> {
  const result = await browseStacks({
    search: opts.query,
    limit: opts.limit ?? DEFAULT_STACK_LIMIT,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  if (!result.ok) {
    console.error(result.error instanceof Error ? result.error.message : String(result.error))
    return 1
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, total: result.value.pagination.total, items: result.value.items }))
    return 0
  }
  if (result.value.items.length === 0) {
    console.log(opts.query ? `No stacks match "${opts.query}".` : "No public stacks yet.")
    return 0
  }
  console.log(formatStacks(result.value.pagination.total, result.value.items))
  return 0
}

function formatStacks(total: number, items: StackCard[]): string {
  const lines = [`Found ${total} stack(s) — showing ${items.length}:`, ""]
  for (const stack of items) {
    // Hub-sourced fields are sanitized before printing (see stripControlChars).
    const name = stripControlChars(stack.name)
    const counts = `${stack.skillCount} skill(s), ${stack.memberCount} member(s)`
    lines.push(`  ${name} by ${stripControlChars(ownerLabel(stack.owner))} — ${counts}`)
    const description = stripControlChars(stack.description)
    const trimmed =
      description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 3)}...` : description
    if (trimmed) lines.push(`    ${trimmed}`)
    // The slug, not the id: it is what `skill stack pull` takes.
    lines.push(`    slug: ${stripControlChars(stack.slug)}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}
