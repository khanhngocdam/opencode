import { expect, test } from "bun:test"
import { createSandboxController, type SandboxController } from "./controller"
import type { RunningSandbox, SandboxConfig, SandboxProvider, SandboxRuntime } from "./provider"

type FakeRunning = RunningSandbox & {
  stopped: boolean
  exit: (code: number | null, signal: NodeJS.Signals | null) => void
}

function fakeRunning(url: string): FakeRunning {
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  const sandbox: FakeRunning = {
    url,
    username: "codev",
    password: "secret",
    mounts: [],
    stopped: false,
    stop: () => {
      sandbox.stopped = true
    },
    onExit: (cb) => {
      onExit = cb
    },
    exit: (code, signal) => onExit?.(code, signal),
  }
  return sandbox
}

function fakeProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  return {
    backend: "bwrap",
    availability: async () => ({ supported: true, warning: null }),
    create: async () => undefined,
    start: async () => fakeRunning("http://127.0.0.1:4096"),
    destroy: async () => undefined,
    reset: async () => undefined,
    ...overrides,
  }
}

const config: SandboxConfig = { id: "sandbox:default", name: "default", backend: "bwrap", projectDir: "/work" }
const other: SandboxConfig = { id: "sandbox:other", name: "other", backend: "bwrap", projectDir: "/other" }
const third: SandboxConfig = { id: "sandbox:third", name: "third", backend: "bwrap", projectDir: "/third" }

// Lets every queued continuation run; the job queue hands off through
// promises, so a job's turn starts a microtask after the one ahead of it ends.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function runtimeOf(controller: SandboxController, id: string) {
  return controller.getState().sandboxes.find((item) => item.config.id === id)?.runtime
}

function waitForRuntimeKind(controller: SandboxController, id: string, kind: SandboxRuntime["kind"]) {
  return new Promise<SandboxRuntime>((resolve) => {
    const current = runtimeOf(controller, id)
    if (current?.kind === kind) return resolve(current)
    const unsubscribe = controller.subscribe((event) => {
      const runtime = event.state.sandboxes.find((item) => item.config.id === id)?.runtime
      if (runtime?.kind !== kind) return
      unsubscribe()
      resolve(runtime)
    })
  })
}

test("adds a sandbox, persists it, and reports the running server", async () => {
  let persisted: SandboxConfig[] = []
  let created = 0
  const controller = createSandboxController({
    providers: { bwrap: fakeProvider({ create: async () => void created++ }) },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.addSandbox(config)
  const runtime = await waitForRuntimeKind(controller, config.id, "ready")
  expect(created).toBe(1)
  expect(persisted).toEqual([config])
  expect(runtime).toEqual({
    kind: "ready",
    url: "http://127.0.0.1:4096",
    username: "codev",
    password: "secret",
    mounts: [],
  })
  expect(controller.getState().jobs).toEqual([])
})

test("create reports image download progress on the job", async () => {
  let persisted: SandboxConfig[] = []
  const seen: (number | undefined)[] = []
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        create: async (_config, opts) => {
          opts?.onProgress?.({ bytes: 10, totalBytes: 100 })
          opts?.onProgress?.({ bytes: 50, totalBytes: 100 })
        },
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  controller.subscribe((event) => seen.push(event.state.jobs[0]?.progress?.bytes))
  await controller.addSandbox(config)
  expect(seen).toContain(10)
  expect(seen).toContain(50)
  expect(controller.getState().jobs).toEqual([])
})

test("cancelling a create aborts the download and persists nothing", async () => {
  let persisted: SandboxConfig[] = []
  let started = 0
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        create: (_config, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            })
          }),
        start: async () => {
          started++
          return fakeRunning("http://127.0.0.1:4096")
        },
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  const adding = controller.addSandbox(config)
  controller.cancelJob(config.id)
  expect(await adding).toBeUndefined()
  expect(persisted).toEqual([])
  expect(controller.getState().sandboxes).toEqual([])
  expect(controller.getState().jobs).toEqual([])
  expect(started).toBe(0)
})

