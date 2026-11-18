import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { execApi } from "../src/exec"
import {
  agentsServedBy,
  agentsServedByAt,
  claudeFollowsSymlinks,
  isClaudeLink,
  isClaudeLinkAt,
  linkApi,
  linkOrCopy,
  resolveTargets,
  resolveTargetsAt,
  safeSegment,
  type SkillAgent,
} from "../src/skill-dirs"

let tempHome: string
let tempCwd: string
let originalTestHome: string | undefined

const CLAUDE = join(".claude", "skills")
const AGENTS = join(".agents", "skills")

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "codev-skill-dirs-home-"))
  tempCwd = mkdtempSync(join(tmpdir(), "codev-skill-dirs-cwd-"))
  // CODEV_TEST_HOME rather than HOME: Bun's homedir() ignores runtime HOME
  // changes, so overriding HOME would silently hit the real home directory.
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempHome
  spyOn(process, "cwd").mockReturnValue(tempCwd)
})
afterEach(() => {
  mock.restore()
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(tempHome, { recursive: true, force: true })
  rmSync(tempCwd, { recursive: true, force: true })
})

// Which directory each agent reads was established from the agents' own source
// (see the header of src/skill-dirs.ts). These pin the consequence: whichever
// directory covers the most selected agents becomes the single real copy.
describe("resolveTargets", () => {
  test("without Codex, .claude/skills alone serves every agent", () => {
    for (const agents of [
      ["codev"],
      ["codev", "claude"],
      ["codev", "opencode"],
      ["claude", "codev", "opencode"],
    ] as SkillAgent[][]) {
      const t = resolveTargets(agents, "global", "pg-tuner")
      expect(t.store).toBe(join(tempHome, CLAUDE, "pg-tuner"))
      // One directory, so CoDev Code and OpenCode never see the skill twice.
      expect(t.links).toEqual([])
    }
  })

  test("Codex without Claude Code needs only .agents/skills", () => {
    const t = resolveTargets(["codev", "codex"], "global", "pg-tuner")
    expect(t.store).toBe(join(tempHome, AGENTS, "pg-tuner"))
    expect(t.links).toEqual([])
  })

  test("Codex plus Claude Code is the only case needing two directories", () => {
    const t = resolveTargets(["claude", "codex", "codev"], "global", "pg-tuner")
    expect(t.store).toBe(join(tempHome, AGENTS, "pg-tuner"))
    expect(t.links).toEqual([join(tempHome, CLAUDE, "pg-tuner")])
  })

  test("scope only changes the root — the rule is identical", () => {
    const global = resolveTargets(["claude", "codex"], "global", "x")
    const current = resolveTargets(["claude", "codex"], "current", "x")
    expect(global.store).toBe(join(tempHome, AGENTS, "x"))
    expect(current.store).toBe(join(tempCwd, AGENTS, "x"))
    expect(current.links).toEqual([join(tempCwd, CLAUDE, "x")])
  })
})

describe("agentsServedBy", () => {
  test("reports every selected agent that reads a given directory", () => {
    const agents: SkillAgent[] = ["claude", "codex", "codev"]
    const store = join(tempHome, AGENTS, "x")
    const link = join(tempHome, CLAUDE, "x")
    // .agents/skills is read by Codex, CoDev Code and OpenCode — not Claude.
    expect(agentsServedBy(store, agents, "global", "x")).toEqual(["codex", "codev"])
    // .claude/skills is read by Claude Code, CoDev Code and OpenCode.
    expect(agentsServedBy(link, agents, "global", "x")).toEqual(["claude", "codev"])
  })
})

describe("linkOrCopy", () => {
  function makeStore(): string {
    const store = join(tempHome, AGENTS, "pg-tuner")
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "SKILL.md"), "# pg-tuner")
    return store
  }

  test("creates a relative symlink that resolves to the store", async () => {
    const store = makeStore()
    const link = join(tempHome, CLAUDE, "pg-tuner")

    const mode = await linkOrCopy(store, link)

    expect(mode).toBe("symlink")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // Relative, not absolute — a relative link is the only kind that survives a
    // git clone into another checkout.
    const target = readlinkSync(link)
    expect(isAbsolute(target)).toBe(false)
    expect(target).toContain("..")
    // And it actually resolves.
    expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
  })

  test("falls back to a copy when symlinking fails, and says so", async () => {
    const store = makeStore()
    const link = join(tempHome, CLAUDE, "pg-tuner")
    spyOn(linkApi, "symlink").mockRejectedValue(Object.assign(new Error("operation not permitted"), { code: "EPERM" }))

    const mode = await linkOrCopy(store, link)

    // Reported as a copy — never described as a link it isn't.
    expect(mode).toBe("copy")
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
  })

  test("creates the parent directory when the agent has never been used", async () => {
    const store = makeStore()
    const link = join(tempHome, CLAUDE, "pg-tuner")
    expect(existsSync(join(tempHome, CLAUDE))).toBe(false)

    await linkOrCopy(store, link)

    expect(existsSync(link)).toBe(true)
  })
})

