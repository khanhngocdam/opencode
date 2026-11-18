import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAgents, detectApi } from "../src/agents"

let tempHome: string
let originalTestHome: string | undefined

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "codev-agents-home-"))
  // CODEV_TEST_HOME rather than HOME: Bun's homedir() ignores runtime HOME
  // changes, so overriding HOME would scan the real ~/.claude and friends.
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempHome
})
afterEach(() => {
  mock.restore()
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(tempHome, { recursive: true, force: true })
})

describe("defaultAgents", () => {
  test("CoDev Code is always present, even when nothing else is detected", () => {
    spyOn(detectApi, "which").mockReturnValue(false)
    spyOn(detectApi, "dirExists").mockReturnValue(false)
    expect(defaultAgents()).toEqual(["codev"])
  })

  test("an agent whose binary resolves on PATH is included", () => {
    for (const binary of ["claude", "codex", "opencode"] as const) {
      spyOn(detectApi, "which").mockImplementation((b) => b === binary)
      spyOn(detectApi, "dirExists").mockReturnValue(false)
      expect(defaultAgents()).toEqual([binary, "codev"])
    }
  })

  test("an agent whose config directory exists is included, binary or not", () => {
    spyOn(detectApi, "which").mockReturnValue(false)
    // Real directories under the isolated home, resolved by the real dirExists.
    for (const [agent, dir] of [
      ["claude", join(tempHome, ".claude")],
      ["codex", join(tempHome, ".codex")],
      ["opencode", join(tempHome, ".config", "opencode")],
    ] as const) {
      mkdirSync(dir, { recursive: true })
      expect(defaultAgents()).toContain(agent)
      rmSync(dir, { recursive: true, force: true })
      expect(defaultAgents()).not.toContain(agent)
    }
  })

  test("all agents present yields the full set in canonical order", () => {
    spyOn(detectApi, "which").mockReturnValue(true)
    expect(defaultAgents()).toEqual(["claude", "codex", "opencode", "codev"])
  })
})
