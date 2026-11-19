#!/usr/bin/env bun
import { $ } from "bun"
import { PACKAGE_NAME } from "@codev/brand"
import pkg from "../package.json"

// Local release wrapper: `bun run release [channel] [--skip-build]`.
// Version comes from OPENCODE_VERSION (preferred) or packages/cli/package.json.
const skipBuild = process.argv.includes("--skip-build")
const args = process.argv.slice(2).filter((a) => a !== "--skip-build")
const version = process.env.OPENCODE_VERSION ?? pkg.version
const channel = args[0] ?? process.env.OPENCODE_CHANNEL ?? "latest"

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`version ${JSON.stringify(version)} is not a valid release version.`)
  process.exit(1)
}

console.log(`Releasing ${PACKAGE_NAME}@${version} (dist-tag: ${channel}${skipBuild ? ", skipping build" : ""})`)

if (skipBuild) {
  const manifests = [...new Bun.Glob("cli-*/package.json").scanSync({ cwd: `${import.meta.dirname}/../dist` })]
  const built = manifests.length
    ? ((await Bun.file(`${import.meta.dirname}/../dist/${manifests[0]}`).json()) as { version: string }).version
    : undefined
  if (built !== version) {
    console.error(
      built
        ? `dist/ was built for version ${built}, but release wants ${version} — rerun without --skip-build.`
        : "No dist/ found — rerun without --skip-build.",
    )
    process.exit(1)
  }
}

if ((await $`npm whoami`.nothrow().quiet()).exitCode !== 0) {
  console.error("Not logged in to npm. Run `npm login` first.")
  process.exit(1)
}

if ((await $`npm view ${PACKAGE_NAME}@${version} version`.nothrow().quiet()).exitCode === 0) {
  console.error(`${PACKAGE_NAME}@${version} is already published — bump the version first.`)
  process.exit(1)
}

const env = {
  ...process.env,
  OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: channel,
}

if (!skipBuild) await $`bun ${import.meta.dirname}/build.ts`.env(env)
await $`bun ${import.meta.dirname}/publish.ts`.env(env)

console.log(`\nReleased ${PACKAGE_NAME}@${version} (dist-tag: ${channel})`)
console.log(`Verify: npm view ${PACKAGE_NAME}@${version} && npm install -g ${PACKAGE_NAME} && codev2 --version`)