test("cancelJob ignores a job for a different sandbox", async () => {
  let resolveCreate: (() => void) | undefined
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        create: () =>
          new Promise((resolve) => {
            resolveCreate = () => resolve(undefined)
          }),
      }),
    },
    readSandboxes: () => [],
    writeSandboxes: () => undefined,
  })
  const adding = controller.addSandbox(config)
  await tick()
  controller.cancelJob("sandbox:other")
  resolveCreate?.()
  expect(await adding).toEqual(config)
})

// The bug this queue exists for: jobs used to share one abort controller, so
// touching a second sandbox cancelled the first sandbox's image download —
// silently, since a cancelled create resolves undefined.
test("a job on one sandbox neither aborts nor overtakes another sandbox's job", async () => {
  const order: string[] = []
  let createAborted = false
  let resolveCreate: (() => void) | undefined
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        create: (_config, opts) =>
          new Promise((resolve) => {
            opts?.signal?.addEventListener("abort", () => {
              createAborted = true
            })
            resolveCreate = () => {
              order.push("create")
              resolve(undefined)
            }
          }),
        reset: async (target) => {
          order.push(`reset:${target.name}`)
        },
      }),
    },
    readSandboxes: () => [other],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  const adding = controller.addSandbox(config)
  await tick()
  const resetting = controller.resetSandbox(other.id)
  await tick()
  expect(createAborted).toBe(false)
  expect(order).toEqual([])
  expect(controller.getState().jobs.map((job) => [job.id, job.status])).toEqual([
    [config.id, "running"],
    [other.id, "queued"],
  ])
  resolveCreate?.()
  expect(await adding).toEqual(config)
  await resetting
  expect(order).toEqual(["create", "reset:other"])
  expect(createAborted).toBe(false)
  expect(controller.getState().jobs).toEqual([])
})

// A lone job briefly reported itself as queued, so the UI flashed "waiting for
// another sandbox" when there was no other sandbox to wait for.
test("a job with nothing ahead of it is never reported as queued", async () => {
  const seen: string[] = []
  const controller = createSandboxController({
    providers: { bwrap: fakeProvider({ destroy: async () => undefined }) },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  controller.subscribe((event) => seen.push(...event.state.jobs.map((job) => job.status)))
  await controller.removeSandbox(config.id)
  expect(seen).not.toContain("queued")
  expect(seen).toContain("running")
})

test("cancelling a queued job returns at once and never starts it", async () => {
  const order: string[] = []
  let resolveCreate: (() => void) | undefined
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        create: () =>
          new Promise((resolve) => {
            resolveCreate = () => {
              order.push("create")
              resolve(undefined)
            }
          }),
        reset: async (target) => {
          order.push(`reset:${target.name}`)
        },
      }),
    },
    readSandboxes: () => [other, third],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  const adding = controller.addSandbox(config)
  await tick()
  const resetting = controller.resetSandbox(other.id)
  const resettingThird = controller.resetSandbox(third.id)
  await tick()
  controller.cancelJob(other.id)
  // Resolves while the create is still running: the dialog that asked for it
  // must not sit on a spinner until an unrelated download finishes.
  await resetting
  await tick()
  // ...and the job behind the cancelled one still waits its turn.
  expect(order).toEqual([])
  expect(controller.getState().jobs.map((job) => job.id)).toEqual([config.id, third.id])
  resolveCreate?.()
  await adding
  await resettingThird
  expect(order).toEqual(["create", "reset:third"])
})

test("a second job for the same sandbox supersedes the first", async () => {
  const resets: (() => void)[] = []
  let aborts = 0
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        reset: (_target, opts) =>
          new Promise((resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              aborts++
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            })
            resets.push(() => resolve(undefined))
          }),
      }),
    },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  const first = controller.resetSandbox(config.id)
  await tick()
  const second = controller.resetSandbox(config.id)
  await tick()
  expect(aborts).toBe(1)
  expect(controller.getState().jobs.map((job) => job.id)).toEqual([config.id])
  await first
  resets.at(-1)?.()
  await second
  expect(controller.getState().jobs).toEqual([])
})

