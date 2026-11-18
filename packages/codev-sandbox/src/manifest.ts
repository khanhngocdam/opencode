import type { SandboxArch, SandboxBackend } from "./provider"

export type SandboxAsset = {
  url: string
  sha256: string
  bytes: number
}

// The WSL runtime installers, one asset per architecture. `recommendedMinBuild`
// is the Windows build Microsoft supports this WSL version on; the availability
// warning reads it, so publishing a WSL version that raises the floor re-words
// that warning without an app release. Still advisory — Windows stays
// warn-never-block.
export type SandboxWslInstaller = {
  version: string
  recommendedMinBuild: number
  assets: Partial<Record<SandboxArch, SandboxAsset>>
}

export type SandboxManifest = {
  schema: 1
  imageVersion: string
  images: Partial<Record<string, SandboxAsset>>
  // Kept for compatibility, and deliberately not the source the WSL install
  // reads: build-image.ts regenerates this whole document on every image
  // publish, so an installer block recorded here is erased the next time the
  // guest image is rebuilt. The installers ship their own manifest
  // (WSL_INSTALLER_MANIFEST_URL) so the two release cadences stay independent.
  wslInstaller: SandboxWslInstaller | null
}

// The standalone installer manifest: a SandboxWslInstaller with a schema tag,
// published beside the MSIs it points at.
export type WslInstallerManifest = SandboxWslInstaller & { schema: 1 }

export function parseWslInstallerManifest(input: unknown): WslInstallerManifest {
  if (!input || typeof input !== "object") throw new Error("WSL installer manifest must be an object")
  const record = input as Record<string, unknown>
  if (record.schema !== 1) throw new Error(`unsupported WSL installer manifest schema: ${String(record.schema)}`)
  const installer = parseWslInstaller(record)
  if (!installer) throw new Error("WSL installer manifest is empty")
  return { schema: 1, ...installer }
}

export async function fetchWslInstallerManifest(
  url: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<WslInstallerManifest> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const response = await fetchImpl(url, { signal: opts?.signal })
  if (!response.ok) throw new Error(`WSL installer manifest download failed: HTTP ${response.status}`)
  return parseWslInstallerManifest(await response.json())
}

export function requireWslInstallerAsset(manifest: WslInstallerManifest, arch: string) {
  const asset = arch === "x64" || arch === "arm64" ? manifest.assets[arch] : undefined
  // Throwing rather than returning nothing is what makes the caller fall back
  // to Microsoft's installer, which publishes for every architecture Windows
  // runs on.
  if (!asset) throw new Error(`the WSL installer manifest has no ${arch} installer`)
  return asset
}

export function manifestImageKey(backend: SandboxBackend, arch: SandboxArch) {
  return `${backend}-${arch}`
}

export function parseSandboxManifest(input: unknown): SandboxManifest {
  if (!input || typeof input !== "object") throw new Error("sandbox manifest must be an object")
  const record = input as Record<string, unknown>
  if (record.schema !== 1) throw new Error(`unsupported sandbox manifest schema: ${String(record.schema)}`)
  if (typeof record.imageVersion !== "string" || !record.imageVersion.length)
    throw new Error("sandbox manifest is missing imageVersion")
  return {
    schema: 1,
    imageVersion: record.imageVersion,
    images: parseAssets("images", record.images),
    wslInstaller: parseWslInstaller(record.wslInstaller),
  }
}

export async function fetchSandboxManifest(
  url: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<SandboxManifest> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const response = await fetchImpl(url, { signal: opts?.signal })
  if (!response.ok) throw new Error(`sandbox manifest download failed: HTTP ${response.status}`)
  return parseSandboxManifest(await response.json())
}

export function requireImageAsset(manifest: SandboxManifest, backend: SandboxBackend, arch: SandboxArch) {
  const asset = manifest.images[manifestImageKey(backend, arch)]
  if (!asset) throw new Error(`sandbox manifest has no image for ${manifestImageKey(backend, arch)}`)
  return asset
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function parseAssets(label: string, value: unknown) {
  if (!value || typeof value !== "object") throw new Error(`sandbox manifest is missing ${label}`)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, parseAsset(`${label}.${key}`, raw)]),
  )
}

function parseAsset(label: string, value: unknown): SandboxAsset {
  if (!value || typeof value !== "object") throw new Error(`sandbox asset ${label} must be an object`)
  const record = value as Record<string, unknown>
  if (typeof record.url !== "string" || !record.url.startsWith("https://"))
    throw new Error(`sandbox asset ${label} needs an https url`)
  const sha256 = typeof record.sha256 === "string" ? record.sha256.toLowerCase() : ""
  if (!SHA256_HEX.test(sha256)) throw new Error(`sandbox asset ${label} needs a sha256 hex digest`)
  if (typeof record.bytes !== "number" || !Number.isInteger(record.bytes) || record.bytes <= 0)
    throw new Error(`sandbox asset ${label} needs a positive byte size`)
  return { url: record.url, sha256, bytes: record.bytes }
}

function parseWslInstaller(value: unknown): SandboxWslInstaller | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object") throw new Error("sandbox manifest wslInstaller must be an object")
  const record = value as Record<string, unknown>
  if (typeof record.version !== "string" || !record.version.length) throw new Error("wslInstaller needs a version")
  if (typeof record.recommendedMinBuild !== "number" || !Number.isInteger(record.recommendedMinBuild))
    throw new Error("wslInstaller needs a recommendedMinBuild")
  return {
    version: record.version,
    recommendedMinBuild: record.recommendedMinBuild,
    assets: parseAssets("wslInstaller.assets", record.assets),
  }
}
