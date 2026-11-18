import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// AF_UNIX paths are capped at 104 bytes on macOS (108 on Linux) — and the
// limit is enforced by silent truncation, so an over-long path binds
// somewhere unintended and the peer then fails with ENOENT. The app's data
// directory alone is ~74 characters, so a sandbox named "codev-work" already
// overflows. Sockets therefore live under a short per-user directory keyed by
// a hash of the sandbox's data dir, which keeps them unique per sandbox and
// well clear of the limit.
export const SANDBOX_SUN_PATH_MAX = 103

export function sandboxSocketDir(sandboxDir: string) {
  return join(tmpdir(), `codev-sbx-${createHash("sha256").update(sandboxDir).digest("hex").slice(0, 10)}`)
}

export async function createSandboxSocketDir(sandboxDir: string) {
  const dir = sandboxSocketDir(sandboxDir)
  // 0700: on Linux the system temp dir is shared, so the sockets inside must
  // not be reachable by other users.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}
