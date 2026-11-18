#!/usr/bin/env bun
// Publishes built sandbox images to the codev-storage bucket.
// Usage: bun script/publish-image.ts --version 2026.08.1 [--out dist-images]
//                                    [--force]
//
// Uses the MinIO client when CODEV_STORAGE_TARGET is set (an `mc` alias/bucket
// prefix, e.g. "codev/codev-storage"); otherwise prints the exact commands so
// the upload can run wherever the storage credentials live. The versioned
// artifacts upload first and manifest.json last — clients only see a version
// once every artifact it references is in place.
import { $ } from "bun"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { SANDBOX_MANIFEST_URL, sandboxStorageObjectKey } from "../src/const"
import { manifestImageKey, parseSandboxManifest } from "../src/manifest"

const version = argValue("--version")
if (!version) {
  console.error("--version is required")
  process.exit(1)
}
const outDir = argValue("--out") ?? join(process.cwd(), "dist-images")

const manifest = parseSandboxManifest(JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8")))
if (manifest.imageVersion !== version) {
  console.error(`manifest.json is for ${manifest.imageVersion}, not ${version}; rebuild first`)
  process.exit(1)
}
// manifest.json is deliberately unversioned: it is the pointer every client
// reads (SANDBOX_MANIFEST_URL), and publishing replaces it wholesale. A
// partial or dev-versioned upload therefore does not just add a version, it
// retires the working one for whichever platform it omits.
const force = process.argv.includes("--force")
const missing = (["bwrap", "vz"] as const)
  .flatMap((backend) => (["arm64", "x64"] as const).map((arch) => manifestImageKey(backend, arch)))
  .filter((key) => !manifest.images[key])
if (missing.length && !force) {
  console.error(`manifest.json has no ${missing.join(", ")}; those platforms would fail on every sandbox launch`)
  console.error("build the missing arch first, or pass --force to publish a partial manifest")
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+$/.test(version) && !force) {
  console.error(`refusing to publish ${version}: it is not a release version, and every client would be pointed at it`)
  console.error("use a release version like 2026.08.1, or pass --force")
  process.exit(1)
}

// Upload to exactly the locations the manifest advertises: the build script
// derived those URLs from SANDBOX_IMAGES_BASE_URL, and the version guard above
// has already pinned them to this version. A hardcoded prefix here is what
// silently published into a path no client fetches.
const artifacts = Object.values(manifest.images).flatMap((asset) =>
  asset ? [{ name: asset.url.split("/").pop()!, key: sandboxStorageObjectKey(asset.url) }] : [],
)
for (const artifact of artifacts) {
  const file = await stat(join(outDir, artifact.name)).catch(() => null)
  if (!file?.isFile()) {
    console.error(`missing artifact ${artifact.name} in ${outDir}`)
    process.exit(1)
  }
}

const target = process.env.CODEV_STORAGE_TARGET
const uploads = [
  ...artifacts.map((artifact) => [join(outDir, artifact.name), artifact.key] as const),
  [join(outDir, "manifest.json"), sandboxStorageObjectKey(SANDBOX_MANIFEST_URL)] as const,
]
if (!target) {
  console.log("CODEV_STORAGE_TARGET is not set (mc alias/bucket, e.g. codev/codev-storage).")
  console.log("Run these where the storage credentials live:\n")
  for (const [local, remote] of uploads) console.log(`  mc cp ${local} <alias/bucket>/${remote}`)
  process.exit(0)
}
for (const [local, remote] of uploads) {
  console.log(`uploading ${remote}...`)
  await $`mc cp ${local} ${target}/${remote}`
}
console.log(`published sandbox image ${version}`)

function argValue(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}
