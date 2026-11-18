import { homedir } from "node:os"
import { join } from "node:path"

// CODEV_TEST_HOME rather than HOME (core Global convention): Bun's homedir()
// ignores runtime HOME changes, which subprocess tests rely on.
export function home(): string {
  return process.env.CODEV_TEST_HOME ?? homedir()
}

// Where `codev skill office` stages the offline bundle + setup script (up to
// ~3GB). Kept between runs so a re-run resumes an interrupted download or
// verifies the existing files instead of re-downloading. Shared with the hub's
// `codevhub skill office` — same paths, so bundles downloaded by either CLI
// are reused by the other.
//
// Windows uses a PROFILE-INDEPENDENT folder (%PUBLIC%\Downloads\codev-office):
// %USERPROFILE% diverges between a normal and an elevated shell when the UAC
// prompt is approved with a different admin account, and users kept looking
// for the files under the wrong profile. C:\Users\Public is the same path for
// every account, world-writable, not OneDrive-synced, and not targeted by
// Storage Sense cleanup.
export function officeDownloadsDir(): string {
  if (process.platform === "win32") {
    return join(process.env.PUBLIC ?? "C:\\Users\\Public", "Downloads", "codev-office")
  }
  return join(home(), ".codev-hub", "office")
}

// The pre-Public staging dir on Windows — kept only so runSkillOffice can
// migrate already-downloaded files (a bundle is GBs; never re-download it
// just because the folder moved).
export function legacyOfficeDownloadsDir(): string {
  return join(home(), ".codev-hub", "office")
}