test("rejects adding the same sandbox twice", async () => {
  let persisted: SandboxConfig[] = [config]
  const controller = createSandboxController({
    providers: { bwrap: fakeProvider() },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  expect(controller.addSandbox(config)).rejects.toThrow("already added")
})

test("reports a failed start with the provider's message", async () => {
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async () => {
          throw new Error("bwrap not available")
        },
      }),
    },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  const runtime = await waitForRuntimeKind(controller, config.id, "failed")
  expect(runtime).toEqual({ kind: "failed", message: "bwrap not available" })
})

test("marks the sandbox failed when the server exits", async () => {
  const sandbox = fakeRunning("http://127.0.0.1:4097")
  const controller = createSandboxController({
    providers: { bwrap: fakeProvider({ start: async () => sandbox }) },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  sandbox.exit(1, null)
  const runtime = await waitForRuntimeKind(controller, config.id, "failed")
  expect(runtime).toEqual({ kind: "failed", message: "sandbox server exited after startup (code=1 signal=null)" })
})

test("ignores stale sandboxes after a rapid restart", async () => {
  const resolvers: ((sandbox: RunningSandbox) => void)[] = []
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: () => new Promise((resolve) => resolvers.push(resolve)),
      }),
    },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  const restart = controller.startSandbox(config.id)
  const stale = fakeRunning("http://127.0.0.1:1111")
  const fresh = fakeRunning("http://127.0.0.1:2222")
  resolvers[0]!(stale)
  resolvers[1]!(fresh)
  await restart
  const runtime = await waitForRuntimeKind(controller, config.id, "ready")
  expect(stale.stopped).toBe(true)
  expect(fresh.stopped).toBe(false)
  expect(runtime).toEqual({
    kind: "ready",
    url: "http://127.0.0.1:2222",
    username: "codev",
    password: "secret",
    mounts: [],
  })
})

test("removing a sandbox stops it, destroys it, and forgets it", async () => {
  let persisted: SandboxConfig[] = []
  let destroyed = 0
  const sandbox = fakeRunning("http://127.0.0.1:4098")
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async () => sandbox,
        destroy: async () => void destroyed++,
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.addSandbox(config)
  await waitForRuntimeKind(controller, config.id, "ready")
  await controller.removeSandbox(config.id)
  expect(sandbox.stopped).toBe(true)
  expect(destroyed).toBe(1)
  expect(persisted).toEqual([])
  expect(controller.getState().sandboxes).toEqual([])
  sandbox.exit(1, null)
  expect(controller.getState().sandboxes).toEqual([])
})

test("reset destroys guest state and restarts the sandbox", async () => {
  let resets = 0
  let starts = 0
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async () => {
          starts++
          return fakeRunning(`http://127.0.0.1:500${starts}`)
        },
        reset: async () => void resets++,
      }),
    },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  await controller.resetSandbox(config.id)
  const runtime = await waitForRuntimeKind(controller, config.id, "ready")
  expect(resets).toBe(1)
  expect(starts).toBe(2)
  expect(runtime).toEqual({
    kind: "ready",
    url: "http://127.0.0.1:5002",
    username: "codev",
    password: "secret",
    mounts: [],
  })
})

