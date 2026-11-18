import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { finished } from "node:stream/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { SandboxAsset } from "./manifest"
import type { SandboxProgress } from "./provider"

export type StageAssetOptions = {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  retryDelayMs?: number
  onProgress?: (progress: SandboxProgress) => void
}

// Assets are staged content-addressed (<cacheDir>/<sha256>/<filename>) so a
// manifest bump never clobbers an image a running sandbox still uses.
export function stagedAssetPath(cacheDir: string, asset: SandboxAsset) {
  return join(cacheDir, asset.sha256, assetFileName(asset))
}

// In-flight downloads are content-addressed too (<cacheDir>/<sha256>.partial)
// so an interrupted download resumes where it stopped — across retries within
// one call and across separate stageAsset calls. Images are hundreds of MB and
// storage hosts cut long transfers, so resume is load-bearing.
export function partialAssetPath(cacheDir: string, asset: SandboxAsset) {
  return join(cacheDir, `${asset.sha256}.partial`)
}

export async function isAssetStaged(cacheDir: string, asset: SandboxAsset) {
  const file = await stat(stagedAssetPath(cacheDir, asset)).catch(() => null)
  return !!file && file.isFile() && file.size === asset.bytes
}

// Describes a guest image the user supplied from disk instead of the manifest.
// Same shape as a published asset so the providers' marker-and-stage path is
// unchanged, and the digest means a reset still re-provisions when the file
// behind it has changed.
export async function localImageAsset(path: string): Promise<SandboxAsset> {
  const file = await stat(path).catch(() => null)
  if (!file?.isFile()) throw new Error(`sandbox image file does not exist: ${path}`)
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return { url: pathToFileURL(path).href, sha256: hash.digest("hex"), bytes: file.size }
}

export async function stageAsset(cacheDir: string, asset: SandboxAsset, opts?: StageAssetOptions): Promise<string> {
  // A custom image is used where it lies: there is nothing to download, and
  // copying gigabytes into the cache would only duplicate what the user
  // already has on disk.
  if (asset.url.startsWith("file:")) {
    const path = fileURLToPath(asset.url)
    const file = await stat(path).catch(() => null)
    if (!file?.isFile()) throw new Error(`custom sandbox image is no longer available: ${path}`)
    opts?.onProgress?.({ bytes: asset.bytes, totalBytes: asset.bytes })
    return path
  }
  if (await isAssetStaged(cacheDir, asset)) return stagedAssetPath(cacheDir, asset)
  await mkdir(cacheDir, { recursive: true })
  await removeStalePartials(cacheDir, asset)
  const partial = partialAssetPath(cacheDir, asset)
  await download(partial, asset, opts)
  await verifyPartial(partial, asset)
  const destination = stagedAssetPath(cacheDir, asset)
  await mkdir(dirname(destination), { recursive: true })
  await rename(partial, destination)
  return destination
}

// Only this asset's partial may survive: anything else matching a partial
// naming scheme (including the legacy partial-<uuid> files) belongs to an
// asset we are no longer downloading and can never be completed. Assumes a
// single writer per cache dir — the desktop controller runs jobs single-flight.
async function removeStalePartials(cacheDir: string, asset: SandboxAsset) {
  const keep = `${asset.sha256}.partial`
  const entries = await readdir(cacheDir).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry !== keep && (entry.startsWith("partial-") || entry.endsWith(".partial")))
      .map((entry) => rm(join(cacheDir, entry), { force: true })),
  )
}

// Give up only after this many consecutive attempts with no new bytes; an
// attempt that grew the partial resets the counter, so a flaky link can still
// finish a large image through many resumed connections.
const STALLED_ATTEMPT_LIMIT = 5

// Progress callbacks cross an IPC boundary in the desktop app; per-chunk
// reporting would be thousands of events for a large image.
const PROGRESS_INTERVAL_MS = 200

