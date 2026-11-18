import { resolve } from "node:path"
import AdmZip from "adm-zip"
import { defaultAgents } from "./agents"
import { extractEntries, inspectZip, pathExists, SKILL_LIMITS, STACK_LIMITS } from "./archive"
import { stripControlChars } from "./sanitize"
import { claudeFollowsSymlinks, safeSegment, type Scope, type SkillAgent } from "./skill-dirs"
import {
  placeSkill,
  planPlacements,
  type InstallPlacement,
  type InstallTarget,
  type PlacementPlan,
} from "./skill-install"
import { downloadStack } from "./stack"

// Registry download behind an object so tests can stub it without module mocks
// (Bun spyOn on ESM namespaces is unreliable) — the package's own idiom, see
// skill-install.ts#skillhubApi.
export const stackApi = {
  downloadStack,
}

// Installing a Skill Stack: one composite ZIP from the hub, N skills onto disk.
//
// The hub composes the archive itself (skillhub src/services/namespace.service.ts
// #downloadAllSkills) as a single root folder named after the namespace slug:
//
//     <slug>/README.md            generated manifest, not a skill
//     <slug>/<skill-name>/...     one folder per PUBLIC skill, its own zip root
//                                 already stripped server-side
//
// Every skill is placed through skill-install.ts#placeSkill, so a stack lands in
// exactly the same agent directories, with the same linking and the same safety
// checks, as `skill pull` — the only thing that differs is where the bytes come
// from.

// A folder the archive carried that will not be installed, and why. Reported
// rather than dropped: a stack that quietly installs fewer skills than it
// advertises is worse than one that says what it left out.
export interface StackSkipped {
  name: string
  reason: string
}

export interface StackSkillEntry {
  name: string
  // This skill's entry-name prefix inside the archive, e.g. "data-eng/pg-tuner/".
  prefix: string
  files: number
  bytes: number
  entries: AdmZip.IZipEntry[]
}

export interface StackArchive {
  slug: string
  skills: StackSkillEntry[]
  skipped: StackSkipped[]
  totalBytes: number
  // The hub's generated README.md. Never installed — it documents the download,
  // not a skill — but worth surfacing.
  manifest?: string
}

// Parse a downloaded stack ZIP without writing anything. Throws only when the
// archive as a whole is unusable; an individual bad folder is reported in
// `skipped` so one malformed skill can't cost the user the other nineteen.
export function readStackArchive(buffer: Buffer, expectedSlug?: string): StackArchive {
  // Vet size/entry counts against the stack ceiling before inflating anything.
  inspectZip(buffer, STACK_LIMITS)
  const entries = new AdmZip(buffer).getEntries()

  const roots = new Set(entries.map((entry) => entry.entryName.split("/")[0]).filter((segment) => segment))
  if (roots.size !== 1) {
    throw new Error("Unexpected stack archive layout: expected a single top-level folder.")
  }
  const root = [...roots][0] as string
  const prefix = `${root}/`

  const grouped = new Map<string, AdmZip.IZipEntry[]>()
  let manifest: string | undefined
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!entry.entryName.startsWith(prefix)) continue
    const relative = entry.entryName.slice(prefix.length)
    if (!relative) continue
    const slash = relative.indexOf("/")
    if (slash === -1) {
      // A file directly under the root — the hub only puts its README there.
      if (relative.toLowerCase() === "readme.md") manifest = entry.getData().toString("utf-8")
      continue
    }
    const name = relative.slice(0, slash)
    const bucket = grouped.get(name)
    if (bucket) bucket.push(entry)
    else grouped.set(name, [entry])
  }

  const skills: StackSkillEntry[] = []
  const skipped: StackSkipped[] = []
  for (const [name, group] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
    // The folder name becomes a path segment under the skills directory, so it
    // gets the same guard `skill pull` applies to a hub-supplied skill name.
    if (!safeSegment(name)) {
      skipped.push({ name: stripControlChars(name), reason: "unsafe folder name" })
      continue
    }
    const skillPrefix = `${prefix}${name}/`
    // Without a SKILL.md the agents' `skills/**/SKILL.md` discovery never sees
    // the folder, so installing it would create a directory nothing reads.
    const hasSkillMd = group.some((entry) => {
      const inner = entry.entryName.slice(skillPrefix.length)
      return inner === "SKILL.md" || inner.endsWith("/SKILL.md")
    })
    if (!hasSkillMd) {
      skipped.push({ name, reason: "no SKILL.md" })
      continue
    }
    skills.push({
      name,
      prefix: skillPrefix,
      files: group.length,
      bytes: group.reduce((sum, entry) => sum + entry.header.size, 0),
      entries: group,
    })
  }

  if (skills.length === 0) {
    throw new Error("This stack contains no installable skills.")
  }

  return {
    slug: expectedSlug ?? root,
    skills,
    skipped,
    totalBytes: skills.reduce((sum, skill) => sum + skill.bytes, 0),
    manifest,
  }
}

