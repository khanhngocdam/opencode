import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  detectArch,
  detectPlatform,
  ensureStagingDir,
  formatSize,
  installerArgs,
  migrateLegacyOfficeDir,
  type OfficeArgs,
  officeBundleName,
  officeCrossFlagError,
  officeManualWindowsCommand,
  officeScriptName,
  officeTarget,
  officeUninstallScriptName,
  parseOfficeArgs,
  runSkillOffice,
  uninstallerArgs,
} from "../src/office"

describe("detectPlatform", () => {
  test("maps node platforms to bundle platforms", () => {
    expect(detectPlatform("linux")).toBe("ubuntu")
    expect(detectPlatform("darwin")).toBe("macos")
    expect(detectPlatform("win32")).toBe("windows")
  })

  test("returns null for unsupported platforms", () => {
    expect(detectPlatform("aix")).toBeNull()
    expect(detectPlatform("freebsd")).toBeNull()
  })
})

describe("detectArch", () => {
  test("maps node arches to the uname -m names the bundles use", () => {
    expect(detectArch("arm64", false)).toBe("arm64")
    expect(detectArch("x64", false)).toBe("x86_64")
  })

  test("returns null for arches no bundle is built for", () => {
    expect(detectArch("ia32", false)).toBeNull()
    expect(detectArch("ppc64", false)).toBeNull()
  })

  // An x64 node under Rosetta reports "x64" on an Apple Silicon Mac. Believing
  // it downloads the Intel bundle, which the native-bash setup script then
  // refuses — and re-downloads the arm64 one. 3.2 GB to land 1.6.
  test("Rosetta translation overrides the reported x64", () => {
    expect(detectArch("x64", true)).toBe("arm64")
  })
})

describe("officeTarget", () => {
  test("non-macOS platforms ignore the arch", () => {
    expect(officeTarget("ubuntu", null)).toBe("ubuntu")
    expect(officeTarget("windows", null)).toBe("windows")
    expect(officeTarget("ubuntu", "arm64")).toBe("ubuntu")
  })

  test("macOS resolves to a per-chip target", () => {
    expect(officeTarget("macos", "arm64")).toBe("macos-arm64")
    expect(officeTarget("macos", "x86_64")).toBe("macos-x86_64")
  })

  test("macOS without an arch has no target — never guess a 1.6 GB download", () => {
    expect(officeTarget("macos", null)).toBeNull()
  })
})

describe("parseOfficeArgs", () => {
  test("defaults", () => {
    expect(parseOfficeArgs([])).toEqual({
      downloadOnly: false,
      skipVerify: false,
      forceSkills: false,
      uninstall: false,
      yes: false,
      skillsOnly: false,
      purgeDownloads: false,
    })
  })

  test("all flags, space-separated values", () => {
    const parsed = parseOfficeArgs([
      "--platform",
      "windows",
      "--dir",
      "/tmp/x",
      "--download-only",
      "--skip-verify",
      "--force-skills",
    ])
    expect(parsed).toEqual({
      platform: "windows",
      dir: "/tmp/x",
      downloadOnly: true,
      skipVerify: true,
      forceSkills: true,
      uninstall: false,
      yes: false,
      skillsOnly: false,
      purgeDownloads: false,
    })
  })

  test("uninstall mode with its passthrough flags (unadvertised)", () => {
    const parsed = parseOfficeArgs(["--uninstall", "--yes", "--skills-only", "--purge-downloads"])
    expect(parsed.error).toBeUndefined()
    expect(parsed.uninstall).toBe(true)
    expect(parsed.yes).toBe(true)
    expect(parsed.skillsOnly).toBe(true)
    expect(parsed.purgeDownloads).toBe(true)
  })

  test("rejects install flags combined with --uninstall", () => {
    expect(parseOfficeArgs(["--uninstall", "--skip-verify"]).error).toMatch(/do not apply with --uninstall/)
  })

  test("rejects uninstall passthroughs without --uninstall", () => {
    expect(parseOfficeArgs(["--yes"]).error).toMatch(/require --uninstall/)
  })

  test("--platform=value form", () => {
    expect(parseOfficeArgs(["--platform=macos"]).platform).toBe("macos")
  })

  test("rejects an unknown platform", () => {
    expect(parseOfficeArgs(["--platform", "solaris"]).error).toMatch(/--platform must be one of/)
  })

  test("--arch, both spellings and the aliases people actually type", () => {
    expect(parseOfficeArgs(["--arch", "arm64"]).arch).toBe("arm64")
    expect(parseOfficeArgs(["--arch=x86_64"]).arch).toBe("x86_64")
    expect(parseOfficeArgs(["--arch", "aarch64"]).arch).toBe("arm64")
    expect(parseOfficeArgs(["--arch", "x64"]).arch).toBe("x86_64")
    expect(parseOfficeArgs(["--arch", "Intel"]).arch).toBe("x86_64")
  })

  test("rejects an unknown or missing arch", () => {
    expect(parseOfficeArgs(["--arch", "ppc64"]).error).toMatch(/--arch must be one of/)
    expect(parseOfficeArgs(["--arch"]).error).toMatch(/--arch must be one of/)
  })

  test("rejects --dir without a value", () => {
    expect(parseOfficeArgs(["--dir"]).error).toMatch(/--dir requires a path/)
  })

  test("rejects unknown options", () => {
    expect(parseOfficeArgs(["--wat"]).error).toMatch(/unknown option: --wat/)
  })

  test("--target-user, both spellings", () => {
    expect(parseOfficeArgs(["--target-user", "minhnh49"]).targetUser).toBe("minhnh49")
    expect(parseOfficeArgs(["--target-user=VTS\\minhnh49"]).targetUser).toBe("VTS\\minhnh49")
  })

  test("rejects --target-user without a value", () => {
    expect(parseOfficeArgs(["--target-user"]).error).toMatch(/--target-user requires an account name/)
  })

  // It applies to BOTH modes: install puts the skills in the right profile,
  // uninstall clears them out of it again.
  test("--target-user is legal in install and uninstall mode alike", () => {
    expect(parseOfficeArgs(["--target-user", "jdoe"]).error).toBeUndefined()
    expect(parseOfficeArgs(["--uninstall", "--target-user", "jdoe"]).error).toBeUndefined()
  })
})

