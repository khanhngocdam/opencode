import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { downloadFile } from "../src/download"

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

// 1 MiB of deterministic bytes — big enough to flow through the stream
// pipeline in multiple chunks.
const PAYLOAD = Buffer.alloc(1024 * 1024, "codev-skillhub-test-")
const PAYLOAD_SHA = sha256(PAYLOAD)

let tempDir: string
let server: Server
let baseUrl: string
// Range header seen per request path, in arrival order.
let rangeLog: (string | undefined)[]
// When true the server ignores Range and always sends the full body with 200.
let ignoreRange = false
// When true the server sends no Content-Length (chunked), as a proxy or a
// streaming origin may.
let omitContentLength = false
// Simulate a middlebox that honors Range but ignores If-Range semantics —
// answering 206 (with the current entity's ETag) even when If-Range mismatches.
let brokenIfRange = false
// Extra objects (path -> body) the server should serve.
let objects: Map<string, Buffer>

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-skillhub-download-"))
  rangeLog = []
  ignoreRange = false
  omitContentLength = false
  brokenIfRange = false
  objects = new Map([["/payload.bin", PAYLOAD]])
  server = createServer((req, res) => {
    const body = objects.get(req.url ?? "")
    if (!body) {
      res.writeHead(404).end()
      return
    }
    // MinIO-style conditional semantics: a per-body ETag, 304 on a matching
    // If-None-Match, and Range honored only when If-Range (if sent) matches.
    const etag = `"${sha256(body).slice(0, 16)}"`
    const range = req.headers.range
    rangeLog.push(range)
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag }).end()
      return
    }
    const ifRange = req.headers["if-range"]
    if (range && !ignoreRange && (brokenIfRange || ifRange === undefined || ifRange === etag)) {
      const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1])
      if (!Number.isFinite(start) || start >= body.length) {
        res.writeHead(416).end()
        return
      }
      const rest = body.subarray(start)
      res.writeHead(206, {
        "Content-Length": String(rest.length),
        "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
        ETag: etag,
      })
      res.end(rest)
      return
    }
    if (omitContentLength) {
      // Bun's node:http computes Content-Length itself when end() receives the
      // whole body, so stream in two writes to force chunked encoding (Node
      // sends chunked either way).
      res.writeHead(200, { ETag: etag })
      res.write(body.subarray(0, 1024))
      setImmediate(() => res.end(body.subarray(1024)))
      return
    }
    res.writeHead(200, { "Content-Length": String(body.length), ETag: etag })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  rmSync(tempDir, { recursive: true, force: true })
})