export interface StackPlanEntry {
  name: string
  plan: PlacementPlan
  // Everything this skill would write: the real copy plus any agent links.
  destinations: string[]
  // True when any destination already exists.
  conflict: boolean
}

export interface StackPlan {
  slug: string
  entries: StackPlanEntry[]
  // Skill names already on disk. What the caller shows before asking the user
  // whether to overwrite them or install around them.
  conflicts: string[]
  fresh: string[]
}

// Work out where every skill in the stack would land and which of them are
// already installed. Pure planning — nothing is created, removed, or downloaded.
export async function planStackInstall(archive: StackArchive, target: InstallTarget): Promise<StackPlan> {
  const entries: StackPlanEntry[] = []
  for (const skill of archive.skills) {
    // Safe by construction: readStackArchive already rejected any name that
    // isn't a single path segment, which is what planPlacements guards.
    const plan = planPlacements(target, skill.name)
    const destinations = [plan.store, ...plan.links]
    const existing = await Promise.all(destinations.map(pathExists))
    entries.push({
      name: skill.name,
      plan,
      destinations,
      conflict: existing.some((found) => found),
    })
  }
  return {
    slug: archive.slug,
    entries,
    conflicts: entries.filter((entry) => entry.conflict).map((entry) => entry.name),
    fresh: entries.filter((entry) => !entry.conflict).map((entry) => entry.name),
  }
}

// What to do about skills the plan found already installed.
export type StackInstallMode = "skip-existing" | "overwrite"

export interface StackInstalled {
  name: string
  dir: string
  placements: InstallPlacement[]
}

export interface StackInstallResult {
  slug: string
  mode: StackInstallMode
  installed: StackInstalled[]
  skipped: StackSkipped[]
  failed: { name: string; message: string }[]
}

