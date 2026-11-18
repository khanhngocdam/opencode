import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import AdmZip from "adm-zip"
import { httpApi } from "../src/http"
import {
  formatPublishResult,
  type PublishResult,
  type PublishStep,
  plannedSteps,
  preparePublishArchive,
  publishSkill,
  runSkillPublish,
  type StepStatus,
} from "../src/skill-publish"

let tempDir: string
let savedHome: string | undefined

// Create a skill directory with a SKILL.md plus the given extra files.
function makeSkillDir(name: string, extra: Record<string, string> = {}): string {
  const dir = join(tempDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "# skill")
  for (const [rel, contents] of Object.entries(extra)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, contents)
  }
  return dir
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

// Stub the network seam so publishSkill/runSkillPublish never touch the wire:
// one httpApi.fetch fake routing the four SkillHub endpoints, recording each
// request so tests can assert which steps ran and with what payloads.
function mockNetwork(overrides: Partial<Record<"upload" | "metadata" | "submit" | "review", Response>> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  spyOn(httpApi, "fetch").mockImplementation(async (_endpoint, input, init) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    if (url.endsWith("/api/v1/skills/upload")) {
      return overrides.upload ?? jsonResponse(200, { success: true, skill_id: "sk-1", status: "PENDING" })
    }
    if (url.endsWith("/metadata")) return overrides.metadata ?? jsonResponse(200, { success: true })
    if (url.endsWith("/submit")) return overrides.submit ?? jsonResponse(200, { success: true })
    if (url.endsWith("/api/v1/admin/review")) return overrides.review ?? jsonResponse(200, { success: true })
    return jsonResponse(404, { success: false })
  })
  return {
    calls,
    of: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)),
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-skill-publish-"))
  savedHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
  // The publish endpoints require auth — seed the real auth file the gateway
  // reads so skillhubFetch attaches the cookie without any module mock.
  const dir = join(tempDir, ".codev")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ skillhub_cookie: "skill-hub-session=abc" }))
})

afterEach(() => {
  mock.restore()
  if (savedHome === undefined) delete process.env.CODEV_TEST_HOME
  else process.env.CODEV_TEST_HOME = savedHome
  rmSync(tempDir, { recursive: true, force: true })
})

describe("plannedSteps", () => {
  test("default runs upload, metadata, submit", () => {
    expect(plannedSteps({ draftOnly: false, autoApprove: false })).toEqual(["upload", "metadata", "submit"])
  })
  test("--draft-only stops after metadata", () => {
    expect(plannedSteps({ draftOnly: true, autoApprove: false })).toEqual(["upload", "metadata"])
  })
  test("--auto-approve appends approve", () => {
    expect(plannedSteps({ draftOnly: false, autoApprove: true })).toEqual(["upload", "metadata", "submit", "approve"])
  })
  test("--auto-approve is ignored under --draft-only", () => {
    expect(plannedSteps({ draftOnly: true, autoApprove: true })).toEqual(["upload", "metadata"])
  })
})

describe("preparePublishArchive", () => {
  test("zips a directory, includes real files, and excludes secrets/junk", async () => {
    const dir = makeSkillDir("pg-tuner", {
      "scripts/run.sh": "echo hi",
      ".env": "SECRET=1",
      ".DS_Store": "junk",
      "tests/run.test.sh": "echo test",
      "logs/run.log": "log line",
    })
    mkdirSync(join(dir, ".git"), { recursive: true })
    writeFileSync(join(dir, ".git", "config"), "[core]")

    const a = await preparePublishArchive(dir)

    expect(a.source).toBe("dir")
    expect(a.fileName).toBe("pg-tuner.zip")
    expect(a.files.sort()).toEqual(["SKILL.md", "scripts/run.sh"])
    expect(a.skipped).toContain(".env")
    expect(a.skipped).toContain(".DS_Store")
    expect(a.skipped).toContain(".git/")
    expect(a.skipped).toContain("tests/")
    expect(a.skipped).toContain("logs/")

    // The excluded files really are absent from the produced archive.
    const names = new AdmZip(a.zipBuffer).getEntries().map((e) => e.entryName)
    expect(names).toContain("pg-tuner/SKILL.md")
    expect(names).toContain("pg-tuner/scripts/run.sh")
    expect(names.some((n) => n.includes(".env"))).toBe(false)
    expect(names.some((n) => n.includes(".git"))).toBe(false)
    expect(names.some((n) => n.includes("tests/"))).toBe(false)
    expect(names.some((n) => n.includes("logs/"))).toBe(false)
  })

  test("rejects a directory with no SKILL.md", async () => {
    const dir = join(tempDir, "no-skill")
    mkdirSync(dir, { recursive: true })
    await expect(preparePublishArchive(dir)).rejects.toThrow(/SKILL\.md/)
  })

  test("reads a .zip file as-is and inspects it", async () => {
    const zip = new AdmZip()
    zip.addFile("SKILL.md", Buffer.from("# s"))
    const zipPath = join(tempDir, "bundle.zip")
    writeFileSync(zipPath, zip.toBuffer())

    const a = await preparePublishArchive(zipPath)
    expect(a.source).toBe("zip")
    expect(a.fileName).toBe("bundle.zip")
    expect(a.files).toEqual(["SKILL.md"])
    expect(a.skipped).toEqual([])
  })

  test("rejects a non-zip file", async () => {
    const file = join(tempDir, "notes.txt")
    writeFileSync(file, "hi")
    await expect(preparePublishArchive(file)).rejects.toThrow(/\.zip/)
  })

  test("rejects a missing path", async () => {
    await expect(preparePublishArchive(join(tempDir, "nope"))).rejects.toThrow(/not found/i)
  })
})

