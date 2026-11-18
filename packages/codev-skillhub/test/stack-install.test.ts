import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { execApi } from "../src/exec"
import {
  installStack,
  planStackInstall,
  readStackArchive,
  runStackPull,
  stackApi,
  type StackArchive,
} from "../src/stack-install"

let tempDir: string
let tempHome: string
let originalTestHome: string | undefined

const SLUG = "data-eng"

// A composite archive shaped like the hub's downloadAllSkills output: one root
// folder named after the slug, a generated README beside one folder per skill.
function stackZip(skills: Record<string, Record<string, string>>, opts: { readme?: string; slug?: string } = {}) {
  const slug = opts.slug ?? SLUG
  const zip = new AdmZip()
  if (opts.readme !== undefined) zip.addFile(`${slug}/README.md`, Buffer.from(opts.readme))
  for (const [name, files] of Object.entries(skills)) {
    for (const [path, content] of Object.entries(files)) {
      zip.addFile(`${slug}/${name}/${path}`, Buffer.from(content))
    }
  }
  return zip.toBuffer()
}

const TWO_SKILLS = {
  "pg-tuner": { "SKILL.md": "# pg-tuner", "scripts/run.sh": "echo hi" },
  "dbt-helper": { "SKILL.md": "# dbt-helper" },
}

// One healthy skill beside one whose payload escapes its own folder. AdmZip
// sanitizes `../` on addFile, so the malicious name is set on the entry before
// serializing (same technique as archive.test.ts).
function slipZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile(`${SLUG}/dbt-helper/SKILL.md`, Buffer.from("# dbt-helper"))
  zip.addFile(`${SLUG}/evil/SKILL.md`, Buffer.from("# evil"))
  zip.addFile(`${SLUG}/evil/placeholder.txt`, Buffer.from("pwned"))
  const entry = zip.getEntries().find((e) => e.entryName.endsWith("placeholder.txt"))
  if (!entry) throw new Error("fixture setup failed")
  entry.entryName = `${SLUG}/evil/../../../escaped.txt`
  return zip.toBuffer()
}

function archive(skills: Record<string, Record<string, string>> = TWO_SKILLS, opts?: { readme?: string }) {
  return readStackArchive(stackZip(skills, opts), SLUG)
}

