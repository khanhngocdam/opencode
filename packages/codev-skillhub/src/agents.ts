import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { home } from "./paths"
import { SKILL_AGENTS, type SkillAgent } from "./skill-dirs"

// The hub derives its default agent set from its own configure/backup markers
// (`detectCodevTools`), which only exist on machines the hub has configured.
// This standalone CLI instead treats "the agent is present on this machine" as
// the signal: its CLI resolves on PATH, or its config directory exists.
const AGENT_BINARIES: Record<Exclude<SkillAgent, "codev">, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
}

function configDirs(agent: Exclude<SkillAgent, "codev">): string[] {
  if (agent === "claude") return [join(home(), ".claude")]
  if (agent === "codex") return [join(home(), ".codex")]
  return [join(home(), ".config", "opencode")]
}

// Object indirection so tests can stub detection without module mocks.
export const detectApi = {
  which(binary: string): boolean {
    const pathValue = process.env.PATH ?? ""
    // Windows resolves executables through PATHEXT (claude.cmd, codex.exe, …).
    const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""]
    return pathValue
      .split(delimiter)
      .filter((dir) => dir !== "")
      .some((dir) => extensions.some((ext) => existsSync(join(dir, binary + ext.toLowerCase()))))
  },
  dirExists(path: string): boolean {
    return existsSync(path)
  },
}

// The set installed for when the user names none: CoDev Code always (the
// flagship agent is never opted out of), plus every other agent present on
// this machine. Used as both the prompt's pre-check and the non-interactive
// default, so CI never has to spell out --agent.
export function defaultAgents(): SkillAgent[] {
  return SKILL_AGENTS.filter((agent) => {
    // Literal comparison (not ALWAYS_AGENT) so TypeScript narrows the union.
    if (agent === "codev") return true
    return detectApi.which(AGENT_BINARIES[agent]) || configDirs(agent).some((dir) => detectApi.dirExists(dir))
  })
}