describe("publishSkill", () => {
  const archive = { zipBuffer: Buffer.from("z"), fileName: "s.zip" }

  test("default: upload -> metadata -> submit, status SUBMITTED", async () => {
    const net = mockNetwork()
    const events: [PublishStep, StepStatus][] = []

    const r = await publishSkill(archive, { draftOnly: false, autoApprove: false }, (step, status) =>
      events.push([step, status]),
    )

    expect(net.of("/api/v1/skills/upload")).toHaveLength(1)
    const metaCall = net.of("/api/v1/skills/sk-1/metadata")
    expect(metaCall).toHaveLength(1)
    expect(metaCall[0]?.init.body).toBe("{}")
    expect(net.of("/api/v1/skills/sk-1/submit")).toHaveLength(1)
    expect(net.of("/api/v1/admin/review")).toHaveLength(0)
    expect(r.status).toBe("SUBMITTED")
    expect(r.skillId).toBe("sk-1")
    expect(events).toEqual([
      ["upload", "start"],
      ["upload", "done"],
      ["metadata", "start"],
      ["metadata", "done"],
      ["submit", "start"],
      ["submit", "done"],
    ])
  })

  test("--draft-only stops after metadata, status DRAFT", async () => {
    const net = mockNetwork()
    const r = await publishSkill(archive, { draftOnly: true, autoApprove: false })
    expect(net.of("/submit")).toHaveLength(0)
    expect(net.of("/api/v1/admin/review")).toHaveLength(0)
    expect(r.status).toBe("DRAFT")
  })

  test("--auto-approve approves after submit, status PUBLIC", async () => {
    const net = mockNetwork()
    const r = await publishSkill(archive, { draftOnly: false, autoApprove: true })
    expect(net.of("/api/v1/skills/sk-1/submit")).toHaveLength(1)
    const review = net.of("/api/v1/admin/review")
    expect(review).toHaveLength(1)
    expect(JSON.parse(String(review[0]?.init.body))).toEqual({
      skill_id: "sk-1",
      action: "APPROVE",
      feedback: "Auto-approved via CLI",
    })
    expect(r.status).toBe("PUBLIC")
  })

  test("throws when upload returns no skill_id", async () => {
    const net = mockNetwork({ upload: jsonResponse(200, { success: true }) })
    await expect(publishSkill(archive, { draftOnly: false, autoApprove: false })).rejects.toThrow(/no skill_id/i)
    expect(net.of("/metadata")).toHaveLength(0)
  })
})

describe("formatPublishResult", () => {
  const base: PublishResult = {
    skillId: "sk-1",
    status: "SUBMITTED",
    steps: ["uploaded", "metadata saved (DRAFT)", "submitted for review (SUBMITTED)"],
  }

  test("human output shows the id, steps, and SUBMITTED hint", () => {
    const out = formatPublishResult(base, false)
    expect(out).toContain("Published skill sk-1")
    expect(out).toContain("submitted for review (SUBMITTED)")
    expect(out).toMatch(/Status: SUBMITTED/)
  })

  test("json output is a single machine-readable line", () => {
    expect(JSON.parse(formatPublishResult(base, true))).toEqual({
      ok: true,
      skillId: "sk-1",
      status: "SUBMITTED",
      steps: base.steps,
    })
  })

  test("DRAFT and PUBLIC carry their own hints", () => {
    const draft = formatPublishResult({ ...base, status: "DRAFT" }, false)
    expect(draft).toMatch(/Status: DRAFT/)
    expect(draft).toContain("run `codev skill push` again (without --draft-only) to submit.")
    expect(formatPublishResult({ ...base, status: "PUBLIC" }, false)).toMatch(/Status: PUBLIC/)
  })
})

describe("runSkillPublish", () => {
  test("publishes a directory and prints the result (exit 0)", async () => {
    mockNetwork()
    const dir = makeSkillDir("pg-tuner")
    const out = captureLog()

    const code = await runSkillPublish({ path: dir, draftOnly: false, autoApprove: false, json: false })

    expect(code).toBe(0)
    expect(out.join("\n")).toContain("Published skill sk-1")
  })

  test("--json emits a machine-readable summary", async () => {
    mockNetwork()
    const dir = makeSkillDir("pg-tuner")
    const out = captureLog()

    const code = await runSkillPublish({ path: dir, draftOnly: false, autoApprove: false, json: true })

    expect(code).toBe(0)
    expect(JSON.parse(out[0] as string)).toMatchObject({
      ok: true,
      skillId: "sk-1",
      status: "SUBMITTED",
    })
  })

  test("notes excluded files on stderr (not stdout)", async () => {
    mockNetwork()
    const dir = makeSkillDir("pg-tuner", { ".env": "SECRET=1" })
    const out = captureLog()
    const errs = captureErr()

    await runSkillPublish({ path: dir, draftOnly: false, autoApprove: false, json: false })

    expect(errs.join("\n")).toMatch(/Excluded from upload:.*\.env/)
    expect(out.join("\n")).not.toContain("Excluded from upload")
  })

  test("returns exit 1 with the message on failure", async () => {
    mockNetwork({ upload: jsonResponse(400, { success: false, message: "name already taken" }) })
    const dir = makeSkillDir("pg-tuner")
    const errs = captureErr()

    const code = await runSkillPublish({ path: dir, draftOnly: false, autoApprove: false, json: false })

    expect(code).toBe(1)
    expect(errs.join("\n")).toContain("name already taken")
  })
})