function targetAt(root: string, agents: ("claude" | "codex" | "opencode" | "codev")[] = ["codev"]) {
  return { kind: "agents-at" as const, agents, root }
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
  tempDir = mkdtempSync(join(tmpdir(), "codev-stack-install-"))
  tempHome = mkdtempSync(join(tmpdir(), "codev-stack-install-home-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempHome
  // Pin `claude --version` above the symlink floor so these tests never spawn a
  // real process and don't change behavior on a machine without Claude Code.
  spyOn(execApi, "execAsync").mockResolvedValue({ error: null, stdout: "2.1.220 (Claude Code)", stderr: "" })
})
afterEach(() => {
  mock.restore()
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(tempDir, { recursive: true, force: true })
  rmSync(tempHome, { recursive: true, force: true })
})

describe("readStackArchive", () => {
  test("groups the root folder's children into skills", () => {
    const result = archive()
    expect(result.slug).toBe(SLUG)
    expect(result.skills.map((s) => s.name)).toEqual(["dbt-helper", "pg-tuner"])
    expect(result.skills.find((s) => s.name === "pg-tuner")?.files).toBe(2)
    expect(result.totalBytes).toBeGreaterThan(0)
  })

  test("lifts the generated README out as the manifest instead of installing it", () => {
    const result = archive(TWO_SKILLS, { readme: "# Data Engineering — Skill Stack" })
    expect(result.manifest).toBe("# Data Engineering — Skill Stack")
    expect(result.skills.map((s) => s.name)).not.toContain("README.md")
  })

  test("skips a folder with no SKILL.md — the agents would never discover it", () => {
    const result = archive({ ...TWO_SKILLS, notes: { "readme.txt": "hi" } })
    expect(result.skills.map((s) => s.name)).not.toContain("notes")
    expect(result.skipped).toContainEqual({ name: "notes", reason: "no SKILL.md" })
  })

  test("accepts a SKILL.md nested below the skill root", () => {
    const result = archive({ deep: { "inner/SKILL.md": "# deep" } })
    expect(result.skills.map((s) => s.name)).toEqual(["deep"])
  })

  test("skips an unsafe folder name rather than letting it become a path segment", () => {
    const result = archive({ ...TWO_SKILLS, ".evil": { "SKILL.md": "# evil" } })
    expect(result.skills.map((s) => s.name)).not.toContain(".evil")
    expect(result.skipped).toContainEqual({ name: ".evil", reason: "unsafe folder name" })
  })

  test("refuses an archive without a single top-level folder", () => {
    const zip = new AdmZip()
    zip.addFile("a/SKILL.md", Buffer.from("# a"))
    zip.addFile("b/SKILL.md", Buffer.from("# b"))
    expect(() => readStackArchive(zip.toBuffer())).toThrow("Unexpected stack archive layout")
  })

  test("refuses an archive with nothing installable in it", () => {
    expect(() => archive({ notes: { "readme.txt": "hi" } })).toThrow("no installable skills")
  })

  test("falls back to the archive's own root when no slug is given", () => {
    expect(readStackArchive(stackZip(TWO_SKILLS)).slug).toBe(SLUG)
  })
})

describe("planStackInstall", () => {
  test("splits the stack into fresh and already-installed skills without writing", async () => {
    mkdirSync(join(tempDir, ".claude", "skills", "pg-tuner"), { recursive: true })
    const plan = await planStackInstall(archive(), targetAt(tempDir))
    expect(plan.conflicts).toEqual(["pg-tuner"])
    expect(plan.fresh).toEqual(["dbt-helper"])
    // Planning is pure: the fresh skill's directory must not exist yet.
    expect(existsSync(join(tempDir, ".claude", "skills", "dbt-helper"))).toBe(false)
  })

  test("lists every destination a skill would write, across agent directories", async () => {
    const plan = await planStackInstall(archive(), targetAt(tempDir, ["claude", "codex", "codev"]))
    const entry = plan.entries.find((e) => e.name === "pg-tuner")
    expect(entry?.destinations).toEqual([
      join(tempDir, ".agents", "skills", "pg-tuner"),
      join(tempDir, ".claude", "skills", "pg-tuner"),
    ])
  })
})

describe("installStack", () => {
  test("extracts every skill into the agent directory, root folder stripped", async () => {
    const result = await installStack(archive(), { target: targetAt(tempDir), mode: "skip-existing" })
    expect(result.installed.map((s) => s.name).toSorted()).toEqual(["dbt-helper", "pg-tuner"])
    const dir = join(tempDir, ".claude", "skills", "pg-tuner")
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
    expect(readFileSync(join(dir, "scripts", "run.sh"), "utf-8")).toBe("echo hi")
  })

  test("skip-existing leaves an installed skill's contents alone and installs the rest", async () => {
    const existing = join(tempDir, ".claude", "skills", "pg-tuner")
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, "SKILL.md"), "# local edits")

    const result = await installStack(archive(), { target: targetAt(tempDir), mode: "skip-existing" })
    expect(result.installed.map((s) => s.name)).toEqual(["dbt-helper"])
    expect(result.skipped).toContainEqual({ name: "pg-tuner", reason: "already installed" })
    expect(readFileSync(join(existing, "SKILL.md"), "utf-8")).toBe("# local edits")
  })

  test("overwrite replaces an installed skill", async () => {
    const existing = join(tempDir, ".claude", "skills", "pg-tuner")
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, "SKILL.md"), "# local edits")
    writeFileSync(join(existing, "stale.txt"), "gone")

    const result = await installStack(archive(), { target: targetAt(tempDir), mode: "overwrite" })
    expect(result.installed.map((s) => s.name).toSorted()).toEqual(["dbt-helper", "pg-tuner"])
    expect(readFileSync(join(existing, "SKILL.md"), "utf-8")).toBe("# pg-tuner")
    expect(existsSync(join(existing, "stale.txt"))).toBe(false)
  })

  test("links the other agent directories to the one real copy", async () => {
    const result = await installStack(archive(), {
      target: targetAt(tempDir, ["claude", "codex", "codev"]),
      mode: "skip-existing",
    })
    const entry = result.installed.find((s) => s.name === "pg-tuner")
    expect(entry?.placements.map((p) => p.mode)).toEqual(["store", "symlink"])
    expect(lstatSync(join(tempDir, ".claude", "skills", "pg-tuner")).isSymbolicLink()).toBe(true)
  })

  test("probes `claude --version` once for the whole stack, not once per skill", async () => {
    const exec = spyOn(execApi, "execAsync").mockResolvedValue({
      error: null,
      stdout: "2.1.220 (Claude Code)",
      stderr: "",
    })
    await installStack(archive(), { target: targetAt(tempDir, ["claude", "codex", "codev"]), mode: "skip-existing" })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  test("never probes at all when Claude Code is not among the selected agents", async () => {
    const exec = spyOn(execApi, "execAsync")
    await installStack(archive(), { target: targetAt(tempDir, ["codev"]), mode: "skip-existing" })
    expect(exec).not.toHaveBeenCalled()
  })

  test("isolates a failing skill: the zip-slip guard still applies inside a stack", async () => {
    const result = await installStack(readStackArchive(slipZip(), SLUG), {
      target: targetAt(tempDir),
      mode: "skip-existing",
    })
    expect(result.failed.map((f) => f.name)).toEqual(["evil"])
    expect(result.failed[0]?.message).toMatch(/unsafe zip entry/)
    // The other skill still landed — a stack is N installs, not a transaction.
    expect(result.installed.map((s) => s.name)).toEqual(["dbt-helper"])
    expect(existsSync(join(tempDir, "escaped.txt"))).toBe(false)
  })

  test("applies the per-skill size ceiling inside a stack, not just the stack one", async () => {
    const zip = new AdmZip()
    zip.addFile(`${SLUG}/dbt-helper/SKILL.md`, Buffer.from("# dbt-helper"))
    zip.addFile(`${SLUG}/big/SKILL.md`, Buffer.from("# big"))
    // Over SKILL_LIMITS (15k entries) but inside STACK_LIMITS (50k), so the
    // archive parses and only this one skill is refused at extraction.
    for (let i = 0; i < 16_000; i++) zip.addFile(`${SLUG}/big/f${i}.txt`, Buffer.from("x"))

    const result = await installStack(readStackArchive(zip.toBuffer(), SLUG), {
      target: targetAt(tempDir),
      mode: "skip-existing",
    })
    expect(result.failed.map((f) => f.name)).toEqual(["big"])
    expect(result.failed[0]?.message).toMatch(/too many files/)
    expect(result.installed.map((s) => s.name)).toEqual(["dbt-helper"])
  })

  test("carries the archive's own skipped folders into the result", async () => {
    const result = await installStack(archive({ ...TWO_SKILLS, notes: { "readme.txt": "hi" } }), {
      target: targetAt(tempDir),
      mode: "skip-existing",
    })
    expect(result.skipped).toContainEqual({ name: "notes", reason: "no SKILL.md" })
  })
})