describe("claudeFollowsSymlinks", () => {
  function version(stdout: string) {
    return spyOn(execApi, "execAsync").mockResolvedValue({ error: null, stdout, stderr: "" })
  }

  test("true at and above the 2.1.203 floor", async () => {
    version("2.1.203 (Claude Code)")
    expect(await claudeFollowsSymlinks()).toBe(true)
    version("2.1.220 (Claude Code)")
    expect(await claudeFollowsSymlinks()).toBe(true)
    version("3.0.0 (Claude Code)")
    expect(await claudeFollowsSymlinks()).toBe(true)
  })

  test("false below it, so the Claude link becomes a real copy", async () => {
    version("2.1.202 (Claude Code)")
    expect(await claudeFollowsSymlinks()).toBe(false)
    version("2.0.999 (Claude Code)")
    expect(await claudeFollowsSymlinks()).toBe(false)
  })

  test("false when claude is absent or unparseable", async () => {
    spyOn(execApi, "execAsync").mockResolvedValue({
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      stdout: "",
      stderr: "",
    })
    expect(await claudeFollowsSymlinks()).toBe(false)

    version("some unexpected banner")
    expect(await claudeFollowsSymlinks()).toBe(false)
  })
})

describe("isClaudeLink", () => {
  test("identifies the one link whose mechanism depends on a version", () => {
    expect(isClaudeLink(join(tempHome, CLAUDE, "x"), "global", "x")).toBe(true)
    expect(isClaudeLink(join(tempHome, AGENTS, "x"), "global", "x")).toBe(false)
  })
})

describe("safeSegment", () => {
  test("rejects anything that would escape a skills directory", () => {
    expect(safeSegment("pg-tuner")).toBe(true)
    expect(safeSegment("..")).toBe(false)
    expect(safeSegment("../evil")).toBe(false)
    expect(safeSegment("nested/name")).toBe(false)
    expect(safeSegment("")).toBe(false)
    // A leading dot would collide with the dot-directories the agents scan.
    expect(safeSegment(".hidden")).toBe(false)
  })
})

// The -At variants take an explicit root instead of scopeRoot's cwd/home
// mapping — the desktop app's Electron main process installs into a project
// directory that is neither its cwd nor the home dir.
describe("explicit-root variants", () => {
  const root = join("/", "explicit", "project")

  test("resolveTargetsAt applies the same store/link selection under the root", () => {
    expect(resolveTargetsAt(root, ["codev", "claude"], "x")).toEqual({
      store: join(root, CLAUDE, "x"),
      links: [],
    })
    expect(resolveTargetsAt(root, ["codev", "codex", "claude"], "x")).toEqual({
      store: join(root, AGENTS, "x"),
      links: [join(root, CLAUDE, "x")],
    })
  })

  test("scope-based functions delegate to the root-based cores", () => {
    expect(resolveTargets(["codev"], "global", "x")).toEqual(resolveTargetsAt(tempHome, ["codev"], "x"))
  })

  test("agentsServedByAt and isClaudeLinkAt key off the given root", () => {
    const claudePath = join(root, CLAUDE, "x")
    // Filter preserves the caller's order.
    expect(agentsServedByAt(root, claudePath, ["codev", "claude", "codex"] as SkillAgent[], "x")).toEqual([
      "codev",
      "claude",
    ])
    expect(isClaudeLinkAt(root, claudePath, "x")).toBe(true)
    expect(isClaudeLinkAt(root, join(root, AGENTS, "x"), "x")).toBe(false)
    // A different root does not match.
    expect(isClaudeLinkAt(tempHome, claudePath, "x")).toBe(false)
  })
})