async function download(partial: string, asset: SandboxAsset, opts?: StageAssetOptions) {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const retryDelayMs = opts?.retryDelayMs ?? 500
  let lastReport = 0
  const report = (bytes: number, force = false) => {
    if (!opts?.onProgress) return
    const now = Date.now()
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    opts.onProgress({ bytes, totalBytes: asset.bytes })
  }
  let stalled = 0
  while (true) {
    const offset = await partialSize(partial)
    report(offset, true)
    if (offset >= asset.bytes) return
    const failure = await downloadOnce(partial, asset, offset, fetchImpl, report, opts?.signal)
    // A clean end that is still short means the server's file genuinely
    // differs from the manifest; let verification fail fast instead of
    // retrying a download that can never complete.
    if (!failure) {
      report(await partialSize(partial), true)
      return
    }
    if (opts?.signal?.aborted) throw failure
    stalled = (await partialSize(partial)) > offset ? 0 : stalled + 1
    if (stalled >= STALLED_ATTEMPT_LIMIT)
      throw new Error(
        `sandbox asset download failed for ${asset.url} after ${STALLED_ATTEMPT_LIMIT} stalled attempts: ${failure.message}`,
      )
    await retryDelay(retryDelayMs * stalled, opts?.signal)
  }
}

// One connection attempt: resume from offset when the partial has bytes,
// restart from scratch when the server ignores the range (200) or rejects it
// (416). Returns the failure instead of throwing when a retry could help;
// throws on HTTP errors, which retrying the same URL cannot fix.
async function downloadOnce(
  partial: string,
  asset: SandboxAsset,
  offset: number,
  fetchImpl: typeof fetch,
  report: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<Error | null> {
  const response = await fetchImpl(asset.url, {
    signal,
    headers: offset > 0 ? { range: `bytes=${offset}-` } : undefined,
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (response instanceof Error) return response
  if (response.status === 416) {
    // The partial no longer matches what the server has; start over.
    await rm(partial, { force: true })
    return new Error(`sandbox asset download failed: HTTP 416 for ${asset.url}`)
  }
  if (!response.ok || !response.body)
    throw new Error(`sandbox asset download failed: HTTP ${response.status} for ${asset.url}`)
  const out = createWriteStream(partial, response.status === 206 ? { flags: "a" } : {})
  const copied = await copyBody(response.body, out, response.status === 206 ? offset : 0, asset.bytes, report).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )
  out.end()
  await finished(out).catch(() => {})
  return copied
}

async function copyBody(
  body: NonNullable<Response["body"]>,
  out: ReturnType<typeof createWriteStream>,
  offset: number,
  limit: number,
  report: (bytes: number) => void,
) {
  let written = offset
  for await (const chunk of body) {
    written += chunk.byteLength
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()))
    report(written)
    // A body longer than the manifest says can only fail verification; stop
    // reading rather than let a broken server stream unbounded data.
    if (written > limit) return
  }
}

async function verifyPartial(partial: string, asset: SandboxAsset) {
  const size = await partialSize(partial)
  if (size !== asset.bytes) {
    await rm(partial, { force: true })
    throw new Error(`sandbox asset failed verification for ${asset.url}: expected ${asset.bytes} bytes, got ${size}`)
  }
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(partial)) hash.update(chunk as Buffer)
  const digest = hash.digest("hex")
  if (digest === asset.sha256) return
  await rm(partial, { force: true })
  throw new Error(`sandbox asset failed verification for ${asset.url}: expected sha256 ${asset.sha256}, got ${digest}`)
}

async function partialSize(partial: string) {
  const file = await stat(partial).catch(() => null)
  return file?.isFile() ? file.size : 0
}

function retryDelay(duration: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timeout = setTimeout(done, duration)
    signal?.addEventListener("abort", done, { once: true })
  })
}

function assetFileName(asset: SandboxAsset) {
  const name = basename(new URL(asset.url).pathname)
  return name.length ? name : "asset"
}

// Each provisioned sandbox records which image it was built from, so create
// can skip work when current, and reset doubles as the upgrade path when the
// manifest has moved on. Anything unreadable reads as "unknown" and triggers
// a re-provision — the safe direction.
export function imageMarkerPath(dir: string) {
  return join(dir, "image.json")
}

export async function readImageMarker(dir: string): Promise<SandboxAsset | null> {
  const raw = await readFile(imageMarkerPath(dir), "utf8").catch(() => null)
  if (!raw) return null
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  })()
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>
  if (typeof record.url !== "string" || typeof record.sha256 !== "string" || typeof record.bytes !== "number")
    return null
  return { url: record.url, sha256: record.sha256, bytes: record.bytes }
}

export async function writeImageMarker(dir: string, asset: SandboxAsset) {
  await mkdir(dir, { recursive: true })
  await writeFile(imageMarkerPath(dir), `${JSON.stringify(asset, null, 2)}\n`)
}
