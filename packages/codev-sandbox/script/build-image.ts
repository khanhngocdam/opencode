#!/usr/bin/env bun
// Builds the sandbox guest images with Docker (fully containerized: works the
// same on macOS and Linux). Produces, per arch:
//   bwrap-<arch>.tar.gz  rootfs tarball (bubblewrap now, wsl --import later)
//   vz-<arch>.tar.gz     vmlinux + rootfs.img for Virtualization.framework
// plus a manifest.json matching src/manifest.ts.
//
// Usage:
//   bun script/build-image.ts --version 2026.08.1
//     [--arch arm64] [--arch x64]        default: host arch only (x64 under
//                                        emulation is slow; run on a native
//                                        host or CI for the other arch)
//     [--office-bundle path.zip]         codev-office bundle; its skill zips
//                                        and pure-JS node-module zips are
//                                        baked in (other parts are fetched
//                                        arch-correct during the build)
//     [--no-office]                      base toolchain only
//     [--backend bwrap] [--backend vz]   default: both. bwrap alone skips the
//                                        kernel and ext4 steps, which is what
//                                        makes a cross-arch x64 build
//                                        practical: WSL and bubblewrap consume
//                                        the rootfs tarball and supply their
//                                        own kernel, so only vz needs one.
//     [--skip-kernel]                    reuse an existing vmlinux-<arch>
//     [--out dir]                        default: dist-images/
import { $ } from "bun"
import { createHash } from "node:crypto"
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { arch as hostArch } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SANDBOX_IMAGES_BASE_URL } from "../src/const"
import { parseSandboxManifest, type SandboxAsset } from "../src/manifest"
import type { SandboxArch, SandboxBackend } from "../src/provider"

const imageDir = fileURLToPath(new URL("../image/", import.meta.url))
const DISK_SIZE = "8G"

const version = argValue("--version")
if (!version) {
  console.error("--version is required (e.g. 2026.08.1)")
  process.exit(1)
}
const archs = collectArchs()
const backends = collectBackends()
const officeBundle = argValue("--office-bundle")
const office = process.argv.includes("--no-office") ? "0" : "1"
const skipKernel = process.argv.includes("--skip-kernel")
const outDir = argValue("--out") ?? join(process.cwd(), "dist-images")
await mkdir(outDir, { recursive: true })

// Slow corporate registries can exceed buildkit's metadata deadline; the
// FROMs are digest-pinned and this prepull primes the local store. It reduces
// but does not remove remote resolution: buildkit still resolves the FROM and
// can fail with "load metadata ... DeadlineExceeded" even once the image is
// local, so every registry-facing step goes through retry() below.
const BASE_IMAGE = "debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241"
await retry("base image pull", () => $`docker pull ${BASE_IMAGE}`.quiet().nothrow())

await stageOfficeBundle()

const assets: Record<string, SandboxAsset> = {}
for (const arch of archs) {
  const docker = arch === "x64" ? "amd64" : "arm64"
  console.log(`\n=== ${arch} (linux/${docker}) ===`)

  console.log("building guest image...")
  await retry("guest image build", () =>
    $`docker buildx build --platform linux/${docker} --build-arg OFFICE=${office} -t codev-sandbox-guest:${arch} --load ${imageDir}`.nothrow(),
  )
  console.log("building tools image...")
  await retry("tools image build", () =>
    $`docker buildx build --platform linux/${docker} -t codev-sandbox-tools:${arch} --load ${join(imageDir, "tools")}`.nothrow(),
  )

  // The rootfs tarball feeds both backends: bwrap and wsl --import ship it
  // as-is, and the vz ext4 disk is built from it.
  console.log("exporting rootfs tarball...")
  const cid = (await $`docker create --platform linux/${docker} codev-sandbox-guest:${arch}`.text()).trim()
  const bwrapTar = join(outDir, `bwrap-${arch}.tar`)
  await $`docker export ${cid} -o ${bwrapTar}`
  await $`docker rm ${cid}`.quiet()
  await $`docker run --rm -v ${outDir}:/out codev-sandbox-tools:${arch} gzip -f -6 /out/bwrap-${arch}.tar`
  if (backends.includes("bwrap")) assets[`bwrap-${arch}`] = await describeAsset(join(outDir, `bwrap-${arch}.tar.gz`))

  if (backends.includes("vz")) {
    console.log("building ext4 disk...")
    await $`docker run --rm -v ${outDir}:/out codev-sandbox-tools:${arch} sh -ec ${[
      `mkdir /r`,
      `tar -xzf /out/bwrap-${arch}.tar.gz -C /r`,
      `truncate -s ${DISK_SIZE} /out/rootfs-${arch}.img`,
      `mkfs.ext4 -F -q -d /r /out/rootfs-${arch}.img`,
    ].join(" && ")}`

    const kernel = join(outDir, `vmlinux-${arch}`)
    if (!skipKernel) {
      console.log("building kernel (cached after the first run)...")
      await retry("kernel build", () =>
        $`docker buildx build --platform linux/${docker} --target build -t codev-sandbox-kernel:${arch} --load ${join(imageDir, "kernel")}`.nothrow(),
      )
      const kernelCid = (
        await $`docker create --platform linux/${docker} codev-sandbox-kernel:${arch} true`.text()
      ).trim()
      await $`docker cp ${kernelCid}:/out/vmlinux ${kernel}`
      await $`docker rm ${kernelCid}`.quiet()
    }
    if (!(await stat(kernel).catch(() => null))) {
      console.error(`missing ${kernel}; run without --skip-kernel`)
      process.exit(1)
    }

    console.log("assembling vz tarball...")
    const vzStage = join(outDir, `vz-${arch}`)
    await rm(vzStage, { recursive: true, force: true })
    await mkdir(vzStage, { recursive: true })
    await cp(kernel, join(vzStage, "vmlinux"))
    await $`docker run --rm -v ${outDir}:/out codev-sandbox-tools:${arch} sh -ec ${[
      `mv /out/rootfs-${arch}.img /out/vz-${arch}/rootfs.img`,
      `tar -Sczf /out/vz-${arch}.tar.gz -C /out/vz-${arch} vmlinux rootfs.img`,
    ].join(" && ")}`
    await rm(vzStage, { recursive: true, force: true })
    assets[`vz-${arch}`] = await describeAsset(join(outDir, `vz-${arch}.tar.gz`))
  }
}

