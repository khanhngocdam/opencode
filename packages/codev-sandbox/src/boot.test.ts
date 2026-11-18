import { expect, test } from "bun:test"
import { checkSandboxHealth, generateSandboxCredentials, pollSandboxHealth, sandboxBootEnv } from "./boot"

test("boot env mirrors the WSL sidecar contract and carries the server address", () => {
  expect(
    sandboxBootEnv({ username: "codev", password: "secret" }, "/home/codev", { hostname: "127.0.0.1", port: 4096 }),
  ).toEqual({
    CODEV_SERVER_USERNAME: "codev",
    CODEV_SERVER_PASSWORD: "secret",
    CODEV_SERVER_HOSTNAME: "127.0.0.1",
    CODEV_SERVER_PORT: "4096",
    CODEV_CLIENT: "desktop",
    CODEV_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    XDG_STATE_HOME: "/home/codev/.local/state",
    // Without this the guest files its database under the host build's
    // channel — a dev build's channel is the host repo's branch — so every
    // branch switch hid the sandbox's sessions behind a fresh database.
    CODEV_DISABLE_CHANNEL_DB: "1",
    // Stopping a sandbox cuts the VM's power, so guest commits have to reach
    // the disk rather than the guest's page cache.
    CODEV_SQLITE_SYNCHRONOUS: "FULL",
  })
})

test("generated credentials are unique per boot", () => {
  const first = generateSandboxCredentials()
  const second = generateSandboxCredentials()
  expect(first.username).toBe("codev")
  expect(first.password).not.toBe(second.password)
})

test("stops health polling when startup settles", async () => {
  const abort = new AbortController()
  let checks = 0
  const polling = pollSandboxHealth(
    async () => {
      checks++
      return false
    },
    abort.signal,
    1,
  )

  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort()
  await polling
  const settled = checks
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(checks).toBe(settled)
})

test("health polling returns once the server responds", async () => {
  const abort = new AbortController()
  let checks = 0
  await pollSandboxHealth(
    async () => {
      checks++
      return checks >= 3
    },
    abort.signal,
    1,
  )
  expect(checks).toBe(3)
})

// pollSandboxHealth awaits each probe in turn, so a request that never answers
// used to stall the whole loop: the sandbox stayed "starting" until the start
// timeout gave up, minutes later, even though the guest had come up seconds in.
// A probe must always settle.
test("health probe gives up on a connection that never answers", async () => {
  const started = Date.now()
  const healthy = await checkSandboxHealth(
    "http://127.0.0.1:1",
    { username: "codev", password: "secret" },
    // Opens and then hangs, the way an accepted socket to a guest that is not
    // listening yet can: no response, no error.
    ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch,
  )

  expect(healthy).toBe(false)
  expect(Date.now() - started).toBeLessThan(10_000)
})

// The caller's signal must cancel an in-flight probe too, so aborting the poll
// does not leave a request outliving the start it belonged to.
test("health probe aborts with the caller's signal", async () => {
  const controller = new AbortController()
  const probe = checkSandboxHealth(
    "http://127.0.0.1:1",
    { username: "codev", password: "secret" },
    ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch,
    controller.signal,
  )
  controller.abort()

  expect(await probe).toBe(false)
})
