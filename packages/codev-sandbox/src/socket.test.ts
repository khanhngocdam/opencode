import { expect, test } from "bun:test"
import { join } from "node:path"
import { SANDBOX_SUN_PATH_MAX, sandboxSocketDir } from "./socket"

// The failure this guards against is silent: an over-long AF_UNIX path is
// truncated at bind time, so the socket appears where nobody is listening.
test("socket paths stay inside the AF_UNIX limit for realistic sandbox names", () => {
  const appData = "/Users/someone/Library/Application Support/ai.codev.desktop.dev/sandboxes"
  for (const name of ["a", "codev-work", "a-rather-long-sandbox-name-someone-might-type"]) {
    for (const file of ["server.sock", "broker.sock"]) {
      const path = join(sandboxSocketDir(join(appData, name)), file)
      expect(path.length).toBeLessThanOrEqual(SANDBOX_SUN_PATH_MAX)
    }
  }
})

test("each sandbox gets its own socket directory", () => {
  expect(sandboxSocketDir("/data/one")).not.toBe(sandboxSocketDir("/data/two"))
  expect(sandboxSocketDir("/data/one")).toBe(sandboxSocketDir("/data/one"))
})
