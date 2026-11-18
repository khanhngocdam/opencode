import { join } from "node:path"

export const GUEST_WORKSPACE = "/workspace"
export const GUEST_BUNDLE = "/opt/codev"
// Top level, not under /opt: the image's own /opt is bind-mounted read-only
// from the rootfs, so bwrap cannot create a mount point inside it. Only paths
// the image already provides (/opt/codev) or that bwrap creates on its tmpfs
// root (this one, /run/codev, /workspace) can be mounted over.
export const GUEST_BRIDGE = "/codev-bridge"
export const GUEST_RUNTIME = "/run/codev"
export const GUEST_HOME = "/home/codev"
// Fixed ports inside the guest's private network namespace — no conflicts are
// possible there, so no allocation is needed.
export const GUEST_SERVER_PORT = 4096
export const GUEST_BROKER_PORT = 8788
export const GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

export type RootfsEntry = {
  name: string
  symlinkTarget: string | null
}

export type BwrapSpec = {
  rootfsDir: string
  rootfsEntries: RootfsEntry[]
  projectDir: string
  // Extra host folders, already resolved to their /mnt/<name> guest paths.
  mounts?: { path: string; guestPath: string }[]
  bundleDir: string
  bridgeDir: string
  runtimeDir: string
  homeDir: string
  env: Record<string, string>
  command: string[]
  // A file descriptor the child inherits (see provider.ts: stdio slot 3)
  // holding a compiled seccomp program; bwrap installs it just before exec.
  // Absent means no syscall filter.
  seccompFd?: number
}

// Mounts we manage ourselves; a rootfs copy of these must never shadow them.
// "mnt" is here so extra-mount points under /mnt land on bwrap's tmpfs root,
// where bwrap can create them — inside a read-only rootfs bind it cannot.
const MANAGED_ROOTFS_ENTRIES = new Set(["proc", "dev", "sys", "tmp", "run", "home", "workspace", "mnt"])

export function bindableRootfsEntries(entries: RootfsEntry[]) {
  return entries.filter((entry) => !MANAGED_ROOTFS_ENTRIES.has(entry.name))
}

// --unshare-net gives the guest a network namespace whose only interface is
// loopback: the sole paths out are the unix sockets bind-mounted at /run/codev.
// Rootfs binds come first so the workspace/bundle/runtime binds mount over them.
export function buildBwrapArgs(spec: BwrapSpec) {
  return [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-uts",
    "--unshare-ipc",
    "--hostname",
    "codev-sandbox",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...bindableRootfsEntries(spec.rootfsEntries).flatMap((entry) =>
      entry.symlinkTarget
        ? ["--symlink", entry.symlinkTarget, `/${entry.name}`]
        : ["--ro-bind", join(spec.rootfsDir, entry.name), `/${entry.name}`],
    ),
    "--bind",
    spec.projectDir,
    GUEST_WORKSPACE,
    ...(spec.mounts ?? []).flatMap((mount) => ["--bind", mount.path, mount.guestPath]),
    "--ro-bind",
    spec.bundleDir,
    GUEST_BUNDLE,
    "--ro-bind",
    spec.bridgeDir,
    GUEST_BRIDGE,
    "--bind",
    spec.runtimeDir,
    GUEST_RUNTIME,
    "--bind",
    spec.homeDir,
    GUEST_HOME,
    "--chdir",
    GUEST_WORKSPACE,
    "--clearenv",
    // --seccomp, not --add-seccomp-fd: one program is all there is, and the
    // older flag is accepted by every bwrap release rather than only 0.5+.
    ...(spec.seccompFd === undefined ? [] : ["--seccomp", String(spec.seccompFd)]),
    ...Object.entries(spec.env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--",
    ...spec.command,
  ]
}
