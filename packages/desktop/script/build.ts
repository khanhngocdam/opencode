#!/usr/bin/env bun
import { $ } from "bun"
import { exists } from "node:fs/promises"
import path from "node:path"
import { copyBuiltCliToResources, getCurrentCli, resolveChannel } from "./utils"
import { verifyBundles } from "./verify-bundles"

// Prepares resources/ (icons, metainfo, the bundled CLI) for OPENCODE_CHANNEL and builds the app into out/.
// Codev2 always bundles its locally built CLI; upstream binaries are a different installation.
const dir = path.resolve(import.meta.dir, "..")

const cli = path.resolve(dir, "../cli/dist")

const channel = resolveChannel()

process.chdir(dir)

await $`bun ./script/copy-icons.ts ${channel}`

await $`bun ./script/copy-metainfo.ts ${channel}`

const built = await exists(path.join(cli, getCurrentCli().package.replace("@opencode/", "")))

if (!built)
  throw new Error(`Codev2 desktop builds bundle the CLI from ${cli}; build it first`)

await copyBuiltCliToResources(cli)

await $`bunx electron-vite build`

await verifyBundles(path.join(dir, "out"))
