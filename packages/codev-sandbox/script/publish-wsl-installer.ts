#!/usr/bin/env bun
// Publishes the WSL runtime installers and their manifest to codev-storage.
// Usage: bun script/publish-wsl-installer.ts --version 2.7.11 [--in dist-wsl]
//
// Expects the MSIs Microsoft publishes for a release, named as they come:
//   wsl.<version>.0.x64.msi, wsl.<version>.0.arm64.msi
// from https://github.com/microsoft/WSL/releases/tag/<version>
//
// Uses the MinIO client when CODEV_STORAGE_TARGET is set (an `mc` alias/bucket
// prefix, e.g. "codev/codev-storage"); otherwise prints the exact commands so
// the upload can run wherever the storage credentials live. The installers
// upload first and manifest.json last — clients only see a version once every
// file it names is in place.
import { $ } from "bun"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { WSL_INSTALLER_MANIFEST_URL, sandboxStorageObjectKey, wslInstallerAssetUrl } from "../src/const"
import { parseWslInstallerManifest } from "../src/manifest"
import type { SandboxArch } from "../src/provider"

const version = argValue("--version")
if (!version) {
  console.error("--version is required (e.g. 2.7.11)")
  process.exit(1)
}
const inDir = argValue("--in") ?? join(process.cwd(), "dist-wsl")

// Every architecture, always. A manifest naming one of them retires the other:
// clients read this single document, and an arch it omits falls back to
// Microsoft's servers — which is exactly what the whitelisted fleet cannot
// reach.
const ARCHES: SandboxArch[] = ["x64", "arm64"]

const assets: Record<string, { url: string; sha256: string; bytes: number }> = {}
for (const arch of ARCHES) {
  const url = wslInstallerAssetUrl(version, arch)
  const name = url.split("/").pop()!
  const file = join(inDir, name)
  const found = await stat(file).catch(() => null)
  if (!found?.isFile()) {
    console.error(`missing ${name} in ${inDir}`)
    console.error(`download it from https://github.com/microsoft/WSL/releases/tag/${version}`)
    process.exit(1)
  }
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  assets[arch] = { url, sha256: hash.digest("hex"), bytes: found.size }
  console.log(`  ${arch}: ${(found.size / 1024 / 1024).toFixed(0)} MiB  sha256 ${assets[arch]!.sha256.slice(0, 12)}…`)
}

// Windows 10 2004 (19041) is Microsoft's floor for the MSI-packaged WSL, and
// Windows 11 is above it by construction. The app warns machines below this
// before they try, so raising it here changes what they are told.
const manifest = parseWslInstallerManifest({ schema: 1, version, recommendedMinBuild: 19041, assets })
const manifestPath = join(inDir, "manifest.json")
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\nwrote ${manifestPath}`)

const target = process.env.CODEV_STORAGE_TARGET
const uploads = [
  ...ARCHES.map((arch) => ({
    file: join(inDir, assets[arch]!.url.split("/").pop()!),
    key: sandboxStorageObjectKey(assets[arch]!.url),
  })),
  { file: manifestPath, key: sandboxStorageObjectKey(WSL_INSTALLER_MANIFEST_URL) },
]
if (!target) {
  console.log("\nCODEV_STORAGE_TARGET is unset; run these where the storage credentials live:")
  for (const upload of uploads) console.log(`  mc cp ${upload.file} <alias>/<bucket>/${upload.key}`)
  process.exit(0)
}
for (const upload of uploads) {
  console.log(`uploading ${upload.key}...`)
  await $`mc cp ${upload.file} ${target}/${upload.key}`
}
console.log(`\npublished WSL ${version}`)

function argValue(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}