describe("runStackPull", () => {
  function mockDownload(buffer: Buffer = stackZip(TWO_SKILLS)) {
    return spyOn(stackApi, "downloadStack").mockResolvedValue(buffer)
  }

  test("refuses without an explicit location", async () => {
    const download = mockDownload()
    const errs = captureErr()
    expect(await runStackPull({ slug: SLUG, json: false })).toBe(1)
    expect(errs.join("\n")).toMatch(/pass --here, --global, or --dir/i)
    expect(download).not.toHaveBeenCalled()
  })

  test("installs into an explicit directory", async () => {
    mockDownload()
    const out = captureLog()
    expect(await runStackPull({ slug: SLUG, dir: tempDir, json: false })).toBe(0)
    expect(existsSync(join(tempDir, "pg-tuner", "SKILL.md"))).toBe(true)
    expect(out.join("\n")).toMatch(/Installed 2 skill\(s\) from data-eng/)
  })

  test("installs globally under the home directory", async () => {
    mockDownload()
    captureLog()
    expect(await runStackPull({ slug: SLUG, location: "global", agents: ["codev"], json: false })).toBe(0)
    expect(existsSync(join(tempHome, ".claude", "skills", "dbt-helper", "SKILL.md"))).toBe(true)
  })

  test("refuses to guess when skills collide and no mode was named", async () => {
    mockDownload()
    mkdirSync(join(tempHome, ".claude", "skills", "pg-tuner"), { recursive: true })
    const errs = captureErr()
    expect(await runStackPull({ slug: SLUG, location: "global", agents: ["codev"], json: false })).toBe(1)
    expect(errs.join("\n")).toMatch(/Already installed: pg-tuner/)
    expect(errs.join("\n")).toMatch(/--overwrite|--skip-existing/)
  })

  test("--skip-existing installs around the collision", async () => {
    mockDownload()
    const existing = join(tempHome, ".claude", "skills", "pg-tuner")
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, "SKILL.md"), "# local edits")
    captureLog()
    expect(
      await runStackPull({
        slug: SLUG,
        location: "global",
        agents: ["codev"],
        mode: "skip-existing",
        json: false,
      }),
    ).toBe(0)
    expect(readFileSync(join(existing, "SKILL.md"), "utf-8")).toBe("# local edits")
    expect(existsSync(join(tempHome, ".claude", "skills", "dbt-helper"))).toBe(true)
  })

  test("--json prints one machine-readable line", async () => {
    mockDownload()
    const out = captureLog()
    expect(await runStackPull({ slug: SLUG, dir: tempDir, json: true })).toBe(0)
    const parsed = JSON.parse(out[0] ?? "{}")
    expect(parsed.ok).toBe(true)
    expect(parsed.slug).toBe(SLUG)
    expect(parsed.installed.map((s: { name: string }) => s.name).toSorted()).toEqual(["dbt-helper", "pg-tuner"])
  })

  test("exits non-zero when a skill failed, having still installed the others", async () => {
    mockDownload(slipZip())
    const out = captureLog()
    expect(await runStackPull({ slug: SLUG, dir: tempDir, json: false })).toBe(1)
    expect(out.join("\n")).toMatch(/Failed:/)
    expect(existsSync(join(tempDir, "dbt-helper", "SKILL.md"))).toBe(true)
  })

  test("reports a download failure without a stack trace", async () => {
    spyOn(stackApi, "downloadStack").mockRejectedValue(
      new Error('Stack "ghost" not found, or it has no public skills.'),
    )
    const errs = captureErr()
    expect(await runStackPull({ slug: "ghost", dir: tempDir, json: false })).toBe(1)
    expect(errs.join("\n")).toBe('Stack "ghost" not found, or it has no public skills.')
  })
})

describe("archive caps", () => {
  test("a stack may exceed one skill's entry ceiling", () => {
    const zip = new AdmZip()
    zip.addFile(`${SLUG}/big/SKILL.md`, Buffer.from("# big"))
    for (let i = 0; i < 16_000; i++) zip.addFile(`${SLUG}/big/f${i}.txt`, Buffer.from("x"))
    // 16k entries is over SKILL_LIMITS (15k) but inside STACK_LIMITS (50k).
    const result: StackArchive = readStackArchive(zip.toBuffer(), SLUG)
    expect(result.skills[0]?.files).toBe(16_001)
  })
})
