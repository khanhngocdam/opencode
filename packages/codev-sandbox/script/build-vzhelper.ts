#!/usr/bin/env bun
// Builds the codev-vmm Virtualization.framework helper and ad-hoc signs it
// with the virtualization entitlement so it can run VMs in development.
// Release packaging re-signs it with the desktop app's real identity.
// Pass --universal to build arm64 + x86_64. Each slice is built with --triple
// and merged with lipo: passing swift build several --arch flags hands the
// build to xcbuild, which only full Xcode ships — Command Line Tools setups
// error with "xcbuild executable ... does not exist".
import { $ } from "bun"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../native/vzhelper/", import.meta.url))
const universal = process.argv.includes("--universal")

const slices = await (async () => {
  if (!universal) {
    await $`swift build -c release --package-path ${root}`
    return [`${root}.build/release/codev-vmm`]
  }
  const triples = ["arm64-apple-macosx", "x86_64-apple-macosx"]
  for (const triple of triples) {
    await $`swift build -c release --package-path ${root} --triple ${triple}`
  }
  return triples.map((triple) => `${root}.build/${triple}/release/codev-vmm`)
})()

await $`mkdir -p ${root}dist`
if (slices.length === 1) await $`cp ${slices[0]} ${root}dist/codev-vmm`
else await $`lipo -create ${slices} -output ${root}dist/codev-vmm`
// Sign the merged binary, not the slices: codesign covers every slice of a
// fat Mach-O, and lipo would strip a per-slice signature anyway.
await $`codesign --force --sign - --entitlements ${root}vzhelper.entitlements ${root}dist/codev-vmm`
console.log(`built ${root}dist/codev-vmm${universal ? " (universal)" : ""}`)
