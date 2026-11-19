#!/usr/bin/env bun
import { $ } from "bun"

// Fork-only: `bun bump [version]` — same rule as Codev v1.
// Source of truth is packages/cli/package.json (v2 CLI publish surface).
// No arg → increment numeric revision: 2.3.0 → 2.3.0-1 → 2.3.0-2.
// Fork-only packages on their own versions are skipped automatically.

const root = `${import.meta.dirname}/..`
const current = (await Bun.file(`${root}/packages/cli/package.json`).text()).match(/"version": "([^"]+)"/)?.[1]

if (!current) {
  console.error(`packages/cli/package.json has no "version" field — nothing to bump from.`)
  process.exit(1)
}

const VALID = /^\d+\.\d+\.\d+(-[\w.]+)?$/
const next = process.argv[2] ?? nextRevision(current)

if (!next) {
  console.error(
    `Cannot auto-increment ${JSON.stringify(current)}: it has no numeric revision suffix.\n` +
      `Pass the target explicitly, e.g. \`bun bump ${current.split("-")[0]}-1\`.`,
  )
  process.exit(1)
}

if (!VALID.test(next)) {
  console.error(`${JSON.stringify(next)} is not a valid version. Expected e.g. 2.3.0 or 2.3.0-1.`)
  process.exit(1)
}

if (next === current) {
  console.error(`Already at ${current} — nothing to do.`)
  process.exit(1)
}

const needle = `"version": "${current}"`
const files = (await $`git ls-files ${"*package.json"}`.cwd(root).text()).trim().split("\n")
const bumped = (
  await Promise.all(
    files.map(async (file) => {
      const text = await Bun.file(`${root}/${file}`).text()
      if (!text.includes(needle)) return undefined
      await Bun.write(`${root}/${file}`, text.replaceAll(needle, `"version": "${next}"`))
      return file
    }),
  )
).filter((file) => file !== undefined)

if (!bumped.length) {
  console.error(`No manifest carries ${needle}. Is packages/cli/package.json out of lockstep?`)
  process.exit(1)
}

console.log(`Bumped ${current} → ${next} across ${bumped.length} manifests:`)
for (const file of bumped) console.log(`  ${file}`)

console.log("\nRegenerating bun.lock…")
await $`bun install`.cwd(root)

// Only package manifests must move in lockstep. Provenance files such as
// codev.upstream.json keep the bare upstream base (e.g. 2.3.0) on purpose.
const leftover = (
  await Promise.all(
    files.map(async (file) => {
      const text = await Bun.file(`${root}/${file}`).text()
      return text.includes(needle) ? file : undefined
    }),
  )
).filter((file) => file !== undefined)
if (leftover.length) {
  console.error(`\nStill on ${current} after the bump:\n${leftover.join("\n")}`)
  process.exit(1)
}

console.log(`\nNow at ${next}. Commit the manifests and bun.lock together:`)
console.log(`  git commit -am ${JSON.stringify(`chore: bump version to ${next}`)}`)

function nextRevision(version: string) {
  const match = version.match(/^(\d+\.\d+\.\d+)(?:-(\d+))?$/)
  if (!match) return undefined
  return `${match[1]}-${Number(match[2] ?? 0) + 1}`
}
