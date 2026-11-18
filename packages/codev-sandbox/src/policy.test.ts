import { expect, test } from "bun:test"
import { SANDBOX_CPUS_RANGE, SANDBOX_MEMORY_MIB_RANGE, sandboxResourcesValid } from "./provider"
import {
  MACOS_UNSUPPORTED_MESSAGE,
  WINDOWS_OLD_WARNING,
  linuxSandboxAvailability,
  macosSandboxAvailability,
  windowsBuildNumber,
  windowsInstallerBuildWarning,
  windowsSandboxAvailability,
} from "./policy"

test("blocks the sandbox below macOS 12 with an explanatory message", () => {
  expect(macosSandboxAvailability("11.7.10")).toEqual({ supported: false, message: MACOS_UNSUPPORTED_MESSAGE })
  expect(macosSandboxAvailability("10.15.7")).toEqual({ supported: false, message: MACOS_UNSUPPORTED_MESSAGE })
  expect(macosSandboxAvailability("not-a-version")).toEqual({ supported: false, message: MACOS_UNSUPPORTED_MESSAGE })
})

test("allows the sandbox on macOS 12 and later", () => {
  expect(macosSandboxAvailability("12.0")).toEqual({ supported: true, warning: null })
  expect(macosSandboxAvailability("15.3.1")).toEqual({ supported: true, warning: null })
})

test("never blocks Windows but tiers the warnings", () => {
  expect(windowsSandboxAvailability(26100)).toEqual({ supported: true, warning: null })
  expect(windowsSandboxAvailability(22000)).toEqual({ supported: true, warning: null })
  expect(windowsSandboxAvailability(19045)).toEqual({ supported: true, warning: null })
  expect(windowsSandboxAvailability(19044)).toEqual({ supported: true, warning: WINDOWS_OLD_WARNING })
  expect(windowsSandboxAvailability(17763)).toEqual({ supported: true, warning: WINDOWS_OLD_WARNING })
  expect(windowsSandboxAvailability(null)).toEqual({ supported: true, warning: WINDOWS_OLD_WARNING })
})

test("reads the Windows build number from os.release()", () => {
  expect(windowsBuildNumber("10.0.19045")).toBe(19045)
  expect(windowsBuildNumber("10.0.26100")).toBe(26100)
  expect(windowsBuildNumber("garbage")).toBe(null)
})

test("linux is always eligible at the policy layer", () => {
  expect(linuxSandboxAvailability()).toEqual({ supported: true, warning: null })
})

test("sandbox resource limits accept sane values and reject the rest", () => {
  expect(sandboxResourcesValid({})).toBe(true)
  expect(sandboxResourcesValid({ cpus: 4, memoryMiB: 8192 })).toBe(true)
  expect(sandboxResourcesValid({ cpus: SANDBOX_CPUS_RANGE.max, memoryMiB: SANDBOX_MEMORY_MIB_RANGE.max })).toBe(true)
  expect(sandboxResourcesValid({ cpus: 0 })).toBe(false)
  expect(sandboxResourcesValid({ cpus: 33 })).toBe(false)
  expect(sandboxResourcesValid({ cpus: 2.5 })).toBe(false)
  expect(sandboxResourcesValid({ memoryMiB: 512 })).toBe(false)
  expect(sandboxResourcesValid({ memoryMiB: 131072 })).toBe(false)
  expect(sandboxResourcesValid({ cpus: Number.NaN })).toBe(false)
})

// The installer's own floor comes from the WSL installer manifest, so raising
// it is an upload rather than a release. More specific than the tiers, so it
// wins over them — and still warn-never-block.
test("warns against the installer's own minimum build when the machine is below it", () => {
  expect(windowsSandboxAvailability(18363, 19041)).toEqual({
    supported: true,
    warning: windowsInstallerBuildWarning(18363, 19041),
  })
  // Both builds are named: "update Windows" is not actionable without knowing
  // how far.
  expect(windowsInstallerBuildWarning(18363, 19041)).toContain("18363")
  expect(windowsInstallerBuildWarning(18363, 19041)).toContain("19041")
})

test("a machine above the installer's minimum keeps the tier it was already in", () => {
  // Windows 10 22H2 has been run and works, so clearing the installer's floor
  // there leaves nothing to say.
  expect(windowsSandboxAvailability(19045, 19041)).toEqual({ supported: true, warning: null })
  expect(windowsSandboxAvailability(22631, 19041)).toEqual({ supported: true, warning: null })
})

// Absent whenever the manifest could not be read — an offline launch, or a
// machine new enough that asking was not worth a round trip.
test("an unknown installer minimum falls back to the build tiers", () => {
  expect(windowsSandboxAvailability(19044, null)).toEqual({ supported: true, warning: WINDOWS_OLD_WARNING })
  expect(windowsSandboxAvailability(19044, undefined)).toEqual({ supported: true, warning: WINDOWS_OLD_WARNING })
  expect(windowsSandboxAvailability(null, 19041)).toEqual({ supported: true, warning: WINDOWS_OLD_WARNING })
})
