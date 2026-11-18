import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveApiKey } from "@codev/gateway"
import { shouldNudgeSignIn } from "../src/nudge"
import { statsStatusPath } from "../src/paths"

let tempDir: string
let originalTestHome: string | undefined
let originalXdgData: string | undefined
let originalDisable: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-upload-nudge-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  originalXdgData = process.env.XDG_DATA_HOME
  originalDisable = process.env.CODEV_DISABLE_METRICS
  process.env.CODEV_TEST_HOME = tempDir
  process.env.XDG_DATA_HOME = join(tempDir, "share")
  delete process.env.CODEV_DISABLE_METRICS
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  else process.env.CODEV_TEST_HOME = originalTestHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalDisable === undefined) delete process.env.CODEV_DISABLE_METRICS
  else process.env.CODEV_DISABLE_METRICS = originalDisable
  rmSync(tempDir, { recursive: true, force: true })
})

function recordStall(): void {
  mkdirSync(join(tempDir, "share", "codev"), { recursive: true })
  writeFileSync(
    statsStatusPath(),
    JSON.stringify({ ok: false, skipped: "not-logged-in", startedAt: "t", finishedAt: "t" }),
  )
}

describe("shouldNudgeSignIn", () => {
  test("nudges an SSO-origin key with a recorded stall, on every call until resolved", () => {
    saveApiKey({ apiKey: "sk-x" })
    recordStall()
    // Deliberately unthrottled: the toast repeats each launch while stalled.
    expect(shouldNudgeSignIn()).toBe(true)
    expect(shouldNudgeSignIn()).toBe(true)
    // A healthy status (next successful push) ends it.
    writeFileSync(statsStatusPath(), JSON.stringify({ ok: true, startedAt: "t", finishedAt: "t" }))
    expect(shouldNudgeSignIn()).toBe(false)
  })

  test("explicit aigw provider id still counts as SSO-origin", () => {
    saveApiKey({ apiKey: "sk-x", providerId: "aigw", providerName: "AIGW" })
    recordStall()
    expect(shouldNudgeSignIn()).toBe(true)
  })

  test("the pre-rename netgate id still counts as SSO-origin", () => {
    saveApiKey({ apiKey: "sk-x", providerId: "netgate", providerName: "netGate" })
    recordStall()
    expect(shouldNudgeSignIn()).toBe(true)
  })

  test("never nudges a manually-named provider — its owner may have no SSO account", () => {
    saveApiKey({ apiKey: "sk-x", baseUrl: "https://gw.example", providerId: "my-gateway", providerName: "My Gateway" })
    recordStall()
    expect(shouldNudgeSignIn()).toBe(false)
  })

  test("requires a configured key, a recorded stall, and the opt-out unset", () => {
    // No key at all: unconfigured machines get the configure gate, not this.
    recordStall()
    expect(shouldNudgeSignIn()).toBe(false)

    // Key but no stall recorded (or a healthy status): quiet.
    saveApiKey({ apiKey: "sk-x" })
    writeFileSync(statsStatusPath(), JSON.stringify({ ok: true, startedAt: "t", finishedAt: "t" }))
    expect(shouldNudgeSignIn()).toBe(false)

    // Opt-out wins over everything.
    recordStall()
    process.env.CODEV_DISABLE_METRICS = "1"
    expect(shouldNudgeSignIn()).toBe(false)
  })
})