// The cross-flag validation is also exported on its own so the CLI's yargs
// handler can reuse it on already-parsed flags.
describe("officeCrossFlagError", () => {
  const base: OfficeArgs = {
    downloadOnly: false,
    skipVerify: false,
    forceSkills: false,
    uninstall: false,
    yes: false,
    skillsOnly: false,
    purgeDownloads: false,
  }

  test("accepts each mode's own flags", () => {
    expect(officeCrossFlagError({ ...base, skipVerify: true, forceSkills: true })).toBeUndefined()
    expect(officeCrossFlagError({ ...base, uninstall: true, yes: true, skillsOnly: true })).toBeUndefined()
  })

  test("rejects install flags in uninstall mode and vice versa", () => {
    expect(officeCrossFlagError({ ...base, uninstall: true, skipVerify: true })).toMatch(
      /do not apply with --uninstall/,
    )
    expect(officeCrossFlagError({ ...base, purgeDownloads: true })).toMatch(/require --uninstall/)
  })
})

// The scripts' own flag names — a drift here silently stops forwarding an
// option the user explicitly asked for.
describe("script argument forwarding", () => {
  test("installer: -TargetUser is forwarded as a separate value token", () => {
    expect(installerArgs(parseOfficeArgs(["--target-user", "jdoe"]), "windows")).toEqual(["-TargetUser", "jdoe"])
  })

  test("installer: combines with the other switches", () => {
    expect(installerArgs(parseOfficeArgs(["--target-user", "jdoe", "--skip-verify"]), "windows")).toEqual([
      "-TargetUser",
      "jdoe",
      "-SkipVerify",
    ])
  })

  test("uninstaller: -TargetUser is forwarded alongside its own switches", () => {
    expect(
      uninstallerArgs(parseOfficeArgs(["--uninstall", "--target-user", "jdoe", "--skills-only", "--yes"]), "windows"),
    ).toEqual(["-TargetUser", "jdoe", "-Yes", "-SkillsOnly"])
  })

  test("nothing is forwarded when the flag is absent", () => {
    expect(installerArgs(parseOfficeArgs([]), "windows")).toEqual([])
    expect(uninstallerArgs(parseOfficeArgs(["--uninstall"]), "windows")).toEqual([])
  })

  // A domain account (VTS\minhnh49) has no space, but a renamed local account
  // can — the printed command has to stay copy-pasteable either way.
  test("the printed Windows command quotes a value containing a space", () => {
    expect(
      officeManualWindowsCommand(
        "codev-office-windows-setup.ps1",
        installerArgs(parseOfficeArgs(["--target-user", "First Last"]), "windows"),
      ),
    ).toBe('powershell -ExecutionPolicy Bypass -File .\\codev-office-windows-setup.ps1 -TargetUser "First Last"')
  })

  test("a domain-qualified account survives unquoted", () => {
    expect(
      officeManualWindowsCommand(
        "codev-office-windows-setup.ps1",
        installerArgs(parseOfficeArgs(["--target-user", "VTS\\minhnh49"]), "windows"),
      ),
    ).toBe("powershell -ExecutionPolicy Bypass -File .\\codev-office-windows-setup.ps1 -TargetUser VTS\\minhnh49")
  })
})

