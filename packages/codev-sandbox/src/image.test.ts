import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  imageMarkerPath,
  isAssetStaged,
  localImageAsset,
  partialAssetPath,
  readImageMarker,
  stageAsset,
  stagedAssetPath,
  writeImageMarker,
} from "./image"

const payload = new TextEncoder().encode("codev sandbox image payload")
const payloadSha256 = createHash("sha256").update(payload).digest("hex")

function servePayload() {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests++
      return new Response(payload)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/sandbox/rootfs.tar`,
    requests: () => requests,
    stop: () => server.stop(true),
  }
}

function partialEntries(entries: string[]) {
  return entries.filter((entry) => entry.startsWith("partial-") || entry.endsWith(".partial"))
}

test("stages an asset once, verifies it, and reuses the staged copy", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const server = servePayload()
  const asset = {
    url: server.url,
    sha256: payloadSha256,
    bytes: payload.byteLength,
  }
  const staged = await stageAsset(cacheDir, asset)
  expect(staged).toBe(stagedAssetPath(cacheDir, asset))
  expect(staged).toEndWith(join(asset.sha256, "rootfs.tar"))
  expect(new Uint8Array(await readFile(staged))).toEqual(payload)
  expect(await isAssetStaged(cacheDir, asset)).toBe(true)

  expect(await stageAsset(cacheDir, asset)).toBe(staged)
  expect(server.requests()).toBe(1)

  server.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

test("rejects a corrupted download and leaves nothing behind", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const server = servePayload()
  const asset = {
    url: server.url,
    sha256: "b".repeat(64),
    bytes: payload.byteLength,
  }
  expect(stageAsset(cacheDir, asset)).rejects.toThrow("failed verification")
  await Bun.sleep(20)
  expect(await isAssetStaged(cacheDir, asset)).toBe(false)
  expect(partialEntries(await readdir(cacheDir))).toEqual([])

  server.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

test("rejects a truncated download by byte count", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const server = servePayload()
  const asset = {
    url: server.url,
    sha256: payloadSha256,
    bytes: payload.byteLength + 1,
  }
  expect(stageAsset(cacheDir, asset)).rejects.toThrow("failed verification")

  server.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

test("surfaces http failures with the asset url", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("missing", { status: 404 }) })
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const asset = { url: `http://127.0.0.1:${server.port}/gone.tar`, sha256: "c".repeat(64), bytes: 10 }
  expect(stageAsset(cacheDir, asset)).rejects.toThrow("HTTP 404")

  server.stop(true)
  await rm(cacheDir, { recursive: true, force: true })
})

test("resumes an interrupted download with a range request", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const ranges: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      ranges.push(request.headers.get("range"))
      const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.get("range") ?? "")?.[1] ?? 0)
      return new Response(payload.slice(offset), {
        status: offset > 0 ? 206 : 200,
        headers:
          offset > 0 ? { "content-range": `bytes ${offset}-${payload.byteLength - 1}/${payload.byteLength}` } : {},
      })
    },
  })
  // Cut the first transfer after 10 bytes the way undici surfaces a dropped
  // connection: chunk, then a stream error (Bun's fetch reports a clean EOF
  // for a server-side cut, so the cut is injected client-side).
  let calls = 0
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++
    const response = await fetch(input, init)
    if (calls > 1) return response
    void response.body?.cancel()
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(payload.slice(0, 10))
        },
        // Erroring in pull (after the chunk is consumed) matters: error()
        // discards anything still queued, and the test needs the 10 bytes to
        // reach disk so the retry has something to resume from.
        pull(controller) {
          controller.error(new TypeError("terminated"))
        },
      }),
    )
  }) as typeof fetch
  const asset = {
    url: `http://127.0.0.1:${server.port}/rootfs.tar`,
    sha256: payloadSha256,
    bytes: payload.byteLength,
  }
  const staged = await stageAsset(cacheDir, asset, { fetchImpl, retryDelayMs: 1 })
  expect(new Uint8Array(await readFile(staged))).toEqual(payload)
  expect(ranges).toEqual([null, "bytes=10-"])
  expect(partialEntries(await readdir(cacheDir))).toEqual([])

  server.stop(true)
  await rm(cacheDir, { recursive: true, force: true })
})

test("resumes a partial left behind by an earlier run", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const asset = { url: "http://127.0.0.1:1/rootfs.tar", sha256: payloadSha256, bytes: payload.byteLength }
  await writeFile(partialAssetPath(cacheDir, asset), payload.slice(0, 12))
  const ranges: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      ranges.push(request.headers.get("range"))
      return new Response(payload.slice(12), {
        status: 206,
        headers: { "content-range": `bytes 12-${payload.byteLength - 1}/${payload.byteLength}` },
      })
    },
  })
  const resumable = { ...asset, url: `http://127.0.0.1:${server.port}/rootfs.tar` }
  // The partial is keyed by digest, not URL, so the pre-seeded bytes are reused.
  const staged = await stageAsset(cacheDir, resumable, { retryDelayMs: 1 })
  expect(new Uint8Array(await readFile(staged))).toEqual(payload)
  expect(ranges).toEqual(["bytes=12-"])

  server.stop(true)
  await rm(cacheDir, { recursive: true, force: true })
})

