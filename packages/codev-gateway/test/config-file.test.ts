import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { buildGatewayConfig } from "../src/config-block"
import { mergeConfigFragment } from "../src/config-file"
import { resetModelLimitsCache } from "../src/model-limits"

let dir: string
let originalTestHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codev-gateway-config-file-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = dir
  resetModelLimitsCache()
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(dir, { recursive: true, force: true })
  resetModelLimitsCache()
})

const fragment = () => buildGatewayConfig({ baseUrl: "https://gw.test", model: "m1", models: ["m1", "m2"] })

describe("mergeConfigFragment", () => {
  test("creates opencode.jsonc with the gateway provider", () => {
    const file = mergeConfigFragment(join(dir, "config"), fragment())
    expect(file).toBe(join(dir, "config", "opencode.jsonc"))
    const config = parse(readFileSync(file, "utf8"))
    expect(config.providers.aigw.settings.baseURL).toBe("https://gw.test/v1")
    expect(Object.keys(config.providers.aigw.models)).toEqual(["m1", "m2"])
    expect(config.providers.aigw.settings.apiKey).toBeUndefined()
  })

  test("preserves comments, unrelated keys and other providers in the highest-priority document", () => {
    writeFileSync(join(dir, "opencode.json"), "{}\n")
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{
  // keep me
  "shell": "pwsh",
  "compaction": { "reserved": 1234 },
  "providers": { "other": { "name": "Other" }, "aigw": { "name": "stale", "models": { "old": {} } } }
}
`,
    )
    const file = mergeConfigFragment(dir, fragment())
    expect(file).toBe(join(dir, "opencode.jsonc"))
    const text = readFileSync(file, "utf8")
    expect(text).toContain("// keep me")
    const config = parse(text)
    expect(config.shell).toBe("pwsh")
    expect(config.compaction.reserved).toBe(1234)
    expect(config.compaction.auto).toBe(true)
    expect(config.providers.other).toEqual({ name: "Other" })
    // The provider entry is replaced whole, so stale models do not linger.
    expect(Object.keys(config.providers.aigw.models)).toEqual(["m1", "m2"])
  })
})
