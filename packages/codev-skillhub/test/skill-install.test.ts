import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { execApi } from "../src/exec"
import { installResolvedSkill, parseAgentList, runSkillInstall, skillhubApi } from "../src/skill-install"
import type { SkillMeta } from "../src/skillhub"

let tempDir: string
let tempHome: string
let originalTestHome: string | undefined

const META: SkillMeta = {
  id: "3f9a0000-0000-4000-8000-000000000000",
  name: "pg-tuner",
  version: "1.2.0",
}

// A ZIP wrapped in a `pg-tuner/` root folder, like the server publishes.
function skillZip(root = "pg-tuner"): Buffer {
  const zip = new AdmZip()
  zip.addFile(`${root}/SKILL.md`, Buffer.from("# pg-tuner"))
  zip.addFile(`${root}/scripts/run.sh`, Buffer.from("echo hi"))
  return zip.toBuffer()
}

function mockMeta(meta: SkillMeta = META) {
  return spyOn(skillhubApi, "getSkillMeta").mockResolvedValue(meta)
}
function mockDownload(buf: Buffer = skillZip()) {
  return spyOn(skillhubApi, "downloadSkill").mockResolvedValue(buf)
}

function captureLog() {
  const out: string[] = []
  spyOn(console, "log").mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
  return out
}
function captureErr() {
  const out: string[] = []
  spyOn(console, "error").mockImplementation((m?: unknown) => {
    out.push(String(m))
  })
  return out
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-skill-install-"))
  tempHome = mkdtempSync(join(tmpdir(), "codev-skill-install-home-"))
  // Isolate global-scope paths from the real home directory (CODEV_TEST_HOME
  // rather than HOME: Bun's homedir() ignores runtime HOME changes).
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempHome
  // The Claude link's mechanism depends on `claude --version`. Pin it above the
  // symlink floor so these tests don't spawn a real process and don't change
  // behavior on a machine where Claude Code is absent or old.
  spyOn(execApi, "execAsync").mockResolvedValue({
    error: null,
    stdout: "2.1.220 (Claude Code)",
    stderr: "",
  })
})
afterEach(() => {
  mock.restore()
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(tempDir, { recursive: true, force: true })
  rmSync(tempHome, { recursive: true, force: true })
})

