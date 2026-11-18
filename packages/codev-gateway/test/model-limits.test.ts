import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveApiKey, saveModelLimits } from "../src/auth-file"
import {
  cacheModelLimits,
  DEFAULT_LIMITS,
  declaredInput,
  limitsFor,
  limitsFromWindow,
  outputTokens,
  resetModelLimitsCache,
} from "../src/model-limits"

let tempDir: string
let originalTestHome: string | undefined

// CODEV_TEST_HOME rather than HOME: Bun's homedir() ignores runtime HOME
// changes, so overriding HOME here would silently hit the real ~/.codev.
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-gateway-limits-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
  resetModelLimitsCache()
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(tempDir, { recursive: true, force: true })
  resetModelLimitsCache()
})

describe("limitsFor", () => {
  test("resolves the table's known models and defaults the rest", () => {
    // Triggers are always 90% of the window, whatever its source.
    expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({ context: 262144, trigger: 235930 })
    expect(limitsFor("zai-org/GLM-5.3-Flash")).toEqual({ context: 262144, trigger: 235930 })
    expect(limitsFor("anything/else")).toEqual(DEFAULT_LIMITS)
    expect(DEFAULT_LIMITS).toEqual({ context: 200000, trigger: 180000 })
  })

  // The remote tier: a window the gateway (or the hub, which shares the auth
  // file) cached outranks the static table.
  test("prefers cached gateway-reported limits over the table", () => {
    saveModelLimits({ "MiniMax/MiniMax-M3": { context: 500000, trigger: 450000 } })
    resetModelLimitsCache()
    expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({ context: 500000, trigger: 450000 })
    expect(limitsFor("anything/else")).toEqual(DEFAULT_LIMITS)
  })
})

describe("cacheModelLimits", () => {
  test("persists windows as full limits and makes them visible in-process", () => {
    cacheModelLimits({ "gw/model": { context: 300000, output: 32000 } })
    expect(limitsFor("gw/model")).toEqual({ context: 300000, trigger: 270000, output: 32000 })
  })

  // A gateway that reports nothing must neither churn the auth file nor clear
  // limits the hub cached there.
  test("an empty map leaves an existing cache untouched", () => {
    saveModelLimits({ "gw/model": { context: 300000, trigger: 240000 } })
    resetModelLimitsCache()
    cacheModelLimits({})
    expect(limitsFor("gw/model")).toEqual({ context: 300000, trigger: 240000 })
  })

  // The auth file's read-merge-write must keep the other blocks: the write
  // path is shared with credentials the hub and the upload daemon depend on.
  test("does not clobber the api-key block", async () => {
    saveApiKey({ apiKey: "sk-1", model: "m" })
    cacheModelLimits({ "gw/model": { context: 300000 } })
    const { loadApiKey } = await import("../src/auth-file")
    expect(loadApiKey()).toEqual({ apiKey: "sk-1", model: "m" })
  })
})

describe("declaredInput", () => {
  test("adds the reserve and clamps to the true window", () => {
    expect(declaredInput({ context: 1000000, trigger: 900000 })).toBe(940000)
    // The 200K default hits the clamp: 180000 + 40000 > 200000.
    expect(declaredInput(DEFAULT_LIMITS)).toBe(200000)
    // A trigger too close to the window can only move compaction earlier,
    // never let the declared budget exceed the model's real ceiling.
    expect(declaredInput({ context: 100000, trigger: 90000 })).toBe(100000)
  })
})

describe("limitsFromWindow", () => {
  test("derives the trigger at 90% and keeps output only when reported", () => {
    expect(limitsFromWindow(300000)).toEqual({ context: 300000, trigger: 270000 })
    expect(limitsFromWindow(300000, 32000)).toEqual({ context: 300000, trigger: 270000, output: 32000 })
  })
})

describe("outputTokens", () => {
  test("falls back to the 65536 default", () => {
    expect(outputTokens({ context: 1, trigger: 1 })).toBe(65536)
    expect(outputTokens({ context: 1, trigger: 1, output: 32000 })).toBe(32000)
  })
})
