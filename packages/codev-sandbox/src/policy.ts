import type { SandboxAvailability } from "./provider"

// The sandbox depends on Virtualization.framework with virtio-fs, which needs
// macOS 12+. Below that the feature is hard-blocked: the OS API surface does
// not exist, so proceeding could only waste the user's time.
export const MACOS_MINIMUM_MAJOR = 12

// Windows is warn-never-block: old builds may still work, and a genuine
// incompatibility surfaces as a clear install error rather than a preflight
// refusal. 22000 is the first Windows 11 build; 19045 is Windows 10 22H2, the
// oldest build the sandbox has been tried on, and it works there, so nothing
// between the two warns.
export const WINDOWS_11_FIRST_BUILD = 22000
export const WINDOWS_10_22H2_BUILD = 19045

export const WINDOWS_OLD_WARNING =
  "This Windows version is out of support and may not support WSL2 at all. Installation is likely to fail; upgrading Windows is strongly recommended."

export const MACOS_UNSUPPORTED_MESSAGE = `The sandbox requires macOS ${MACOS_MINIMUM_MAJOR} or later (it depends on Apple's Virtualization framework). Please upgrade macOS to use this feature.`

export function macosSandboxAvailability(productVersion: string): SandboxAvailability {
  const major = Number.parseInt(productVersion, 10)
  if (!Number.isFinite(major)) return { supported: false, message: MACOS_UNSUPPORTED_MESSAGE }
  if (major < MACOS_MINIMUM_MAJOR) return { supported: false, message: MACOS_UNSUPPORTED_MESSAGE }
  return { supported: true, warning: null }
}

// What the published WSL installer needs, when the machine is below it. More
// specific than the tiers below — it names the build and why — so it wins over
// them, and it moves with the manifest rather than with a release: publishing
// a WSL version that raises the floor re-words this warning by itself.
export function windowsInstallerBuildWarning(buildNumber: number, requiredBuild: number) {
  return `This Windows build (${buildNumber}) is older than build ${requiredBuild}, which the WSL installer requires. Setting up the sandbox is likely to fail; update Windows first.`
}

// recommendedMinBuild comes from the WSL installer manifest and is absent
// whenever it could not be read — an offline launch, or a machine new enough
// that asking was not worth a round trip. Absent means fall back to the tiers,
// which is exactly what this did before the manifest existed.
export function windowsSandboxAvailability(
  buildNumber: number | null,
  recommendedMinBuild?: number | null,
): SandboxAvailability {
  if (buildNumber === null) return { supported: true, warning: WINDOWS_OLD_WARNING }
  // Warn-never-block still holds: an old build may yet work, and a real
  // incompatibility surfaces as a clear install error rather than a refusal.
  if (recommendedMinBuild && buildNumber < recommendedMinBuild)
    return { supported: true, warning: windowsInstallerBuildWarning(buildNumber, recommendedMinBuild) }
  // Windows 10 22H2 included: the sandbox has been run there, so it gets the
  // same silence Windows 11 does.
  if (buildNumber >= WINDOWS_10_22H2_BUILD) return { supported: true, warning: null }
  return { supported: true, warning: WINDOWS_OLD_WARNING }
}

// os.release() on Windows looks like "10.0.19045"; the third component is the
// build number the availability tiers are decided on.
export function windowsBuildNumber(osRelease: string) {
  const build = Number.parseInt(osRelease.split(".")[2] ?? "", 10)
  return Number.isFinite(build) ? build : null
}

export function linuxSandboxAvailability(): SandboxAvailability {
  return { supported: true, warning: null }
}