const manifest = parseSandboxManifest({
  schema: 1,
  imageVersion: version,
  images: assets,
  wslInstaller: null,
})
await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`\nwrote ${join(outDir, "manifest.json")}`)
for (const [key, asset] of Object.entries(assets)) {
  console.log(`  ${key}: ${(asset.bytes / 1024 / 1024).toFixed(0)} MiB  sha256 ${asset.sha256.slice(0, 12)}…`)
}
console.log(`publish with: bun script/publish-image.ts --version ${version} --out ${outDir}`)

// Bounded retry for the registry-facing steps. Buildkit's metadata resolve is
// the flaky one on a slow link; buildx keeps completed layers cached, so a
// retry resumes the build instead of restarting it.
async function retry(label: string, run: () => Promise<{ exitCode: number }>) {
  for (let attempt = 1; ; attempt++) {
    const result = await run()
    if (result.exitCode === 0) return
    if (attempt >= 3) {
      console.error(`${label} failed after ${attempt} attempts; check registry access`)
      process.exit(1)
    }
    console.log(`${label} failed (attempt ${attempt}); retrying...`)
  }
}

function argValue(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function collectBackends(): SandboxBackend[] {
  const flags = process.argv.flatMap((value, index) => (value === "--backend" ? [process.argv[index + 1]] : []))
  if (!flags.length) return ["bwrap", "vz"]
  const selected = flags.filter((value): value is SandboxBackend => value === "bwrap" || value === "vz")
  if (selected.length !== flags.length) {
    console.error("--backend accepts bwrap or vz")
    process.exit(1)
  }
  return selected
}

function collectArchs(): SandboxArch[] {
  const flags = process.argv.flatMap((value, index) => (value === "--arch" ? [process.argv[index + 1]] : []))
  if (flags.length) return flags.filter((value): value is SandboxArch => value === "arm64" || value === "x64")
  return [hostArch() === "arm64" ? "arm64" : "x64"]
}

// The whole office bundle enters the build: install-office.sh installs the
// versions it pins, which means it needs the artifacts themselves (dotnet
// tarball, LibreOffice debs, pandoc deb, wheels, the offline NuGet feed and
// Playwright's chromium), not just the arch-independent zips. Its x86_64
// binaries are used as-is on amd64; the arm64 build reads the versions off
// these same filenames and fetches those versions arch-correct.
//
// macOS artifacts are dropped: nothing in a Linux guest can use them and they
// are a large share of the bundle. Bind-mounted rather than COPYed by the
// Dockerfile, so none of this lands in an image layer.
async function stageOfficeBundle() {
  // Clear previous contents only — the dir's tracked .gitignore/.keep stay.
  const stage = join(imageDir, "office", "bundle")
  await mkdir(stage, { recursive: true })
  for (const name of await readdir(stage)) {
    if (name !== ".gitignore" && name !== ".keep") await rm(join(stage, name), { recursive: true, force: true })
  }
  if (!officeBundle) return
  const scratch = join(outDir, "office-bundle-stage")
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  await $`unzip -q -o ${officeBundle} -d ${scratch}`
  const dirs = await readdir(scratch)
  const root = dirs.length === 1 ? join(scratch, dirs[0]!) : scratch
  const wanted = (await readdir(root)).filter((name) => !/macos|osx|\.dmg$/i.test(name))
  for (const name of wanted) await cp(join(root, name), join(stage, name), { recursive: true })
  await rm(scratch, { recursive: true, force: true })
  console.log(`staged from office bundle: ${wanted.join(", ") || "(nothing matched)"}`)
}

async function describeAsset(path: string): Promise<SandboxAsset> {
  const file = Bun.file(path)
  const hash = createHash("sha256")
  for await (const chunk of file.stream()) hash.update(chunk)
  return {
    // basename, not split("/"): a Windows build hands this a backslash path,
    // which split("/") returns whole and the manifest URL swallows verbatim.
    url: `${SANDBOX_IMAGES_BASE_URL}/${version}/${basename(path)}`,
    sha256: hash.digest("hex"),
    bytes: file.size,
  }
}
