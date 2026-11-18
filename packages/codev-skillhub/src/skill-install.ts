import { cp, mkdir, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { defaultAgents } from "./agents"
import { detectAndStripRoot, extractZip, inspectZip, pathExists } from "./archive"
import { stripControlChars } from "./sanitize"
import {
  AGENT_LABELS,
  agentsServedByAt,
  claudeFollowsSymlinks,
  isClaudeLinkAt,
  isSkillAgent,
  linkOrCopy,
  resolveTargetsAt,
  safeSegment,
  scopeRoot,
  ALWAYS_AGENT,
  SKILL_AGENTS,
  type LinkMode,
  type Scope,
  type SkillAgent,
} from "./skill-dirs"
import { downloadSkill, getSkillMeta, type SkillMeta } from "./skillhub"

// Registry lookups behind an object so tests can stub them without module
// mocks (Bun spyOn on ESM namespaces is unreliable).
export const skillhubApi = {
  getSkillMeta,
  downloadSkill,
}

// The server's skill name becomes a directory under rootDir. Never trust it as
// a path: require it to resolve to a single direct child of rootDir, rejecting
// path separators, "..", and absolute paths. Without this, a hostile hub entry
// named e.g. "../../../tmp/x" could write outside the skills dir — or, combined
// with --force, delete an arbitrary directory via rm().
function safeSkillDir(rootDir: string, name: string): string {
  const root = resolve(rootDir)
  const dir = resolve(root, name)
  const rel = relative(root, dir)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) {
    throw new Error(`Refusing to install skill with unsafe name "${name}".`)
  }
  return dir
}

// Scope is the only thing --here/--global choose; which agents get the skill is
// an orthogonal axis (see skill-dirs.ts).
export type InstallLocation = Scope

// Parse a --agent value: comma-separated launch names. CoDev Code is folded in
// whether or not it was named — it is not opt-out.
export function parseAgentList(value: string): SkillAgent[] | string {
  const names = value
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "")
  if (names.length === 0) return "Missing value for --agent."
  const unknown = names.filter((n) => !isSkillAgent(n))
  if (unknown.length > 0) {
    return `Unknown agent: ${unknown.join(", ")}. Valid: ${SKILL_AGENTS.join(", ")}.`
  }
  const chosen = new Set<SkillAgent>(names.filter(isSkillAgent))
  chosen.add(ALWAYS_AGENT)
  return SKILL_AGENTS.filter((agent) => chosen.has(agent))
}

// Where one extraction landed, and which of the selected agents it serves.
// `mode` is reported verbatim so a copy is never described as a link.
export interface InstallPlacement {
  path: string
  mode: LinkMode
  agents: SkillAgent[]
}

export interface InstallResult {
  name: string
  version?: string
  id: string
  // The single real extraction. Kept as `dir` so the --json shape stays
  // compatible with callers written against the single-directory install.
  dir: string
  strippedRoot: string | null
  placements: InstallPlacement[]
}

// Where an install should go: one exact directory (--dir), the agent
// directories resolved from a scope, or the agent directories under an
// explicit root — for hosts (the desktop app's Electron main process) whose
// cwd is not the project the user is installing into.
export type InstallTarget =
  | { kind: "dir"; rootDir: string }
  | { kind: "agents"; agents: SkillAgent[]; scope: Scope }
  | { kind: "agents-at"; agents: SkillAgent[]; root: string }

function targetRoot(target: Exclude<InstallTarget, { kind: "dir" }>): string {
  return target.kind === "agents" ? scopeRoot(target.scope) : resolve(target.root)
}

export interface PlacementPlan {
  // The single real extraction directory.
  store: string
  // Paths that must end up pointing at `store`.
  links: string[]
  agents: SkillAgent[]
}

// Resolve where this install writes, and check every destination is safe BEFORE
// any filesystem work — especially before the rm() below, so a hostile hub name
// can never delete a directory outside the intended root.
export function planPlacements(target: InstallTarget, name: string): PlacementPlan {
  if (target.kind === "dir") {
    return { store: safeSkillDir(target.rootDir, name), links: [], agents: [] }
  }
  // resolveTargetsAt joins the name into two fixed roots, so validating the
  // name as a single path segment covers both destinations at once.
  if (!safeSegment(name)) {
    throw new Error(`Refusing to install skill with unsafe name "${name}".`)
  }
  const { store, links } = resolveTargetsAt(targetRoot(target), target.agents, name)
  return { store, links, agents: target.agents }
}

// Download + extract a skill whose metadata is already resolved. The install
// dir is named after the canonical skill name (meta.name), not the id or the
// ZIP's root folder — the root is only stripped so files aren't double-nested.
//
// The archive is extracted exactly once, into `store`; every other agent
// directory becomes a link to it (skill-dirs.ts#linkOrCopy). A hub skill can
// run to thousands of files, so fanning out copies per agent is not free.
export async function installResolvedSkill(
  meta: SkillMeta,
  opts: { target: InstallTarget; force: boolean },
): Promise<InstallResult> {
  const plan = planPlacements(opts.target, meta.name)

  const zip = await skillhubApi.downloadSkill(meta.id)
  // Vet the archive's size/entry counts before inflating or extracting it.
  inspectZip(zip)
  const { buffer, stripped } = detectAndStripRoot(zip)

  const placed = await placeSkill({
    name: meta.name,
    target: opts.target,
    plan,
    force: opts.force,
    extract: (dir) => extractZip(buffer, dir),
  })

  return {
    name: meta.name,
    version: meta.version,
    id: meta.id,
    dir: placed.dir,
    strippedRoot: stripped,
    placements: placed.placements,
  }
}

