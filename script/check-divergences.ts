import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const upstream = await Bun.file(path.join(root, "codev.upstream.json")).json()
if (typeof upstream.commit !== "string" || !/^[a-f0-9]{40}$/.test(upstream.commit)) {
  throw new Error("codev.upstream.json must pin a full upstream commit SHA")
}

function git(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString()
}

const baseline = new Set(git(["ls-tree", "-r", "--name-only", upstream.commit]).trim().split("\n"))
const changed = git(["diff", "--name-only", "--no-renames", upstream.commit, "--"])
  .trim()
  .split("\n")
  .filter((file) => baseline.has(file))
const document = await Bun.file(path.join(root, "DIVERGENCES.md")).text()
const recorded = new Set(
  document.split("\n").flatMap((line) => {
    if (!line.startsWith("| `")) return []
    const columns = line.split("|").slice(1, -1).map((column) => column.trim())
    if (columns.length !== 4 || columns.some((column) => !column)) {
      throw new Error(`Incomplete divergence row: ${line}`)
    }
    return [...columns[0].matchAll(/`([^`]+)`/g)].map((match) => match[1])
  }),
)
const missing = changed.filter((file) => !recorded.has(file))
if (missing.length) {
  console.error(`Upstream changes missing from DIVERGENCES.md:\n${missing.join("\n")}`)
  process.exit(1)
}
console.log(`Divergence coverage: ${changed.length} changed upstream files documented.`)