describe("runSkillInstall", () => {
  test("installs by name: resolves meta, downloads, strips root, extracts", async () => {
    mockMeta()
    const dl = mockDownload()
    const out = captureLog()

    const code = await runSkillInstall({ target: "pg-tuner", dir: tempDir, force: false, json: false })

    expect(code).toBe(0)
    expect(dl).toHaveBeenCalledWith(META.id)
    const skillDir = join(tempDir, "pg-tuner")
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
    expect(existsSync(join(skillDir, "scripts", "run.sh"))).toBe(true)
    expect(out.join("\n")).toContain("Installed pg-tuner@1.2.0 ->")
  })

  test("installs by UUID: names the folder from the resolved name, not the id", async () => {
    const getMeta = mockMeta()
    mockDownload()
    const out = captureLog()

    const code = await runSkillInstall({ target: META.id, dir: tempDir, force: false, json: false })

    expect(code).toBe(0)
    expect(getMeta).toHaveBeenCalledWith(META.id)
    // Folder is the human name, not the UUID — and the version is shown too.
    expect(existsSync(join(tempDir, "pg-tuner", "SKILL.md"))).toBe(true)
    expect(existsSync(join(tempDir, META.id))).toBe(false)
    expect(out.join("\n")).toContain("Installed pg-tuner@1.2.0 ->")
  })

  test("errors when the skill is not found", async () => {
    spyOn(skillhubApi, "getSkillMeta").mockRejectedValue(new Error('Skill "nope" not found or not public.'))
    const dl = mockDownload()
    const errs = captureErr()

    const code = await runSkillInstall({ target: "nope", dir: tempDir, force: false, json: false })

    expect(code).toBe(1)
    expect(dl).not.toHaveBeenCalled()
    expect(errs.join("\n")).toMatch(/not found or not public/i)
  })

  test("refuses to overwrite an existing install without --force", async () => {
    mockMeta()
    mockDownload()
    mkdirSync(join(tempDir, "pg-tuner"), { recursive: true })
    const errs = captureErr()

    const code = await runSkillInstall({ target: "pg-tuner", dir: tempDir, force: false, json: false })

    expect(code).toBe(1)
    expect(errs.join("\n")).toMatch(/Already installed/)
  })

  test("--force overwrites an existing install", async () => {
    mockMeta()
    mockDownload()
    const skillDir = join(tempDir, "pg-tuner")
    mkdirSync(skillDir, { recursive: true })
    captureLog()

    const code = await runSkillInstall({ target: "pg-tuner", dir: tempDir, force: true, json: false })

    expect(code).toBe(0)
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true)
  })

  test("--json emits a machine-readable summary", async () => {
    mockMeta()
    mockDownload()
    const out = captureLog()

    const code = await runSkillInstall({ target: "pg-tuner", dir: tempDir, force: false, json: true })

    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out[0] as string)
    expect(parsed).toMatchObject({
      ok: true,
      name: "pg-tuner",
      version: "1.2.0",
      id: META.id,
      strippedRoot: "pg-tuner",
    })
    expect(parsed.dir).toContain("pg-tuner")
  })

  test("requires a location when none is given (no prompt available)", async () => {
    const getMeta = mockMeta()
    const errs = captureErr()

    const code = await runSkillInstall({ target: "pg-tuner", force: false, json: false })

    expect(code).toBe(1)
    expect(getMeta).not.toHaveBeenCalled()
    expect(errs.join("\n")).toMatch(/--here, --global, or --dir/i)
  })

  // dir is an exact path (`<dir>/<name>`), while location "current" resolves
  // the selected agents' directories under the cwd — the layout the agents
  // actually read.
  test("dir installs verbatim; location resolves agent directories", async () => {
    mockMeta()
    mockDownload()
    captureLog()
    spyOn(process, "cwd").mockReturnValue(tempDir)

    expect(await runSkillInstall({ target: "pg-tuner", dir: tempDir, force: false, json: false })).toBe(0)
    expect(existsSync(join(tempDir, "pg-tuner", "SKILL.md"))).toBe(true)

    // CoDev Code alone reads .claude/skills, so that is the whole install.
    expect(
      await runSkillInstall({ target: "pg-tuner", location: "current", agents: ["codev"], force: false, json: false }),
    ).toBe(0)
    expect(existsSync(join(tempDir, ".claude", "skills", "pg-tuner", "SKILL.md"))).toBe(true)
  })

  // The one arrangement that needs two directories: Codex reads only
  // .agents/skills, Claude Code only .claude/skills.
  test("claude plus codex extracts once and links the second directory", async () => {
    mockMeta()
    const dl = mockDownload()
    captureLog()
    spyOn(process, "cwd").mockReturnValue(tempDir)

    expect(
      await runSkillInstall({
        target: "pg-tuner",
        location: "current",
        agents: ["claude", "codex", "codev"],
        force: false,
        json: false,
      }),
    ).toBe(0)

    const store = join(tempDir, ".agents", "skills", "pg-tuner")
    const link = join(tempDir, ".claude", "skills", "pg-tuner")
    expect(readFileSync(join(store, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
    // Downloaded once, extracted once — the second path is a link to the first.
    expect(dl).toHaveBeenCalledTimes(1)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
  })

  // Claude Code only follows a symlinked skill dir from v2.1.203; below that the
  // link has to be a real copy or the skill is simply invisible to it.
  test("an older Claude Code gets a copy instead of a link", async () => {
    mockMeta()
    mockDownload()
    spyOn(process, "cwd").mockReturnValue(tempDir)
    spyOn(execApi, "execAsync").mockResolvedValue({
      error: null,
      stdout: "2.1.202 (Claude Code)",
      stderr: "",
    })
    const out = captureLog()

    expect(
      await runSkillInstall({
        target: "pg-tuner",
        location: "current",
        agents: ["claude", "codex", "codev"],
        force: false,
        json: false,
      }),
    ).toBe(0)

    const link = join(tempDir, ".claude", "skills", "pg-tuner")
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
    // And it says so rather than claiming a link.
    expect(out.join("\n")).toContain("(copy)")
  })

  test("the full agent set names every agent in the result", async () => {
    mockMeta()
    mockDownload()
    spyOn(process, "cwd").mockReturnValue(tempDir)
    const out = captureLog()

    expect(
      await runSkillInstall({
        target: "pg-tuner",
        location: "current",
        agents: ["claude", "codex", "opencode", "codev"],
        force: false,
        json: false,
      }),
    ).toBe(0)

    const text = out.join("\n")
    for (const label of ["Claude Code", "Codex", "OpenCode", "CoDev Code"]) {
      expect(text).toContain(label)
    }
  })

  // The upgrade path: a skill installed before agent support is a real directory
  // in .claude/skills. Re-pulling with Codex selected has to convert it to a
  // link rather than leave a stale second copy behind.
  test("--force converts a pre-existing real directory into a link", async () => {
    mockMeta()
    mockDownload()
    spyOn(process, "cwd").mockReturnValue(tempDir)
    const stale = join(tempDir, ".claude", "skills", "pg-tuner")
    mkdirSync(stale, { recursive: true })
    captureLog()

    expect(
      await runSkillInstall({
        target: "pg-tuner",
        location: "current",
        agents: ["claude", "codex", "codev"],
        force: true,
        json: false,
      }),
    ).toBe(0)

    expect(lstatSync(stale).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(stale, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
  })

  test("without --force an existing agent directory stops the install", async () => {
    mockMeta()
    mockDownload()
    spyOn(process, "cwd").mockReturnValue(tempDir)
    mkdirSync(join(tempDir, ".claude", "skills", "pg-tuner"), {
      recursive: true,
    })
    const errs = captureErr()

    const code = await runSkillInstall({
      target: "pg-tuner",
      location: "current",
      agents: ["claude", "codex", "codev"],
      force: false,
      json: false,
    })

    expect(code).toBe(1)
    expect(errs.join("\n")).toMatch(/Already installed/)
    // Refused before anything was removed — the store was never created.
    expect(existsSync(join(tempDir, ".agents", "skills", "pg-tuner"))).toBe(false)
  })

  test("rejects a server name that escapes the target dir (no download, no write)", async () => {
    spyOn(skillhubApi, "getSkillMeta").mockResolvedValue({
      id: META.id,
      name: "../../evil",
      version: "1.0.0",
    })
    const dl = mockDownload()
    const errs = captureErr()

    const code = await runSkillInstall({ target: "whatever", dir: tempDir, force: false, json: false })

    expect(code).toBe(1)
    expect(errs.join("\n")).toMatch(/unsafe name/i)
    // The path is validated before any network or filesystem work.
    expect(dl).not.toHaveBeenCalled()
    expect(existsSync(join(tempDir, "..", "evil"))).toBe(false)
  })

  test("rejects a server name containing a path separator", async () => {
    spyOn(skillhubApi, "getSkillMeta").mockResolvedValue({
      id: META.id,
      name: "nested/name",
      version: "1.0.0",
    })
    const dl = mockDownload()
    const errs = captureErr()

    const code = await runSkillInstall({ target: "whatever", dir: tempDir, force: false, json: false })

    expect(code).toBe(1)
    expect(errs.join("\n")).toMatch(/unsafe name/i)
    expect(dl).not.toHaveBeenCalled()
  })
})

describe("parseAgentList", () => {
  // CoDev Code is the flagship: naming other agents never drops it.
  test("CoDev Code is always in the agent set", () => {
    expect(parseAgentList("claude")).toEqual(["claude", "codev"])
    expect(parseAgentList("codex")).toEqual(["codex", "codev"])
  })

  test("rejects an unknown agent name", () => {
    expect(parseAgentList("cursor")).toContain("Unknown agent: cursor")
  })

  test("rejects an empty value", () => {
    expect(parseAgentList("")).toBe("Missing value for --agent.")
    expect(parseAgentList(" , ")).toBe("Missing value for --agent.")
  })
})

// The desktop app installs into a project directory that is neither the
// process cwd nor home — the agents-at target carries that root explicitly.
describe("installResolvedSkill with agents-at", () => {
  test("places the store and link under the given root", async () => {
    mockDownload()
    const result = await installResolvedSkill(META, {
      target: { kind: "agents-at", agents: ["claude", "codex", "codev"], root: tempDir },
      force: false,
    })
    expect(result.dir).toBe(join(tempDir, ".agents", "skills", "pg-tuner"))
    expect(readFileSync(join(tempDir, ".agents", "skills", "pg-tuner", "SKILL.md"), "utf8")).toBe("# pg-tuner")
    expect(lstatSync(join(tempDir, ".claude", "skills", "pg-tuner")).isSymbolicLink()).toBe(true)
    // Nothing leaked into the isolated home (the global scope root).
    expect(existsSync(join(tempHome, ".agents"))).toBe(false)
    expect(existsSync(join(tempHome, ".claude"))).toBe(false)
    expect(result.placements.map((p) => p.mode)).toEqual(["store", "symlink"])
    expect(result.placements[1]?.agents).toEqual(["claude", "codev"])
  })

  test("refuses an unsafe name before downloading anything", async () => {
    const download = mockDownload()
    expect(
      installResolvedSkill(
        { ...META, name: "../evil" },
        { target: { kind: "agents-at", agents: ["codev"], root: tempDir }, force: false },
      ),
    ).rejects.toThrow('Refusing to install skill with unsafe name "../evil".')
    expect(download).not.toHaveBeenCalled()
  })

  test("preserves the already-installed guard under the explicit root", async () => {
    mockDownload()
    const target = { kind: "agents-at", agents: ["codev"], root: tempDir } as const
    await installResolvedSkill(META, { target: { ...target, agents: [...target.agents] }, force: false })
    expect(
      installResolvedSkill(META, { target: { ...target, agents: [...target.agents] }, force: false }),
    ).rejects.toThrow(
      `Already installed at ${join(tempDir, ".claude", "skills", "pg-tuner")}. Pass --force to overwrite.`,
    )
  })
})
