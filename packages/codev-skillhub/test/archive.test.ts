import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { detectAndStripRoot, extractZip, inspectZip } from "../src/archive"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-skillhub-archive-"))
})
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content))
  }
  return zip.toBuffer()
}

function entryNames(buffer: Buffer): string[] {
  return new AdmZip(buffer)
    .getEntries()
    .map((e) => e.entryName)
    .sort()
}

describe("extractZip", () => {
  test("writes nested files under the target dir", async () => {
    const zip = makeZip({
      "SKILL.md": "# hi",
      "scripts/run.sh": "echo hi",
    })
    await extractZip(zip, tempDir)
    expect(readFileSync(join(tempDir, "SKILL.md"), "utf-8")).toBe("# hi")
    expect(readFileSync(join(tempDir, "scripts", "run.sh"), "utf-8")).toBe("echo hi")
  })

  test("rejects a zip-slip entry that escapes the target dir", async () => {
    // AdmZip sanitizes `../` on addFile, so craft the malicious name by
    // overriding entryName directly before serializing.
    const zip = new AdmZip()
    zip.addFile("evil.txt", Buffer.from("pwned"))
    const entry = zip.getEntries()[0]
    if (!entry) throw new Error("fixture setup failed")
    entry.entryName = "../evil.txt"
    const buf = zip.toBuffer()

    await expect(extractZip(buf, tempDir)).rejects.toThrow(/unsafe zip entry/)
    expect(existsSync(join(tempDir, "..", "evil.txt"))).toBe(false)
  })

  test("rejects an archive that decompresses past the size cap", async () => {
    // 101 MB of zeros compresses tiny but inflates past the 100 MB cap.
    const zip = new AdmZip()
    zip.addFile("big.bin", Buffer.alloc(101 * 1024 * 1024))
    await expect(extractZip(zip.toBuffer(), tempDir)).rejects.toThrow(/limit/i)
    // Nothing was written before the cap tripped.
    expect(existsSync(join(tempDir, "big.bin"))).toBe(false)
  })
})

describe("inspectZip", () => {
  test("accepts a normal archive and reports its files/total", () => {
    const buf = makeZip({ "SKILL.md": "hello", "run.sh": "echo hi" })
    const { files, totalBytes } = inspectZip(buf)
    expect(files.sort()).toEqual(["SKILL.md", "run.sh"].sort())
    expect(totalBytes).toBe("hello".length + "echo hi".length)
  })

  test("rejects an archive over the uncompressed size cap", () => {
    const zip = new AdmZip()
    zip.addFile("big.bin", Buffer.alloc(101 * 1024 * 1024))
    expect(() => inspectZip(zip.toBuffer())).toThrow(/limit/i)
  })
})

describe("detectAndStripRoot", () => {
  test("strips a single shared root folder", () => {
    const zip = makeZip({
      "pg-tuner/SKILL.md": "a",
      "pg-tuner/scripts/x.sh": "b",
    })
    const { buffer, stripped } = detectAndStripRoot(zip)
    expect(stripped).toBe("pg-tuner")
    expect(entryNames(buffer)).toEqual(["SKILL.md", "scripts/x.sh"])
  })

  test("leaves the buffer unchanged when there are multiple top-level entries", () => {
    const zip = makeZip({ "SKILL.md": "a", "other.md": "b" })
    const { buffer, stripped } = detectAndStripRoot(zip)
    expect(stripped).toBeNull()
    expect(buffer).toBe(zip)
  })

  test("does not strip when the only shared name is a lone top-level file", () => {
    const zip = makeZip({ "SKILL.md": "a" })
    const { stripped } = detectAndStripRoot(zip)
    expect(stripped).toBeNull()
  })
})

// The hub re-serializes every upload with adm-zip to inject _meta.json, and
// adm-zip's writer keeps each original entry's general-purpose flags while
// never emitting a data descriptor. An upload whose zipper set bit 3 (macOS
// Archive Utility, Windows Explorer, most streaming zippers) therefore comes
// back down with the descriptor flag set, real sizes and crc in both headers,
// and no descriptor after the data. adm-zip 0.5.x refused exactly that shape
// ("No descriptor present"); this rewrites a normal archive into it.
function setDescriptorFlag(buffer: Buffer): Buffer {
  const out = Buffer.from(buffer)
  const LOCSIG = 0x04034b50
  const CENSIG = 0x02014b50
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = out.readUInt32LE(i)
    // general-purpose flags sit at +6 in a local header and +8 in a central one
    if (sig === LOCSIG) out.writeUInt16LE(out.readUInt16LE(i + 6) | 0x08, i + 6)
    if (sig === CENSIG) out.writeUInt16LE(out.readUInt16LE(i + 8) | 0x08, i + 8)
  }
  return out
}

describe("an archive with the data-descriptor flag but no descriptor", () => {
  const files = { "outlook-local/SKILL.md": "# outlook", "outlook-local/scripts/send.ps1": "Send-Mail" }

  test("marks every entry as flagged", () => {
    const zip = setDescriptorFlag(makeZip(files))
    const entries = new AdmZip(zip).getEntries()
    expect(entries.every((e) => (e.header.flags & 0x08) !== 0)).toBe(true)
  })

  test("inspects, strips its root, and extracts", async () => {
    const zip = setDescriptorFlag(makeZip(files))
    expect(inspectZip(zip).files.sort()).toEqual(["outlook-local/SKILL.md", "outlook-local/scripts/send.ps1"])

    const { buffer, stripped } = detectAndStripRoot(zip)
    expect(stripped).toBe("outlook-local")
    expect(entryNames(buffer)).toEqual(["SKILL.md", "scripts/send.ps1"])

    await extractZip(buffer, tempDir)
    expect(readFileSync(join(tempDir, "SKILL.md"), "utf-8")).toBe("# outlook")
    expect(readFileSync(join(tempDir, "scripts", "send.ps1"), "utf-8")).toBe("Send-Mail")
  })

  test("still rejects an entry whose bytes do not match the recorded crc", async () => {
    const zip = setDescriptorFlag(makeZip({ "SKILL.md": "# outlook" }))
    const entry = new AdmZip(zip).getEntry("SKILL.md")!
    // Corrupt the stored crc in the central header; the data is unchanged.
    const CENSIG = 0x02014b50
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (zip.readUInt32LE(i) === CENSIG) zip.writeUInt32LE(entry.header.crc ^ 0xffffffff, i + 16)
    }
    await expect(extractZip(zip, tempDir)).rejects.toThrow(/CRC/i)
  })
})
