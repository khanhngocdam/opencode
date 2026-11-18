import type { SandboxMount } from "./provider"

// virtio-fs tags cap at 36 bytes; "mnt-" plus a 24-char name plus a dedup
// suffix stays under it.
const MOUNT_GUEST_NAME_MAX = 24

export type GuestMount = {
  path: string
  guestName: string
  guestPath: string
  tag: string
}

// Derives the guest-visible name for a mounted host folder from its basename.
// Handles both separators because WSL sandbox configs carry Windows paths.
export function mountGuestName(path: string, taken: Set<string>) {
  const base =
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? ""
  const sanitized = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, MOUNT_GUEST_NAME_MAX)
  const name = sanitized.length ? sanitized : "folder"
  if (!taken.has(name)) return name
  const suffixed = (i: number): string => (taken.has(`${name}-${i}`) ? suffixed(i + 1) : `${name}-${i}`)
  return suffixed(2)
}

// Maps host mounts onto /mnt/<name> guest paths (vz and bwrap; WSL translates
// through wslpath instead). Names dedupe in list order, so a mount's guest
// path is stable as long as the entries before it keep their basenames.
export function resolveGuestMounts(mounts: SandboxMount[]): GuestMount[] {
  const taken = new Set<string>()
  return mounts.map((mount) => {
    const guestName = mountGuestName(mount.path, taken)
    taken.add(guestName)
    return { path: mount.path, guestName, guestPath: `/mnt/${guestName}`, tag: `mnt-${guestName}` }
  })
}

export type MountValidationError =
  | { code: "duplicate"; path: string }
  | { code: "nested"; path: string; other: string }
  | { code: "unc"; path: string }

// Pure structural validation shared by the desktop IPC handler and (mirrored,
// not imported) the app dialog: no duplicates, no mount nested inside another
// mount or the project directory (it is already reachable there), no UNC
// paths (wslpath cannot automount them). Existence is checked separately by
// whoever owns filesystem access.
export function validateMountPaths(projectDir: string, mounts: SandboxMount[]): MountValidationError | null {
  const project = comparableMountPath(projectDir)
  const seen = new Map<string, string>()
  for (const mount of mounts) {
    if (mount.path.startsWith("\\\\")) return { code: "unc", path: mount.path }
    const normalized = comparableMountPath(mount.path)
    if (seen.has(normalized)) return { code: "duplicate", path: mount.path }
    if (nests(normalized, project)) return { code: "nested", path: mount.path, other: projectDir }
    for (const [other, original] of seen) {
      if (nests(normalized, other)) return { code: "nested", path: mount.path, other: original }
    }
    seen.set(normalized, mount.path)
  }
  return null
}

// Windows paths compare case-insensitively; detection is by shape (drive
// letter or backslash) because this runs for records from either platform.
function comparableMountPath(path: string) {
  const canonical = path.replace(/[/\\]+$/, "").replace(/\\/g, "/")
  return /^[A-Za-z]:|\\/.test(path) ? canonical.toLowerCase() : canonical
}

function nests(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