test("gives up after consecutive stalled attempts but keeps the partial for later", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const asset = { url: "https://example.invalid/rootfs.tar", sha256: payloadSha256, bytes: payload.byteLength }
  await writeFile(partialAssetPath(cacheDir, asset), payload.slice(0, 12))
  let attempts = 0
  const fetchImpl = (() => {
    attempts++
    return Promise.reject(new Error("network down"))
  }) as unknown as typeof fetch
  expect(stageAsset(cacheDir, asset, { fetchImpl, retryDelayMs: 1 })).rejects.toThrow("stalled attempts")
  await Bun.sleep(50)
  expect(attempts).toBe(5)
  expect(new Uint8Array(await readFile(partialAssetPath(cacheDir, asset)))).toEqual(payload.slice(0, 12))

  await rm(cacheDir, { recursive: true, force: true })
})

test("restarts from scratch when the server rejects the range", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const asset = { url: "http://127.0.0.1:1/rootfs.tar", sha256: payloadSha256, bytes: payload.byteLength }
  await writeFile(partialAssetPath(cacheDir, asset), new Uint8Array([9, 9, 9]))
  const ranges: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      ranges.push(request.headers.get("range"))
      if (request.headers.get("range")) return new Response("bad range", { status: 416 })
      return new Response(payload)
    },
  })
  const staged = await stageAsset(
    cacheDir,
    { ...asset, url: `http://127.0.0.1:${server.port}/rootfs.tar` },
    { retryDelayMs: 1 },
  )
  expect(new Uint8Array(await readFile(staged))).toEqual(payload)
  expect(ranges).toEqual(["bytes=3-", null])

  server.stop(true)
  await rm(cacheDir, { recursive: true, force: true })
})

test("reports download progress up to the full size", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const server = servePayload()
  const asset = { url: server.url, sha256: payloadSha256, bytes: payload.byteLength }
  const reports: { bytes: number; totalBytes: number }[] = []
  await stageAsset(cacheDir, asset, { onProgress: (progress) => reports.push(progress) })
  expect(reports[0]).toEqual({ bytes: 0, totalBytes: payload.byteLength })
  expect(reports.at(-1)).toEqual({ bytes: payload.byteLength, totalBytes: payload.byteLength })
  expect(reports.every((report, index) => index === 0 || report.bytes >= reports[index - 1]!.bytes)).toBe(true)

  server.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

test("sweeps stale partials from older downloads", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  await writeFile(join(cacheDir, "partial-2b3ad998-legacy"), new Uint8Array([1]))
  await writeFile(join(cacheDir, `${"d".repeat(64)}.partial`), new Uint8Array([2]))
  const server = servePayload()
  const asset = { url: server.url, sha256: payloadSha256, bytes: payload.byteLength }
  await stageAsset(cacheDir, asset)
  expect(partialEntries(await readdir(cacheDir))).toEqual([])

  server.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

test("image markers round-trip and read as null when unreadable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-sandbox-"))
  const asset = { url: "https://host/sandbox/1.0/vz-arm64.tar.gz", sha256: "d".repeat(64), bytes: 42 }

  expect(await readImageMarker(dir)).toBe(null)
  await writeImageMarker(dir, asset)
  expect(await readImageMarker(dir)).toEqual(asset)

  await Bun.write(imageMarkerPath(dir), "not json at all")
  expect(await readImageMarker(dir)).toBe(null)
  await Bun.write(imageMarkerPath(dir), JSON.stringify({ sha256: 5 }))
  expect(await readImageMarker(dir)).toBe(null)

  await rm(dir, { recursive: true, force: true })
})

// A user-supplied image is described the same way a published one is, so the
// providers' marker-and-stage path needs no special case beyond staging.
test("describes a local image file as an asset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-local-image-"))
  const path = join(dir, "vz-arm64.tar.gz")
  await writeFile(path, payload)
  const asset = await localImageAsset(path)
  expect(asset).toEqual({ url: pathToFileURL(path).href, sha256: payloadSha256, bytes: payload.byteLength })
  await rm(dir, { recursive: true, force: true })
})

test("rejects a local image that is not there", async () => {
  expect(localImageAsset(join(tmpdir(), "codev-missing-image.tar.gz"))).rejects.toThrow("does not exist")
})

test("stages a local image where it lies instead of copying it into the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-local-image-"))
  const cacheDir = join(dir, "cache")
  const path = join(dir, "vz-arm64.tar.gz")
  await writeFile(path, payload)
  const asset = await localImageAsset(path)
  const reported: number[] = []
  expect(await stageAsset(cacheDir, asset, { onProgress: (progress) => reported.push(progress.bytes) })).toBe(path)
  // Nothing was downloaded or duplicated, and the dialog still sees a
  // completed progress report rather than a stalled bar.
  expect(await readdir(cacheDir).catch(() => null)).toBeNull()
  expect(reported).toEqual([payload.byteLength])
  await rm(dir, { recursive: true, force: true })
})

test("refuses a local image that has since been deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-local-image-"))
  const path = join(dir, "vz-arm64.tar.gz")
  await writeFile(path, payload)
  const asset = await localImageAsset(path)
  await rm(path)
  expect(stageAsset(join(dir, "cache"), asset)).rejects.toThrow("no longer available")
  await rm(dir, { recursive: true, force: true })
})
