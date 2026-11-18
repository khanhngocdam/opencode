// Builds an isolated Codev2 preview of this extension in `dist-codev2/`.
// The upstream extension (`sst-dev.opencode`, `opencode.*` commands) is never modified.
//
//   bun script/pack-codev2.ts          # stage dist-codev2/ only
//   bun script/pack-codev2.ts --vsix   # stage, bundle with esbuild and package a .vsix
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const out = path.join(root, "dist-codev2")
const displayName = "CoDev Code 2"
const binary = "codev2"

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await Promise.all(
  ["images", "esbuild.js", "tsconfig.json", ".vscodeignore", "README.md"].map((file) =>
    cp(path.join(root, file), path.join(out, file), { recursive: true }),
  ),
)

const manifest = await Bun.file(path.join(root, "package.json")).json()
await Bun.write(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      ...manifest,
      name: "codev2",
      publisher: "codev",
      displayName,
      description: `${displayName} for VS Code (preview, separate from Codev v1 and OpenCode)`,
      repository: { type: "git", url: "https://github.com/khanhngocdam/opencode" },
      // Only the bundle is shipped, so upstream's prepublish lint/typecheck chain and dev tooling do not apply.
      scripts: {},
      devDependencies: {},
      contributes: rebrand(manifest.contributes),
    },
    undefined,
    2,
  ) + "\n",
)

// The extension source keeps upstream wording; patch only the identifiers that must not collide.
const source = await Bun.file(path.join(root, "src/extension.ts")).text()
await Bun.write(
  path.join(out, "src/extension.ts"),
  source
    .replace('const TERMINAL_NAME = "opencode"', `const TERMINAL_NAME = "${binary}"`)
    .replaceAll('"opencode.', '"codev2.')
    .replace('terminal.sendText("opencode")', `terminal.sendText("${binary}")`),
)

console.log(`Staged ${displayName} preview in ${out}`)
if (!process.argv.includes("--vsix")) process.exit(0)

// esbuild resolves from sdks/vscode/node_modules (run `bun install` there first).
const steps = [
  ["node", "esbuild.js", "--production"],
  ["bunx", "@vscode/vsce", "package", "--no-dependencies", "--allow-missing-repository"],
]
for (const cmd of steps) {
  const proc = Bun.spawn(cmd, { cwd: out, stdout: "inherit", stderr: "inherit" })
  if ((await proc.exited) !== 0) process.exit(1)
}

function rebrand(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/^opencode\./, "codev2.").replace(/\bopencode\b/g, displayName)
  if (Array.isArray(value)) return value.map(rebrand)
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebrand(item)]))
  return value
}
