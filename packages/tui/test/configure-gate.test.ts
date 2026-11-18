import { expect, test } from "bun:test"
import { BackendError } from "@codev/gateway"
import { RETRIES, shouldOpenConfigure, withRetries } from "../src/util/configure-gate"

const idle = { env: "1", route: "home", dialogs: 0, draft: undefined }

test("opens only for CODEV_CONFIGURE=1 on an idle home screen", () => {
  expect(shouldOpenConfigure(idle)).toBe(true)
  expect(shouldOpenConfigure({ ...idle, env: undefined })).toBe(false)
  expect(shouldOpenConfigure({ ...idle, env: "0" })).toBe(false)
  expect(shouldOpenConfigure({ ...idle, route: "session" })).toBe(false)
  expect(shouldOpenConfigure({ ...idle, dialogs: 1 })).toBe(false)
  expect(shouldOpenConfigure({ ...idle, draft: "hello" })).toBe(false)
})

test("withRetries recovers from transient failures and reports each retry", async () => {
  const statuses: string[] = []
  let calls = 0
  const result = await withRetries("Fetching", (text) => statuses.push(text), async () => {
    calls++
    if (calls < 3) throw new Error("flaky")
    return "ok"
  })
  expect(result).toBe("ok")
  expect(statuses).toEqual(["Fetching failed — retrying (1/3)...", "Fetching failed — retrying (2/3)..."])
})

test("withRetries gives up after the retry budget", async () => {
  let calls = 0
  await expect(
    withRetries("Fetching", () => {}, async () => {
      calls++
      throw new Error("down")
    }),
  ).rejects.toThrow("down")
  expect(calls).toBe(RETRIES + 1)
})

test("withRetries does not retry a key refusal", async () => {
  let calls = 0
  const refusal = new BackendError("refused", 403, "domain not allowed", "key_refused")
  await expect(
    withRetries("Fetching", () => {}, async () => {
      calls++
      throw refusal
    }),
  ).rejects.toBe(refusal)
  expect(calls).toBe(1)
})
