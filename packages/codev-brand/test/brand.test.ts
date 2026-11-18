import { expect, test } from "bun:test"
import { rebrand } from "../src/index"

test("brands product prose and executable instructions without changing contracts", () => {
  expect(rebrand("OpenCode: opencode run")).toBe("CoDev Code 2: codev2 run")
  const contracts = "@opencode/plugin @opencode-ai/sdk opencode.json opencode.jsonc .opencode opencode.db https://opencode.ai/config.json opencode-gemini-auth"
  expect(rebrand(contracts)).toBe(contracts)
})

test("keeps actual external services and routes issue reports to the fork", () => {
  expect(rebrand("https://opencode.ai/zen https://opencode.ai/go")).toBe("https://opencode.ai/zen https://opencode.ai/go")
  expect(rebrand("https://github.com/anomalyco/opencode/issues")).toBe("https://github.com/khanhngocdam/opencode/issues")
})
