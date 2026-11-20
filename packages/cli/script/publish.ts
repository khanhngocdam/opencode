#!/usr/bin/env bun
import { $ } from "bun"
import { cp, mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Script } from "@opencode/script"
import { COMMAND_NAME, PACKAGE_NAME, PRODUCT_NAME } from "@codev/brand"
import pkg from "../package.json"

const dir = path.resolve(import.meta.dir, "..")
const dist = path.join(dir, "dist")
const stage = path.join(dist, "npm-publish")
const builtBinary = "opencode"
const ATTEMPTS = 5

process.chdir(dir)

await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })

const binaries: Record<string, string> = {}
const dirs: Record<string, string> = {}

for (const filepath of new Bun.Glob("cli-*/package.json").scanSync({ cwd: dist })) {
  const sourceDir = path.dirname(filepath)
  const manifest = await Bun.file(path.join(dist, filepath)).json()
  if (!String(manifest.name).startsWith("@opencode/cli-")) continue

  const target = sourceDir.slice("cli-".length)
  const name = `${PACKAGE_NAME}-${target}`
  const out = path.join(stage, name)
  await cp(path.join(dist, sourceDir), out, { recursive: true })
  await stageBinary(out, target.startsWith("windows-"))
  await Bun.write(
    path.join(out, "package.json"),
    JSON.stringify(
      {
        name,
        version: manifest.version,
        license: manifest.license ?? pkg.license,
        os: manifest.os,
        cpu: manifest.cpu,
      },
      null,
      2,
    ),
  )
  binaries[name] = manifest.version
  dirs[name] = out
}

const versions = new Set(Object.values(binaries))
if (versions.size !== 1)
  throw new Error(`Expected one CLI version in dist/, found ${[...versions].join(", ") || "none"}`)
const version = versions.values().next().value!
if (version !== Script.version) throw new Error(`dist/ is ${version}, expected ${Script.version}`)

console.log("binaries", binaries)

const wrapper = path.join(stage, PACKAGE_NAME)
await mkdir(path.join(wrapper, "bin"), { recursive: true })
await $`cp ./script/postinstall.mjs ${wrapper}/postinstall.mjs`
await Bun.write(path.join(wrapper, "LICENSE"), await Bun.file(path.join(dir, "../../LICENSE")).text())
await Bun.write(
  path.join(wrapper, "README.md"),
  [
    `# ${PRODUCT_NAME}`,
    "",
    "## Install",
    "",
    "```sh",
    `npm i -g ${PACKAGE_NAME}`,
    "```",
    "",
    "## Usage",
    "",
    "```sh",
    "cd your-project",
    COMMAND_NAME,
    "```",
    "",
    `This opens the interactive terminal UI. Run \`${COMMAND_NAME} --help\` for the full`,
    `command list, or \`${COMMAND_NAME} run "..."\` for non-interactive use.`,
    "",
  ].join("\n"),
)
await Bun.write(
  path.join(wrapper, "bin", `${COMMAND_NAME}.exe`),
  [
    `echo "Error: ${PACKAGE_NAME}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "npm 12 and later block install scripts on global installs unless allowed:" >&2',
    `echo "  npm install -g ${PACKAGE_NAME} --allow-scripts=${PACKAGE_NAME}" >&2`,
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${PACKAGE_NAME} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${PACKAGE_NAME} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)
await Bun.write(
  path.join(wrapper, "package.json"),
  JSON.stringify(
    {
      name: PACKAGE_NAME,
      description: `${PRODUCT_NAME} — the AI coding agent.`,
      bin: {
        [COMMAND_NAME]: `./bin/${COMMAND_NAME}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

// One upload at a time: the binaries are ~120 MB each, and parallel uploads over a slow uplink each stall past npm's
// fetch timeout (every package then fails together). Already-published packages are skipped, so a rerun resumes.
for (const [name, packageDir] of Object.entries(dirs)) await publish(packageDir, name, binaries[name]!)
await publish(wrapper, PACKAGE_NAME, version)

console.log(`\nPublished ${PACKAGE_NAME}@${version} (dist-tag: ${Script.channel})`)
console.log(
  `Verify: npm view ${PACKAGE_NAME}@${version} && npm install -g ${PACKAGE_NAME} && ${COMMAND_NAME} --version`,
)

async function stageBinary(packageDir: string, windows: boolean) {
  const bin = path.join(packageDir, "bin")
  const source = path.join(bin, windows ? `${builtBinary}.exe` : builtBinary)
  const dest = path.join(bin, windows ? `${COMMAND_NAME}.exe` : COMMAND_NAME)
  if (!(await Bun.file(source).exists())) throw new Error(`Missing built binary: ${source}`)
  if (source !== dest) await rename(source, dest)
}

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow().quiet()).exitCode === 0
}

async function publish(packageDir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(packageDir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  for (const stale of new Bun.Glob("*.tgz").scanSync({ cwd: packageDir })) {
    await Bun.file(path.join(packageDir, stale)).delete()
  }
  await $`bun pm pack`.cwd(packageDir)
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (
      (
        await $`npm publish *.tgz --access public --tag ${Script.channel} --fetch-timeout=1800000`
          .cwd(packageDir)
          .nothrow()
      ).exitCode === 0
    ) {
      console.log(`published ${name}@${version}`)
      return
    }
    if (await published(name, version)) {
      console.log(`published ${name}@${version} despite the error above`)
      return
    }
    if (attempt === ATTEMPTS) throw new Error(`failed to publish ${name}@${version} after ${ATTEMPTS} attempts`)
    console.log(`retrying ${name}@${version} (attempt ${attempt + 1}/${ATTEMPTS})`)
    await Bun.sleep(attempt * 10_000)
  }
}