// Install every skill in the stack. Failures are per-skill: a broken or
// unwritable skill is recorded and the rest still land, because a stack is a
// convenience over N independent installs, not a transaction.
export async function installStack(
  archive: StackArchive,
  opts: { target: InstallTarget; mode: StackInstallMode; plan?: StackPlan },
): Promise<StackInstallResult> {
  const plan = opts.plan ?? (await planStackInstall(archive, opts.target))
  const byName = new Map(archive.skills.map((skill) => [skill.name, skill]))

  // Links exist only when Claude Code is among the selected agents, so this
  // probes `claude --version` at most once for the whole stack instead of once
  // per skill.
  const claudeSymlinks = plan.entries.some((entry) => entry.plan.links.length > 0)
    ? await claudeFollowsSymlinks()
    : undefined

  const installed: StackInstalled[] = []
  const skipped = [...archive.skipped]
  const failed: { name: string; message: string }[] = []

  for (const entry of plan.entries) {
    const skill = byName.get(entry.name)
    if (!skill) continue
    if (entry.conflict && opts.mode === "skip-existing") {
      skipped.push({ name: entry.name, reason: "already installed" })
      continue
    }
    const outcome = await placeSkill({
      name: entry.name,
      target: opts.target,
      plan: entry.plan,
      force: opts.mode === "overwrite",
      claudeSymlinks,
      extract: (dir) => extractEntries(skill.entries, dir, { strip: skill.prefix, limits: SKILL_LIMITS }),
    }).then(
      (placed) => ({ ok: true as const, placed }),
      (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
    )
    if (!outcome.ok) {
      failed.push({ name: entry.name, message: outcome.message })
      continue
    }
    installed.push({ name: entry.name, dir: outcome.placed.dir, placements: outcome.placed.placements })
  }

  return { slug: archive.slug, mode: opts.mode, installed, skipped, failed }
}

export function formatStackResult(result: StackInstallResult, json: boolean): string {
  if (json) {
    return JSON.stringify({
      ok: result.failed.length === 0,
      slug: result.slug,
      mode: result.mode,
      installed: result.installed,
      skipped: result.skipped,
      failed: result.failed,
    })
  }
  // Stack and skill names are hub-sourced; paths are local and already
  // validated. JSON output above needs no scrubbing — stringify escapes control
  // characters.
  const lines = [
    `Installed ${result.installed.length} skill(s) from ${stripControlChars(result.slug)}:`,
    ...result.installed.map((skill) => `  ${stripControlChars(skill.name)} -> ${skill.dir}`),
  ]
  if (result.skipped.length > 0) {
    lines.push("Skipped:")
    for (const item of result.skipped) {
      lines.push(`  ${stripControlChars(item.name)} (${item.reason})`)
    }
  }
  if (result.failed.length > 0) {
    lines.push("Failed:")
    for (const item of result.failed) {
      lines.push(`  ${stripControlChars(item.name)}: ${stripControlChars(item.message)}`)
    }
  }
  return lines.join("\n")
}

// Non-interactive path (a location flag given, or piped/CI). The interactive
// prompt lives in the CLI command; here the location MUST be explicit, and so
// must the conflict mode once anything collides — neither is silently chosen.
// The agent set does default though (defaultAgents()), as it does for
// `skill pull`: CI should not have to spell out --agent.
export async function runStackPull(opts: {
  slug: string
  dir?: string
  location?: Scope
  agents?: SkillAgent[]
  mode?: StackInstallMode
  json: boolean
}): Promise<number> {
  const target: InstallTarget | null =
    opts.dir !== undefined
      ? { kind: "dir", rootDir: resolve(opts.dir) }
      : opts.location !== undefined
        ? {
            kind: "agents",
            agents: opts.agents ?? defaultAgents(),
            scope: opts.location,
          }
        : null
  if (target === null) {
    console.error("Not a terminal — pass --here, --global, or --dir <path> to choose an install location.")
    return 1
  }

  const outcome = await pullStack(opts.slug, target, opts.mode).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
  )
  if (!outcome.ok) {
    console.error(outcome.message)
    return 1
  }
  console.log(formatStackResult(outcome.value, opts.json))
  // A stack is not a transaction, so a partial install is still reported in
  // full — but it must not look like success to a script.
  return outcome.value.failed.length > 0 ? 1 : 0
}

// Download, plan, and install in one pass. Refuses rather than guesses when the
// stack collides with skills already on disk and the caller named no mode.
async function pullStack(slug: string, target: InstallTarget, mode?: StackInstallMode) {
  const archive = readStackArchive(await stackApi.downloadStack(slug), slug)
  const plan = await planStackInstall(archive, target)
  if (plan.conflicts.length > 0 && mode === undefined) {
    throw new Error(
      `Already installed: ${plan.conflicts.join(", ")}. ` +
        "Pass --overwrite to replace them, or --skip-existing to install the rest.",
    )
  }
  return installStack(archive, { target, mode: mode ?? "skip-existing", plan })
}
