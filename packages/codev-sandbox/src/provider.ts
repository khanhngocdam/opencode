import type { SeccompMode } from "./seccomp/policy"

export type SandboxBackend = "vz" | "wsl" | "bwrap"

export type SandboxArch = "x64" | "arm64"

export type SandboxConfig = {
  id: string
  name: string
  backend: SandboxBackend
  projectDir: string
  // Extra host folders shared into the guest alongside projectDir. Host paths
  // only; guest paths are derived at start (they depend on the backend), and
  // absent means none. Shaped as objects so a readOnly flag can be added
  // without migrating persisted records.
  mounts?: SandboxMount[]
  // Set when the user stopped this sandbox, so it stays down across relaunches
  // instead of booting with the rest. Absent means start it, which is what
  // every sandbox persisted before this existed wants.
  stopped?: boolean
  // A guest image file the user supplied instead of the published one. Kept
  // for the sandbox's life because reset re-provisions from it; absent means
  // download the manifest's image, which is the normal path.
  imagePath?: string
  // Set when projectDir is a folder the app made up rather than one the user
  // chose — a sandbox needs a working directory to boot, and the simple Work
  // flow does not ask for one. Nothing here reads it; it exists so the desktop
  // app knows not to show that folder to the user, and so the folder can be
  // cleaned up when the sandbox goes. Persisted rather than derived from the
  // path, so app data moving cannot make the folder reappear.
  placeholderProject?: true
  // Per-sandbox limits, applied by the vz backend at boot. Omitted means the
  // provider default. WSL and bubblewrap ignore them: WSL's limits live in
  // the user's VM-global .wslconfig, and bubblewrap has no cgroup plumbing
  // here yet — so the UI only offers them where they take effect.
  cpus?: number
  memoryMiB?: number
  // Syscall filter mode, applied by the bubblewrap backend only (vz is a VM
  // and needs none; WSL boots the same rootfs but not through bwrap). Absent
  // means the provider default, enforce. No UI sets this yet: it is the
  // per-sandbox escape hatch, editable in the persisted store.
  seccomp?: SeccompMode
}

export type SandboxMount = {
  path: string
}

// A mount as the running guest actually sees it: guestPath is /mnt/<name> on
// vz/bwrap and the wslpath translation on WSL, and mounts the provider
// skipped (folder deleted since it was added) are absent entirely.
export type ResolvedSandboxMount = {
  path: string
  guestPath: string
}

// What a sandbox gets when it sets no limits of its own. Named here rather
// than left as literals in the vz backend because the Add sandbox dialog
// quotes these numbers to the user; they must not drift apart.
export const SANDBOX_DEFAULT_CPUS = 4
export const SANDBOX_DEFAULT_MEMORY_MIB = 4096

// Ceilings keep an unusable VM (0 cpus, 64MiB) or an oversubscribed host out
// of the persisted config; the guest needs real headroom for the office
// toolchain. Both ends inclusive.
export const SANDBOX_CPUS_RANGE = { min: 1, max: 32 } as const
export const SANDBOX_MEMORY_MIB_RANGE = { min: 1024, max: 65536 } as const

export function sandboxResourcesValid(config: { cpus?: number; memoryMiB?: number }) {
  const inRange = (value: number | undefined, range: { min: number; max: number }) =>
    value === undefined || (Number.isInteger(value) && value >= range.min && value <= range.max)
  return inRange(config.cpus, SANDBOX_CPUS_RANGE) && inRange(config.memoryMiB, SANDBOX_MEMORY_MIB_RANGE)
}

export type SandboxRuntime =
  | { kind: "starting" }
  | { kind: "ready"; url: string; username: string | null; password: string | null; mounts: ResolvedSandboxMount[] }
  | { kind: "failed"; message: string }
  | { kind: "stopped" }

export type SandboxItem = {
  config: SandboxConfig
  runtime: SandboxRuntime
}

export type RunningSandbox = {
  url: string
  username: string | null
  password: string
  mounts: ResolvedSandboxMount[]
  stop: () => void
  onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
}

export type SandboxAvailability = { supported: true; warning: string | null } | { supported: false; message: string }

// Image download progress, reported while create/reset stage the guest image.
export type SandboxProgress = { bytes: number; totalBytes: number }

export type SandboxJobOptions = {
  signal?: AbortSignal
  onProgress?: (progress: SandboxProgress) => void
}

export type SandboxProvider = {
  backend: SandboxBackend
  availability(): Promise<SandboxAvailability>
  create(config: SandboxConfig, opts?: SandboxJobOptions): Promise<void>
  start(config: SandboxConfig, opts?: { signal?: AbortSignal }): Promise<RunningSandbox>
  destroy(config: SandboxConfig, opts?: { signal?: AbortSignal }): Promise<void>
  reset(config: SandboxConfig, opts?: SandboxJobOptions): Promise<void>
  // Applies config.mounts to the already-running sandbox without a restart.
  // Only backends where that is possible implement it (WSL: the distro's
  // mount namespace is shared, and automounted drives need no guest work at
  // all); absent means the controller restarts the sandbox instead. Must
  // throw on an unusable mount — it runs before the config is persisted and
  // doubles as the validation gate for the hot path.
  applyMounts?(config: SandboxConfig): Promise<ResolvedSandboxMount[]>
}

export function sandboxServerId(name: string) {
  return `sandbox:${name}`
}