test("stopping a sandbox keeps it down across a relaunch", async () => {
  const sandbox = fakeRunning("http://127.0.0.1:5100")
  let persisted: SandboxConfig[] = [config]
  let starts = 0
  const providers = {
    bwrap: fakeProvider({
      start: async () => {
        starts++
        return sandbox
      },
    }),
  }
  const controller = createSandboxController({
    providers,
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  await controller.stopSandbox(config.id)
  expect(sandbox.stopped).toBe(true)
  expect(runtimeOf(controller, config.id)).toEqual({ kind: "stopped" })
  expect(persisted).toEqual([{ ...config, stopped: true }])

  // A fresh controller over the same store is what a relaunch looks like.
  const relaunched = createSandboxController({
    providers,
    readSandboxes: () => persisted,
    writeSandboxes: () => undefined,
  })
  await relaunched.initialize()
  await tick()
  expect(starts).toBe(1)
  expect(runtimeOf(relaunched, config.id)).toEqual({ kind: "stopped" })
})

test("starting a stopped sandbox clears the flag and boots it", async () => {
  let persisted: SandboxConfig[] = [{ ...config, stopped: true }]
  const controller = createSandboxController({
    providers: { bwrap: fakeProvider() },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  await tick()
  expect(runtimeOf(controller, config.id)).toEqual({ kind: "stopped" })
  await controller.startSandbox(config.id)
  await waitForRuntimeKind(controller, config.id, "ready")
  expect(persisted).toEqual([{ ...config, stopped: false }])
})

test("stopping a starting sandbox discards the instance it was waiting on", async () => {
  const sandbox = fakeRunning("http://127.0.0.1:5101")
  let resolveStart: (() => void) | undefined
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: () =>
          new Promise((resolve) => {
            resolveStart = () => resolve(sandbox)
          }),
      }),
    },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  await tick()
  expect(runtimeOf(controller, config.id)).toEqual({ kind: "starting" })
  await controller.stopSandbox(config.id)
  resolveStart?.()
  await tick()
  expect(sandbox.stopped).toBe(true)
  expect(runtimeOf(controller, config.id)).toEqual({ kind: "stopped" })
})

test("resetting a stopped sandbox re-provisions it without starting it", async () => {
  let resets = 0
  let starts = 0
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async () => {
          starts++
          return fakeRunning("http://127.0.0.1:5102")
        },
        reset: async () => void resets++,
      }),
    },
    readSandboxes: () => [{ ...config, stopped: true }],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  await tick()
  await controller.resetSandbox(config.id)
  expect(resets).toBe(1)
  expect(starts).toBe(0)
  expect(runtimeOf(controller, config.id)).toEqual({ kind: "stopped" })
})

test("updating mounts on a failed sandbox persists without starting it", async () => {
  let persisted: SandboxConfig[] = [config]
  let starts = 0
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async () => {
          starts++
          throw new Error("down")
        },
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "failed")
  const startsBefore = starts
  await controller.updateSandboxMounts(config.id, [{ path: "/extra" }])
  expect(starts).toBe(startsBefore)
  expect(persisted).toEqual([{ ...config, mounts: [{ path: "/extra" }] }])
  expect(controller.getState().sandboxes[0]?.config.mounts).toEqual([{ path: "/extra" }])
})

test("updating mounts restarts a running sandbox when the provider cannot apply hot", async () => {
  let persisted: SandboxConfig[] = [config]
  const startConfigs: SandboxConfig[] = []
  const instances: FakeRunning[] = []
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async (startConfig) => {
          startConfigs.push(startConfig)
          const instance = fakeRunning(`http://127.0.0.1:600${startConfigs.length}`)
          instances.push(instance)
          return instance
        },
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  await controller.updateSandboxMounts(config.id, [{ path: "/extra" }])
  await waitForRuntimeKind(controller, config.id, "ready")
  expect(startConfigs).toHaveLength(2)
  expect(startConfigs[1]?.mounts).toEqual([{ path: "/extra" }])
  expect(instances[0]?.stopped).toBe(true)
  expect(instances[1]?.stopped).toBe(false)
  expect(persisted).toEqual([{ ...config, mounts: [{ path: "/extra" }] }])
})

