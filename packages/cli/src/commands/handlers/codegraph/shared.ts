import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { confirm, isCancel, log } from "@clack/prompts"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@opencode/util/global"

// Codev (v1 parity): CodeGraph is an external MCP server. Enabling it installs the `codegraph` binary when missing and
// writes one `mcp.servers.codegraph` entry into the global codev2 config; the server's config watcher reloads it.

const PACKAGE = "@colbymchenry/codegraph"
const ENTRY = { type: "local", command: ["codegraph", "serve", "--mcp"] }
// v2 config documents, lowest to highest priority; writes go to the last existing one (as in @codev/gateway).
const NAMES = ["opencode.json", "opencode.jsonc"]
const FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true } }

export async function enableCodegraph(input: { yes: boolean }) {
  if (!Bun.which("codegraph")) {
    log.step(`Installing CodeGraph (${PACKAGE})...`)
    if (!(await install())) {
      log.error(`Could not install CodeGraph. Run \`npm install --global ${PACKAGE}\`, then try again.`)
      return 1
    }
    if (!Bun.which("codegraph"))
      log.warn("CodeGraph is installed but `codegraph` is not on PATH yet; open a new terminal.")
  }
  const written = writeEntry()
  log.success(
    written.changed
      ? `Added the codegraph MCP server to ${written.file}`
      : `CodeGraph is already enabled in ${written.file}`,
  )
  await offerProjectIndex(input.yes)
  log.info("Run `codev2 reload` or restart Codev Code to load it.")
  return 0
}

export function disableCodegraph() {
  const files = configFiles()
    .filter(existsSync)
    .filter((file) => {
      const text = readFileSync(file, "utf8")
      const data = parseConfig(file, text)
      const mcp = record(data.mcp)
      if (!record(mcp.servers).codegraph && !mcp.codegraph) return false
      atomicWrite(file, prune(remove(remove(text, ["mcp", "servers", "codegraph"]), ["mcp", "codegraph"])))
      return true
    })
  log.success(files.length ? `Removed the codegraph MCP server from ${files.join(", ")}` : "CodeGraph was not enabled.")
  log.info("Run `codev2 reload` or restart Codev Code to apply it.")
  return 0
}

export function codegraphStatus() {
  const binary = Bun.which("codegraph")
  const found = findEntry()
  log.info(binary ? `Binary: ${binary}` : "Binary: not on PATH (`codev2 codegraph enable` installs it)")
  log.info(
    found
      ? `MCP server: ${record(found.entry).disabled === true ? "disabled" : "enabled"} in ${found.file}`
      : "MCP server: not configured",
  )
  log.info(
    existsSync(".codegraph") ? "This project: indexed (.codegraph)" : "This project: not indexed (`codegraph init`)",
  )
  return 0
}

function configFiles() {
  const directory = process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config
  return NAMES.map((name) => join(directory, name))
}

function findEntry() {
  return configFiles()
    .filter(existsSync)
    .flatMap((file) => {
      const mcp = record(parseConfig(file, readFileSync(file, "utf8")).mcp)
      const entry = record(mcp.servers).codegraph ?? mcp.codegraph
      return entry ? [{ file, entry, legacy: !record(mcp.servers).codegraph }] : []
    })
    .at(-1)
}

function writeEntry() {
  const found = findEntry()
  const file = found?.file ?? configFiles().filter(existsSync).at(-1) ?? configFiles().at(-1)!
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{}\n"
  if (found && !found.legacy && JSON.stringify(found.entry) === JSON.stringify(ENTRY)) return { file, changed: false }
  // A legacy v1-style `mcp.codegraph` entry moves under `servers` instead of living twice.
  atomicWrite(file, remove(edit(text, ["mcp", "servers", "codegraph"], ENTRY), ["mcp", "codegraph"]))
  return { file, changed: true }
}

async function install() {
  const attempts = [
    ["npm", "install", "--global", PACKAGE],
    ["bun", "add", "--global", PACKAGE],
  ]
  for (const [tool, ...args] of attempts) {
    const binary = Bun.which(tool!)
    if (!binary) continue
    const child = Bun.spawn([binary, ...args], { stdio: ["inherit", "inherit", "inherit"] })
    if ((await child.exited) === 0) return true
  }
  return false
}

async function offerProjectIndex(yes: boolean) {
  if (existsSync(".codegraph")) return
  const binary = Bun.which("codegraph")
  if (!binary) return
  if (!yes && !process.stdin.isTTY) return log.info("Index this project later with `codegraph init`.")
  if (!yes) {
    const answer = await confirm({ message: "Index this project now with `codegraph init`?" })
    if (isCancel(answer) || !answer) return
  }
  await Bun.spawn([binary, "init"], { stdio: ["inherit", "inherit", "inherit"] }).exited
}

function parseConfig(file: string, text: string) {
  const errors: ParseError[] = []
  const data: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`${file} is not valid JSON; fix it and try again`)
  return record(data)
}

function edit(text: string, path: string[], value: unknown) {
  return applyEdits(text, modify(text, path, value, FORMAT))
}

function remove(text: string, path: string[]) {
  return edit(text, path, undefined)
}

// Drops `mcp.servers` and then `mcp` when removing codegraph left them empty.
function prune(text: string) {
  const mcp = record(record(parse(text)).mcp)
  const withoutServers =
    mcp.servers && Object.keys(record(mcp.servers)).length === 0 ? remove(text, ["mcp", "servers"]) : text
  const rest = record(parse(withoutServers)).mcp
  return rest && Object.keys(record(rest)).length === 0 ? remove(withoutServers, ["mcp"]) : withoutServers
}

function atomicWrite(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`)
  renameSync(tmp, file)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
