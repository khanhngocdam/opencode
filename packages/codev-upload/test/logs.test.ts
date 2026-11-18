import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redactSecrets } from "../src/log"
import { renderLastRun } from "../src/logs"
import { uploadLogDir } from "../src/paths"

let tempDir: string
let originalTestHome: string | undefined
let originalXdgData: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-upload-logs-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  originalXdgData = process.env.XDG_DATA_HOME
  process.env.CODEV_TEST_HOME = tempDir
  process.env.XDG_DATA_HOME = join(tempDir, "share")
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  else process.env.CODEV_TEST_HOME = originalTestHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  rmSync(tempDir, { recursive: true, force: true })
})

function writeDocs(file: string, docs: object[]): void {
  mkdirSync(uploadLogDir(), { recursive: true })
  writeFileSync(join(uploadLogDir(), file), docs.map((d) => JSON.stringify(d)).join("\n") + "\n")
}

function doc(trace: string, message: string, extra: Record<string, unknown> = {}): object {
  return {
    "@timestamp": "2026-08-24T10:00:00.000Z",
    log: { level: "info" },
    message,
    trace: { id: trace },
    codev: { command: "upload", ...extra },
  }
}

describe("renderLastRun", () => {
  test("returns null with no logs", () => {
    expect(renderLastRun("upload")).toBeNull()
  })

  test("prints only the most recent run, including its parent chain", () => {
    writeDocs("upload-20260823.ndjson", [
      doc("aaaa000000000001", "old run start"),
      doc("aaaa000000000001", "old run end"),
    ])
    writeDocs("upload-20260824.ndjson", [
      doc("bbbb000000000002", "spawned upload daemon"),
      doc("cccc000000000003", "starting auto-upload", { parent_trace_id: "bbbb000000000002" }),
      doc("cccc000000000003", "auto-upload done"),
    ])
    const rendered = renderLastRun("upload")
    expect(rendered).toContain("starting auto-upload")
    expect(rendered).toContain("auto-upload done")
    expect(rendered).toContain("spawned upload daemon")
    expect(rendered).not.toContain("old run start")
  })

  test("renders outcome and error fields", () => {
    writeDocs("upload-20260824.ndjson", [
      {
        ...doc("dddd000000000004", "upload failed"),
        log: { level: "warn" },
        event: { outcome: "failure" },
        error: { message: "presign-upload failed (500)" },
      },
    ])
    expect(renderLastRun("upload")).toBe("2026-08-24T10:00:00.000Z WARN  upload failed [failure] — presign-upload failed (500)")
  })

  test("reads only the requested command's files", () => {
    writeDocs("upload-20260824.ndjson", [doc("eeee000000000005", "log upload run")])
    writeDocs("stats-20260825.ndjson", [doc("ffff000000000006", "stats push done: sent=1 unchanged=0")])
    expect(renderLastRun("upload")).toContain("log upload run")
    expect(renderLastRun("stats")).toContain("stats push done")
    expect(renderLastRun("stats")).not.toContain("log upload run")
  })
})

describe("redactSecrets", () => {
  test("scrubs bearers, JWTs, keys, and sensitive query params", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [REDACTED]")
    expect(redactSecrets("token eyJabc1.eyJdef2.sig3 here")).toBe("token [REDACTED:jwt] here")
    expect(redactSecrets("key sk-abcdef123456 used")).toBe("key [REDACTED:key] used")
    expect(redactSecrets("https://x.test/cb?code=SECRET&x=1")).toBe("https://x.test/cb?code=[REDACTED]&x=1")
  })
})