// The names are a contract with the codev-scripts repo (codev-office/*) and
// the codev-storage bucket layout — a drift here is a broken download for
// every user, so the full set is spelled out.
describe("office file names", () => {
  test("bundle names — four bundles, macOS split per chip", () => {
    expect(officeBundleName("ubuntu")).toBe("codev-office-ubuntu.zip")
    expect(officeBundleName("windows")).toBe("codev-office-windows.zip")
    expect(officeBundleName("macos-arm64")).toBe("codev-office-macos-arm64.zip")
    expect(officeBundleName("macos-x86_64")).toBe("codev-office-macos-x86_64.zip")
  })

  // Three scripts, not four: the single macOS script resolves its own bundle
  // from `uname -m`, so splitting the bundles added no script to pick between.
  test("script names", () => {
    expect(officeScriptName("ubuntu")).toBe("codev-office-ubuntu-setup.sh")
    expect(officeScriptName("macos")).toBe("codev-office-macos-setup.sh")
    expect(officeScriptName("windows")).toBe("codev-office-windows-setup.ps1")
  })

  test("uninstall script names", () => {
    expect(officeUninstallScriptName("ubuntu")).toBe("codev-office-ubuntu-uninstall.sh")
    expect(officeUninstallScriptName("macos")).toBe("codev-office-macos-uninstall.sh")
    expect(officeUninstallScriptName("windows")).toBe("codev-office-windows-uninstall.ps1")
  })
})

describe("formatSize", () => {
  test("KB below 1 MB — a 13 KB script must not render as 0.0 MB", () => {
    expect(formatSize(13 * 1024)).toBe("13.0 KB")
    expect(formatSize(0)).toBe("0.0 KB")
  })

  test("MB from 1 MB up", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB")
    expect(formatSize(637_252_608)).toBe("607.7 MB")
  })
})

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

// runSkillOffice reads process.platform to pick the bundle and to decide whether
// the installer may run here. Restores the original descriptor rather than
// re-defining a value, so nothing leaks into the tests that share this process.
async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value, configurable: true })
  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(process, "platform", original)
    else delete (process as { platform?: unknown }).platform
  }
}

