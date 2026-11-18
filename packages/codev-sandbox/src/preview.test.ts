import { expect, test } from "bun:test"
import { sandboxPreviewAvailability } from "./preview"

const disabled = { supported: false, reason: "Codev2 Work sandbox is not enabled on this preview build" } as const
const pending = { supported: false, reason: "guest v2 server image pending" } as const

test("is unsupported unless the codev_sandbox flag is set", () => {
  expect(sandboxPreviewAvailability({}, "linux")).toEqual(disabled)
  expect(sandboxPreviewAvailability({ OPENCODE_FLAGS: "full_codemode,codev_upload" }, "darwin")).toEqual(disabled)
  expect(sandboxPreviewAvailability({ OPENCODE_FLAGS: "codev_sandbox_other" }, "win32")).toEqual(disabled)
})

test("stays unsupported with the flag set while the guest image is pending", () => {
  for (const platform of ["linux", "win32", "darwin"])
    expect(sandboxPreviewAvailability({ OPENCODE_FLAGS: "codev_sandbox" }, platform)).toEqual(pending)
  expect(sandboxPreviewAvailability({ OPENCODE_FLAGS: "full_codemode, codev_sandbox" }, "linux")).toEqual(pending)
})

test("ignores the flag on unsupported platforms", () => {
  expect(sandboxPreviewAvailability({ OPENCODE_FLAGS: "codev_sandbox" }, "freebsd")).toEqual(disabled)
})