describe("downloadFile", () => {
  test("downloads, verifies, and renames the partial away", async () => {
    const dest = join(tempDir, "payload.bin")
    const progress: number[] = []
    await downloadFile({
      url: `${baseUrl}/payload.bin`,
      dest,
      sha256: PAYLOAD_SHA,
      endpoint: "test.download",
      onProgress: (p) => progress.push(p.received),
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    expect(existsSync(`${dest}.partial`)).toBe(false)
    expect(progress.at(-1)).toBe(PAYLOAD.length)
  })

  test("is a no-op when the destination already verifies", async () => {
    const dest = join(tempDir, "payload.bin")
    writeFileSync(dest, PAYLOAD)
    await downloadFile({
      url: `${baseUrl}/payload.bin`,
      dest,
      sha256: PAYLOAD_SHA,
      endpoint: "test.download",
    })
    // No request reached the server at all.
    expect(rangeLog).toEqual([])
  })

  test("throws on hash mismatch and removes the partial", async () => {
    const dest = join(tempDir, "payload.bin")
    await expect(
      downloadFile({
        url: `${baseUrl}/payload.bin`,
        dest,
        sha256: "0".repeat(64),
        endpoint: "test.download",
      }),
    ).rejects.toThrow(/SHA-256 mismatch/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.partial`)).toBe(false)
  })

  test("resumes from a .partial via Range and still verifies", async () => {
    const dest = join(tempDir, "payload.bin")
    const HEAD = 100_000
    writeFileSync(`${dest}.partial`, PAYLOAD.subarray(0, HEAD))
    await downloadFile({
      url: `${baseUrl}/payload.bin`,
      dest,
      sha256: PAYLOAD_SHA,
      endpoint: "test.download",
    })
    expect(rangeLog).toEqual([`bytes=${HEAD}-`])
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  })

  test("restarts cleanly when the server ignores Range", async () => {
    ignoreRange = true
    const dest = join(tempDir, "payload.bin")
    writeFileSync(`${dest}.partial`, Buffer.from("stale-garbage"))
    await downloadFile({
      url: `${baseUrl}/payload.bin`,
      dest,
      sha256: PAYLOAD_SHA,
      endpoint: "test.download",
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  })

  test("scraps an oversized stale partial (416) and refetches", async () => {
    const dest = join(tempDir, "payload.bin")
    writeFileSync(`${dest}.partial`, Buffer.alloc(PAYLOAD.length + 10, 1))
    await downloadFile({
      url: `${baseUrl}/payload.bin`,
      dest,
      sha256: PAYLOAD_SHA,
      endpoint: "test.download",
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  })

  // `Number(res.headers.get("content-length"))` is `Number(null)` === 0 when the
  // header is absent, and 0 is finite — reading it straight makes the opts.size
  // fallback unreachable and reports a total of `offset` (0 on a fresh
  // download), which renders as Infinity%.
  test("falls back to the declared size when the server omits content-length", async () => {
    omitContentLength = true
    const dest = join(tempDir, "payload.bin")
    const totals: (number | null)[] = []
    await downloadFile({
      url: `${baseUrl}/payload.bin`,
      dest,
      size: PAYLOAD.length,
      endpoint: "test.download",
      onProgress: (p) => totals.push(p.total),
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    expect(totals.length).toBeGreaterThan(0)
    expect(totals.every((t) => t === PAYLOAD.length)).toBe(true)
  })

  test("reports an unknown total when neither side gives a size", async () => {
    omitContentLength = true
    const dest = join(tempDir, "payload.bin")
    const totals: (number | null)[] = []
    await downloadFile({
      url: `${baseUrl}/payload.bin`,
      dest,
      endpoint: "test.download",
      onProgress: (p) => totals.push(p.total),
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    // null, not 0 — the progress printer branches on it to drop the percentage
    // rather than dividing by zero.
    expect(totals.every((t) => t === null)).toBe(true)
  })

  test("fails with the HTTP status on a missing object", async () => {
    await expect(
      downloadFile({
        url: `${baseUrl}/nope.bin`,
        dest: join(tempDir, "nope.bin"),
        endpoint: "test.download",
      }),
    ).rejects.toThrow(/download failed \(404\)/)
  })
})

describe("downloadFile ETag revalidation", () => {
  test("a finished file is kept when the server answers 304", async () => {
    const dest = join(tempDir, "payload.bin")
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    const before = rangeLog.length
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    // Exactly one request: the conditional probe, no re-download.
    expect(rangeLog.length).toBe(before + 1)
  })

  test("a republished object is re-downloaded (ETag mismatch)", async () => {
    const dest = join(tempDir, "payload.bin")
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    const NEW = Buffer.from("republished-bytes")
    objects.set("/payload.bin", NEW)
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    expect(readFileSync(dest).equals(NEW)).toBe(true)
  })

  test("a file with no ETag on record is trusted without any request", async () => {
    const dest = join(tempDir, "payload.bin")
    writeFileSync(dest, "manually-placed")
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    expect(readFileSync(dest, "utf8")).toBe("manually-placed")
    expect(rangeLog).toEqual([])
  })

  test("a resume across a republish restarts instead of splicing (If-Range)", async () => {
    const dest = join(tempDir, "payload.bin")
    // A partial and ETag from an older publish of the object.
    writeFileSync(`${dest}.partial`, Buffer.from("stale-old-bytes"))
    writeFileSync(`${dest}.etag`, '"stale-etag"')
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    // If-Range mismatched → server sent 200 → clean restart, correct bytes.
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  })

  test("refuses a bare-Range resume of an ETag-less partial without a sha256", async () => {
    const dest = join(tempDir, "payload.bin")
    // A partial with no `.etag` on record (pre-ETag download, or a cleared
    // record). Without an expected sha256 nothing downstream would catch a
    // splice, so the partial must be scrapped, not resumed.
    writeFileSync(`${dest}.partial`, Buffer.from("stale-old-bytes"))
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    // No Range header ever reached the server — a clean full download.
    expect(rangeLog).toEqual([undefined])
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    expect(existsSync(`${dest}.partial`)).toBe(false)
  })

  test("scraps the partial when a broken hop answers 206 across a republish", async () => {
    // A middlebox that honors Range while ignoring If-Range: it answers 206
    // for a republished entity, which used to splice the halves together
    // ("bad zipfile offset" on real bundle downloads).
    brokenIfRange = true
    const dest = join(tempDir, "payload.bin")
    writeFileSync(`${dest}.partial`, Buffer.from("stale-old-bytes"))
    writeFileSync(`${dest}.etag`, '"stale-etag"')
    await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" })
    // The lying 206 carried the new object's ETag → partial scrapped, then
    // a clean full refetch (no Range on the second request).
    expect(rangeLog).toEqual(["bytes=15-", undefined])
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    expect(existsSync(`${dest}.partial`)).toBe(false)
  })
})