// End-to-end through runSkillOffice against a local server standing in for the
// codev-storage bucket (MinIO-style ETag/If-None-Match/If-Range semantics —
// downloadFile relies on them). The test host is linux/macos, so the detected
// platform maps to one of the bash bundles. File names are the deterministic
// contract — no manifest. Note the asymmetry the macOS bundle split introduced:
// the BUNDLE is named per chip, the SCRIPT is not, because the one macOS script
// resolves its own bundle from `uname -m`.
describe("runSkillOffice", () => {
  const hostPlatform = process.platform === "darwin" ? "macos" : "ubuntu"
  const hostTarget = hostPlatform === "macos" ? `macos-${detectArch() ?? "arm64"}` : "ubuntu"
  const bundleName = `codev-office-${hostTarget}.zip`
  const scriptName = `codev-office-${hostPlatform}-setup.sh`
  const BUNDLE = Buffer.from("fake-bundle-bytes")
  const SCRIPT = Buffer.from("#!/bin/sh\nexit 0\n")

  let tempDir: string
  let server: Server
  let baseUrl: string
  // Range header seen per request, in arrival order.
  let rangeLog: (string | undefined)[]
  // Objects (path -> body) the server serves.
  let objects: Map<string, Buffer>

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "codev-office-"))
    rangeLog = []
    objects = new Map<string, Buffer>([
      [`/${bundleName}`, BUNDLE],
      [`/${scriptName}`, SCRIPT],
    ])
    server = createServer((req, res) => {
      const body = objects.get(req.url ?? "")
      if (!body) {
        res.writeHead(404).end()
        return
      }
      const etag = `"${sha256(body).slice(0, 16)}"`
      const range = req.headers.range
      rangeLog.push(range)
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag }).end()
        return
      }
      const ifRange = req.headers["if-range"]
      if (range && (ifRange === undefined || ifRange === etag)) {
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
      res.writeHead(200, { "Content-Length": String(body.length), ETag: etag })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // The runner narrates on stderr — keep the test output clean.
    spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(async () => {
    mock.restore()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("--download-only stages both files and never spawns", async () => {
    const dir = join(tempDir, "office")
    const spawns: string[] = []
    const code = await runSkillOffice(parseOfficeArgs(["--download-only", "--dir", dir]), baseUrl, async (command) => {
      spawns.push(command)
      return 0
    })
    expect(code).toBe(0)
    expect(spawns).toEqual([])
    expect(readFileSync(join(dir, bundleName)).equals(BUNDLE)).toBe(true)
    expect(readFileSync(join(dir, scriptName)).equals(SCRIPT)).toBe(true)
  })

  test("runs the installer via bash with translated flags", async () => {
    const dir = join(tempDir, "office")
    let spawned: { command: string; args: string[]; cwd: string } | null = null
    const code = await runSkillOffice(
      parseOfficeArgs(["--dir", dir, "--skip-verify"]),
      baseUrl,
      async (command, args, cwd) => {
        spawned = { command, args, cwd }
        return 0
      },
    )
    expect(code).toBe(0)
    expect(spawned as unknown).toEqual({
      command: "bash",
      args: [join(dir, scriptName), "--skip-verify"],
      cwd: dir,
    })
  })

  test("propagates the installer's exit code", async () => {
    const dir = join(tempDir, "office")
    const code = await runSkillOffice(parseOfficeArgs(["--dir", dir]), baseUrl, async () => 7)
    expect(code).toBe(7)
  })

  // macOS publishes one bundle per chip. From another OS nothing implies
  // which, and the host's own x64 would be a confident wrong answer costing
  // 1.6 GB — so this must fail loudly instead of picking a default.
  // Pinned to linux so the macOS bundle is always the cross-platform case,
  // whichever machine runs the suite.
  test("a macOS bundle from another OS refuses without --arch", async () => {
    const dir = join(tempDir, "office")
    const spawns: string[] = []
    const code = await withPlatform("linux", () =>
      runSkillOffice(parseOfficeArgs(["--platform", "macos", "--dir", dir]), baseUrl, async (c) => {
        spawns.push(c)
        return 0
      }),
    )
    expect(code).toBe(1)
    expect(spawns).toEqual([])
    expect(existsSync(join(dir, "codev-office-macos-x86_64.zip"))).toBe(false)
    expect(existsSync(join(dir, "codev-office-macos-arm64.zip"))).toBe(false)
  })

  test("--platform macos --arch stages that chip's bundle", async () => {
    objects.set("/codev-office-macos-arm64.zip", BUNDLE)
    objects.set("/codev-office-macos-setup.sh", SCRIPT)
    const dir = join(tempDir, "office")
    const spawns: string[] = []
    const code = await withPlatform("linux", () =>
      runSkillOffice(parseOfficeArgs(["--platform", "macos", "--arch", "arm64", "--dir", dir]), baseUrl, async (c) => {
        spawns.push(c)
        return 0
      }),
    )
    expect(code).toBe(0)
    expect(spawns).toEqual([])
    expect(existsSync(join(dir, "codev-office-macos-arm64.zip"))).toBe(true)
    // One script for both chips — not codev-office-macos-arm64-setup.sh.
    expect(existsSync(join(dir, "codev-office-macos-setup.sh"))).toBe(true)
  })

  test("--arch is refused for the x64-only bundles", async () => {
    const dir = join(tempDir, "office")
    const code = await withPlatform("linux", () =>
      runSkillOffice(
        parseOfficeArgs(["--platform", "windows", "--arch", "arm64", "--dir", dir]),
        baseUrl,
        async () => 0,
      ),
    )
    expect(code).toBe(1)
  })

  test("a cross-platform --platform forces download-only", async () => {
    objects.set("/codev-office-windows.zip", BUNDLE)
    objects.set("/codev-office-windows-setup.ps1", SCRIPT)
    const dir = join(tempDir, "office")
    const spawns: string[] = []
    const code = await runSkillOffice(
      parseOfficeArgs(["--platform", "windows", "--dir", dir]),
      baseUrl,
      async (command) => {
        spawns.push(command)
        return 0
      },
    )
    expect(code).toBe(0)
    expect(spawns).toEqual([])
    expect(existsSync(join(dir, "codev-office-windows.zip"))).toBe(true)
  })

  test("windows staging stages files only and never spawns", async () => {
    // Endpoint protection kills or quarantines anything the CLI launches —
    // the windows flow must only download and print the manual
    // elevated-PowerShell command.
    objects.set("/codev-office-windows.zip", BUNDLE)
    objects.set("/codev-office-windows-setup.ps1", SCRIPT)
    const dir = join(tempDir, "office")
    const spawns: string[] = []
    const code = await runSkillOffice(
      parseOfficeArgs(["--platform", "windows", "--dir", dir, "--skip-verify", "--force-skills"]),
      baseUrl,
      async (command) => {
        spawns.push(command)
        return 0
      },
    )
    expect(code).toBe(0)
    expect(spawns).toEqual([])
    expect(existsSync(join(dir, "codev-office-windows.zip"))).toBe(true)
  })

  test("the manual command carries flags, quoting space-containing values", () => {
    const line = officeManualWindowsCommand("codev-office-windows-setup.ps1", [
      "-SkipVerify",
      "-SkillsRoot",
      "C:\\Users\\Van Phong\\.claude\\skills",
    ])
    expect(line).toContain("powershell -ExecutionPolicy Bypass -File .\\codev-office-windows-setup.ps1 -SkipVerify")
    // Space-containing paths are quoted so copy-paste survives them.
    expect(line).toContain('-SkillsRoot "C:\\Users\\Van Phong\\.claude\\skills"')
  })

  test("ensureStagingDir falls back when the preferred dir is unwritable", () => {
    const locked = join(tempDir, "locked")
    mkdirSync(locked, { recursive: true })
    chmodSync(locked, 0o555)
    const preferred = join(locked, "codev-office")
    const fallback = join(tempDir, "fallback-office")
    try {
      const dir = ensureStagingDir(preferred, fallback)
      expect(dir).toBe(fallback)
      expect(existsSync(fallback)).toBe(true)
    } finally {
      chmodSync(locked, 0o755)
    }
    // Writable preferred dir wins; no fallback means errors propagate.
    const fine = join(tempDir, "fine")
    expect(ensureStagingDir(fine, fallback)).toBe(fine)
    expect(() => ensureStagingDir(preferred, null)).not.toThrow() // now writable again
  })

  test("migrateLegacyOfficeDir moves files without clobbering", () => {
    const from = join(tempDir, "legacy-office")
    const to = join(tempDir, "public-office")
    mkdirSync(from, { recursive: true })
    mkdirSync(to, { recursive: true })
    writeFileSync(join(from, "bundle.zip"), "old-bundle")
    writeFileSync(join(from, "kept.txt"), "from-legacy")
    writeFileSync(join(to, "kept.txt"), "already-new")
    migrateLegacyOfficeDir(from, to)
    // Moved when absent at the destination, left alone when present.
    expect(readFileSync(join(to, "bundle.zip"), "utf8")).toBe("old-bundle")
    expect(readFileSync(join(to, "kept.txt"), "utf8")).toBe("already-new")
    expect(existsSync(join(from, "bundle.zip"))).toBe(false)
    // A missing source dir is a no-op, not an error.
    migrateLegacyOfficeDir(join(tempDir, "nope"), to)
  })

  test("always refetches the setup script, but reuses a finished bundle", async () => {
    const dir = join(tempDir, "office")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, scriptName), "stale-script")
    writeFileSync(join(dir, bundleName), "stale-bundle")
    const code = await runSkillOffice(parseOfficeArgs(["--download-only", "--dir", dir]), baseUrl)
    expect(code).toBe(0)
    expect(readFileSync(join(dir, scriptName)).equals(SCRIPT)).toBe(true)
    // No checksum to disagree with, so the existing bundle is trusted as-is.
    expect(readFileSync(join(dir, bundleName), "utf8")).toBe("stale-bundle")
  })

  // The other half of "always refetch the script": deleting the finished file
  // alone still leaves downloadFile resuming from a leftover .partial via Range,
  // and no checksum is passed that could catch the splice.
  test("drops a stale .partial for the script instead of resuming onto it", async () => {
    const dir = join(tempDir, "office")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${scriptName}.partial`), "##")
    const code = await runSkillOffice(parseOfficeArgs(["--download-only", "--dir", dir]), baseUrl)
    expect(code).toBe(0)
    expect(readFileSync(join(dir, scriptName)).equals(SCRIPT)).toBe(true)
    // Both requests went out without a Range header.
    expect(rangeLog).toEqual([undefined, undefined])
  })

  // The PowerShell branch is unreachable from a non-Windows host — a
  // cross-platform --platform forces download-only — so the host is stubbed to
  // keep the argv shape pinned on the Linux/macOS machines that run this suite.
  test("a Windows host never spawns the installer", async () => {
    objects.set("/codev-office-windows.zip", BUNDLE)
    objects.set("/codev-office-windows-setup.ps1", SCRIPT)
    const dir = join(tempDir, "office")
    let spawned: { command: string; args: string[]; cwd: string } | null = null
    const code = await withPlatform("win32", () =>
      runSkillOffice(parseOfficeArgs(["--dir", dir, "--skip-verify"]), baseUrl, async (command, args, cwd) => {
        spawned = { command, args, cwd }
        return 0
      }),
    )
    expect(code).toBe(0)
    expect(spawned).toBeNull()
  })

  test("exits 1 on an OS with no bundle and downloads nothing", async () => {
    const code = await withPlatform("freebsd", () =>
      runSkillOffice(parseOfficeArgs(["--dir", join(tempDir, "office")]), baseUrl),
    )
    expect(code).toBe(1)
    expect(rangeLog).toEqual([])
  })

  test("exits 1 on an unknown flag and downloads nothing", async () => {
    expect(await runSkillOffice(parseOfficeArgs(["--wat"]), baseUrl)).toBe(1)
    expect(rangeLog).toEqual([])
  })

  test("fails cleanly when the bundle is not published", async () => {
    objects.delete(`/${bundleName}`)
    const code = await runSkillOffice(parseOfficeArgs(["--dir", join(tempDir, "office")]), baseUrl)
    expect(code).toBe(1)
  })

  test("--uninstall fetches only the uninstall script and runs it with passthroughs", async () => {
    const uninstallName = `codev-office-${hostPlatform}-uninstall.sh`
    objects.set(`/${uninstallName}`, SCRIPT)
    const dir = join(tempDir, "office")
    let spawned: { command: string; args: string[] } | null = null
    const code = await runSkillOffice(
      parseOfficeArgs(["--uninstall", "--yes", "--skills-only", "--dir", dir]),
      baseUrl,
      async (command, args) => {
        spawned = { command, args }
        return 0
      },
    )
    expect(code).toBe(0)
    expect(spawned as unknown).toEqual({
      command: "bash",
      args: [join(dir, uninstallName), "--yes", "--skills-only"],
    })
    // The bundle is never touched in uninstall mode.
    expect(existsSync(join(dir, bundleName))).toBe(false)
  })
})

const NO_FLAGS: OfficeArgs = {
  downloadOnly: false,
  skipVerify: false,
  forceSkills: false,
  uninstall: false,
  yes: false,
  skillsOnly: false,
  purgeDownloads: false,
}

describe("installerArgs", () => {
  const base = {
    ...NO_FLAGS,
    skipVerify: true,
    forceSkills: true,
  }

  test("bash platforms get GNU-style flags", () => {
    expect(installerArgs(base, "ubuntu")).toEqual(["--skip-verify", "--force-skills"])
  })

  test("windows gets PowerShell switches", () => {
    expect(installerArgs(base, "windows")).toEqual(["-SkipVerify", "-ForceSkills"])
  })

  test("no flags when none requested", () => {
    expect(installerArgs(NO_FLAGS, "windows")).toEqual([])
  })
})

describe("uninstallerArgs", () => {
  const base = {
    ...NO_FLAGS,
    uninstall: true,
    yes: true,
    skillsOnly: true,
    purgeDownloads: true,
  }

  test("bash platforms get GNU-style flags", () => {
    expect(uninstallerArgs(base, "ubuntu")).toEqual(["--yes", "--skills-only", "--purge-downloads"])
  })

  test("windows gets PowerShell switches", () => {
    expect(uninstallerArgs(base, "windows")).toEqual(["-Yes", "-SkillsOnly", "-PurgeDownloads"])
  })
})