test("updating mounts applies hot when the provider supports it", async () => {
  let persisted: SandboxConfig[] = [config]
  let starts = 0
  let applied: SandboxConfig | undefined
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async () => {
          starts++
          return fakeRunning("http://127.0.0.1:4096")
        },
        applyMounts: async (applyConfig) => {
          applied = applyConfig
          return [{ path: "/extra", guestPath: "/mnt/extra" }]
        },
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  await controller.updateSandboxMounts(config.id, [{ path: "/extra" }])
  expect(starts).toBe(1)
  expect(applied?.mounts).toEqual([{ path: "/extra" }])
  expect(persisted).toEqual([{ ...config, mounts: [{ path: "/extra" }] }])
  const runtime = runtimeOf(controller, config.id)
  expect(runtime).toEqual({
    kind: "ready",
    url: "http://127.0.0.1:4096",
    username: "codev",
    password: "secret",
    mounts: [{ path: "/extra", guestPath: "/mnt/extra" }],
  })
})

test("a failed hot apply persists nothing", async () => {
  let persisted: SandboxConfig[] = [config]
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        applyMounts: async () => {
          throw new Error("folder does not exist")
        },
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  expect(controller.updateSandboxMounts(config.id, [{ path: "/gone" }])).rejects.toThrow("folder does not exist")
  expect(persisted).toEqual([config])
  expect(controller.getState().sandboxes[0]?.config.mounts).toBeUndefined()
})

test("updating mounts is rejected while the sandbox has a job in flight", async () => {
  let persisted: SandboxConfig[] = [config]
  let resolveReset: (() => void) | undefined
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        reset: () =>
          new Promise((resolve) => {
            resolveReset = () => resolve(undefined)
          }),
      }),
    },
    readSandboxes: () => persisted,
    writeSandboxes: (sandboxes) => {
      persisted = sandboxes
    },
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  const resetting = controller.resetSandbox(config.id)
  expect(controller.updateSandboxMounts(config.id, [{ path: "/extra" }])).rejects.toThrow("operation in progress")
  await tick()
  resolveReset?.()
  await resetting
  expect(persisted).toEqual([config])
})

test("stopAll stops running sandboxes and invalidates pending starts", async () => {
  const sandbox = fakeRunning("http://127.0.0.1:4099")
  const controller = createSandboxController({
    providers: { bwrap: fakeProvider({ start: async () => sandbox }) },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  controller.stopAll()
  expect(sandbox.stopped).toBe(true)
})

// Signing in after a sandbox booted leaves its guest holding a config with no
// provider, because the provider resolves egress in start(). The restart is
// what re-resolves it.
test("restartRunning restarts the ready sandboxes and leaves the rest alone", async () => {
  const starts: string[] = []
  const running = new Map<string, ReturnType<typeof fakeRunning>>()
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async (input) => {
          starts.push(input.id)
          const sandbox = fakeRunning(`http://127.0.0.1:4200`)
          running.set(input.id, sandbox)
          return sandbox
        },
      }),
    },
    readSandboxes: () => [config, { ...other, stopped: true }],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "ready")
  const first = running.get(config.id)
  expect(starts).toEqual([config.id])

  await controller.restartRunning()
  await waitForRuntimeKind(controller, config.id, "ready")
  // The ready one came back up; the stopped one stayed down and was never
  // started, which is also what keeps its stopped flag meaningful.
  expect(starts).toEqual([config.id, config.id])
  expect(first?.stopped).toBe(true)
  expect(runtimeOf(controller, other.id)).toEqual({ kind: "stopped" })
})

test("restartRunning skips a sandbox that failed to start", async () => {
  let starts = 0
  const controller = createSandboxController({
    providers: {
      bwrap: fakeProvider({
        start: async () => {
          starts++
          throw new Error("no image")
        },
      }),
    },
    readSandboxes: () => [config],
    writeSandboxes: () => undefined,
  })
  await controller.initialize()
  await waitForRuntimeKind(controller, config.id, "failed")
  await controller.restartRunning()
  expect(starts).toBe(1)
})
