import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { disableCodegraph } from "../src/commands/handlers/codegraph/shared"

let directory: string
let previous: string | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codev2-codegraph-"))
  previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = directory
})

afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
  if (previous !== undefined) process.env.OPENCODE_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

const codegraph = { type: "local", command: ["codegraph", "serve", "--mcp"] }

test("disable removes only the codegraph server and keeps the rest of the config", () => {
  const file = join(directory, "opencode.jsonc")
  writeFileSync(
    file,
    JSON.stringify({ model: "aigw/m", mcp: { servers: { codegraph, other: { type: "local", command: ["x"] } } } }),
  )
  expect(disableCodegraph()).toBe(0)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    model: "aigw/m",
    mcp: { servers: { other: { type: "local", command: ["x"] } } },
  })
})

test("disable prunes the emptied mcp block and the legacy v1 entry", () => {
  const file = join(directory, "opencode.json")
  writeFileSync(file, JSON.stringify({ model: "aigw/m", mcp: { codegraph, servers: { codegraph } } }))
  expect(disableCodegraph()).toBe(0)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "aigw/m" })
})

test("disable leaves a config without codegraph untouched", () => {
  const file = join(directory, "opencode.jsonc")
  const text = '{\n  // keep me\n  "model": "aigw/m"\n}\n'
  writeFileSync(file, text)
  expect(disableCodegraph()).toBe(0)
  expect(readFileSync(file, "utf8")).toBe(text)
})