// Write one planned skill to disk: clear its destinations, extract the single
// real copy into `store`, then point every other agent directory at it. Shared
// by the single-skill install and by each skill of a stack — the conflict/rm
// ordering and the Claude-version fallback are subtle enough that a second copy
// of them would drift. `extract` is how the bytes arrive, so a stack can lift a
// subtree straight out of its composite archive instead of re-zipping it.
export async function placeSkill(opts: {
  name: string
  target: InstallTarget
  plan: PlacementPlan
  force: boolean
  extract: (dir: string) => Promise<void>
  // Precomputed answer to claudeFollowsSymlinks(). A stack passes it so one
  // `claude --version` covers every skill in it rather than one probe per link.
  claudeSymlinks?: boolean
}): Promise<{ dir: string; placements: InstallPlacement[] }> {
  const { plan } = opts
  // Every destination is checked before anything is removed, so a refusal on
  // the second one can't leave the first already deleted.
  for (const dir of [plan.store, ...plan.links]) {
    if (!(await pathExists(dir))) continue
    if (!opts.force) {
      throw new Error(`Already installed at ${dir}. Pass --force to overwrite.`)
    }
  }
  for (const dir of [plan.store, ...plan.links]) {
    await rm(dir, { recursive: true, force: true })
  }

  await mkdir(plan.store, { recursive: true })
  await opts.extract(plan.store)

  const placements: InstallPlacement[] = [
    {
      path: plan.store,
      mode: "store",
      agents: agentsFor(plan.store, opts.target, opts.name),
    },
  ]
  for (const link of plan.links) {
    // Claude Code only follows a symlinked skill directory from v2.1.203; on an
    // older build the link reads as a file with no SKILL.md inside, so it has
    // to be a real copy.
    const mustCopy =
      opts.target.kind !== "dir" &&
      isClaudeLinkAt(targetRoot(opts.target), link, opts.name) &&
      !(opts.claudeSymlinks ?? (await claudeFollowsSymlinks()))
    const mode = mustCopy ? await copyInto(plan.store, link) : await linkOrCopy(plan.store, link)
    placements.push({
      path: link,
      mode,
      agents: agentsFor(link, opts.target, opts.name),
    })
  }

  return { dir: plan.store, placements }
}

function agentsFor(path: string, target: InstallTarget, name: string): SkillAgent[] {
  if (target.kind === "dir") return []
  return agentsServedByAt(targetRoot(target), path, target.agents, name)
}

async function copyInto(store: string, dest: string): Promise<LinkMode> {
  await cp(store, dest, { recursive: true })
  return "copy"
}

// Resolve <target> (id or name) to its canonical metadata, then download +
// extract. No console I/O — returns the result or throws. Used by the
// non-interactive runner; the interactive flow resolves metadata itself (to
// show the name in the prompt) and calls installResolvedSkill directly.
export async function installSkill(
  target: string,
  opts: { target: InstallTarget; force: boolean },
): Promise<InstallResult> {
  const meta = await skillhubApi.getSkillMeta(target)
  return installResolvedSkill(meta, opts)
}

export function formatInstallResult(r: InstallResult, json: boolean): string {
  if (json) {
    return JSON.stringify({
      ok: true,
      name: r.name,
      version: r.version ?? null,
      id: r.id,
      dir: r.dir,
      strippedRoot: r.strippedRoot,
      placements: r.placements,
    })
  }
  // Sanitize hub-sourced name/version for terminal display (paths are local and
  // already validated). JSON output above needs no scrubbing — stringify escapes
  // control characters.
  const name = stripControlChars(r.name)
  const versionSuffix = r.version ? `@${stripControlChars(r.version)}` : ""
  const served = r.placements.flatMap((p) => p.agents)
  // --dir installs for no particular agent, so it keeps the original one-liner.
  if (served.length === 0) {
    return `Installed ${name}${versionSuffix} -> ${r.dir}`
  }
  const labels = SKILL_AGENTS.filter((a) => served.includes(a)).map((a) => AGENT_LABELS[a])
  const lines = [`Installed ${name}${versionSuffix} for ${labels.join(", ")}`]
  for (const placement of r.placements) {
    // Name the mechanism only when it isn't the real copy — and never call a
    // fallback copy a link.
    const suffix = placement.mode === "store" ? "" : ` (${placement.mode})`
    lines.push(`  ${placement.path}${suffix}`)
  }
  return lines.join("\n")
}

// Non-interactive path (a location flag given, or piped/CI). The interactive
// prompt lives in the CLI command; here a location MUST be explicit, so no flag
// at all is an error rather than a silent default. The agent set does default
// though (defaultAgents()) — CI should not have to spell out --agent. Arg
// parsing lives in the CLI's yargs layer; this runner takes the parsed values
// and returns the exit code.
export async function runSkillInstall(opts: {
  target: string
  dir?: string
  location?: InstallLocation
  agents?: SkillAgent[]
  force: boolean
  json: boolean
}): Promise<number> {
  // --dir is the escape hatch and is used verbatim; --here/--global resolve to
  // the selected agents' directories for that scope.
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

  try {
    const result = await installSkill(opts.target, {
      target,
      force: opts.force,
    })
    console.log(formatInstallResult(result, opts.json))
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}
