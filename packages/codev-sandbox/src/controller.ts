import type {
  RunningSandbox,
  SandboxBackend,
  SandboxConfig,
  SandboxItem,
  SandboxMount,
  SandboxProgress,
  SandboxProvider,
  SandboxRuntime,
} from "./provider"

export type SandboxJob = {
  kind: "create" | "destroy" | "reset"
  id: string
  // When the job was admitted to the queue, which is not when it started
  // running — status says which of those has happened.
  startedAt: number
  status: "running" | "queued"
  progress?: SandboxProgress
}

export type SandboxesState = {
  sandboxes: SandboxItem[]
  // The running job first, then the jobs waiting behind it. At most one job
  // per sandbox: a second one supersedes the first (see runJob).
  jobs: SandboxJob[]
}

export type SandboxesEvent = { type: "state"; state: SandboxesState }

type ControllerLogger = {
  log: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

type SandboxControllerOptions = {
  providers: Partial<Record<SandboxBackend, SandboxProvider>>
  readSandboxes: () => SandboxConfig[]
  writeSandboxes: (sandboxes: SandboxConfig[]) => void
  logger?: ControllerLogger
}

export type SandboxController = ReturnType<typeof createSandboxController>

// Generalizes the WSL servers controller (packages/desktop/src/main/wsl/servers.ts)
// to any SandboxProvider: same runtime states, single-flight jobs, and
// stale-start-attempt guards, with WSL-specific probes left to providers.
export function createSandboxController(options: SandboxControllerOptions) {
  let state: SandboxesState = { sandboxes: [], jobs: [] }
  const listeners = new Set<(event: SandboxesEvent) => void>()
  const running = new Map<string, RunningSandbox>()
  const startAttempts = new Map<string, number>()
  const logger = options.logger

  const emit = () => {
    for (const listener of listeners) listener({ type: "state", state })
  }

  const setState = (next: Partial<SandboxesState>) => {
    state = { ...state, ...next }
    emit()
  }

  const setRuntime = (id: string, runtime: SandboxRuntime) => {
    setState({
      sandboxes: state.sandboxes.map((item) => (item.config.id === id ? { ...item, runtime } : item)),
    })
  }

  // The persisted store and state.sandboxes[].config are separate; both have
  // to move together (see addSandbox).
  const patchConfig = (id: string, patch: Partial<SandboxConfig>) => {
    options.writeSandboxes(
      options.readSandboxes().map((config) => (config.id === id ? { ...config, ...patch } : config)),
    )
    setState({
      sandboxes: state.sandboxes.map((item) =>
        item.config.id === id ? { ...item, config: { ...item.config, ...patch } } : item,
      ),
    })
  }

  const requireProvider = (backend: SandboxBackend) => {
    const provider = options.providers[backend]
    if (!provider) throw new Error(`no sandbox provider registered for backend: ${backend}`)
    return provider
  }

  // Create, reset and destroy run one at a time. Not for the sandbox's sake —
  // each one only ever touches its own directories — but because create and
  // reset stage guest images through one shared cache whose resumable-download
  // bookkeeping assumes a single writer (image.ts removeStalePartials).
  // Queueing rather than superseding is the whole point: a job on one sandbox
  // must never abort another sandbox's half-downloaded image.
  const queue: { job: SandboxJob; abort: AbortController }[] = []
  // Resolves when the job currently at the back of the queue is done, so each
  // new job waits for exactly the jobs admitted before it. Never rejects.
  let tail: Promise<void> = Promise.resolve()

  const publishJobs = () => setState({ jobs: queue.map((entry) => entry.job) })

  const patchJob = (entry: (typeof queue)[number], patch: Partial<SandboxJob>) => {
    if (!queue.includes(entry)) return
    entry.job = { ...entry.job, ...patch }
    publishJobs()
  }

  const runJob = async <T>(
    kind: SandboxJob["kind"],
    id: string,
    runner: (abort: AbortController, report: (progress: SandboxProgress) => void) => Promise<T>,
  ) => {
    // A second job for the same sandbox supersedes the first: the caller asked
    // for the newer outcome and both would work on the same directories.
    queue.find((entry) => entry.job.id === id)?.abort.abort()
    // Only "queued" when something is genuinely ahead of it. A job that will
    // start on the next microtask must not flash "waiting for another sandbox"
    // at the user — and an entry already aborted (superseded just above) is on
    // its way out, so it is not something to wait for.
    const waiting = queue.some((entry) => !entry.abort.signal.aborted)
    const job: SandboxJob = { kind, id, startedAt: Date.now(), status: waiting ? "queued" : "running" }
    const entry = { job, abort: new AbortController() }
    queue.push(entry)
    publishJobs()
    const ahead = tail
    let release: () => void = () => {}
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      // Cancelling while queued has to return without waiting out the job
      // ahead — the dialog that asked for it is sitting on this promise.
      await Promise.race([ahead, aborted(entry.abort.signal)])
      if (entry.abort.signal.aborted) return undefined
      patchJob(entry, { status: "running" })
      return await runner(entry.abort, (progress) => patchJob(entry, { progress }))
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return undefined
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      const index = queue.indexOf(entry)
      if (index >= 0) queue.splice(index, 1)
      publishJobs()
      // Released only once everything admitted earlier has finished: a job
      // cancelled while it was still waiting must not let the one behind it
      // jump ahead of the job that is actually running.
      void ahead.then(release)
    }
  }

  const nextStartAttempt = (id: string) => {
    const next = (startAttempts.get(id) ?? 0) + 1
    startAttempts.set(id, next)
    return next
  }

  const invalidateStartAttempt = (id: string) => {
    startAttempts.set(id, (startAttempts.get(id) ?? 0) + 1)
  }

  const isCurrentStartAttempt = (id: string, attempt: number) => {
    return startAttempts.get(id) === attempt && state.sandboxes.some((item) => item.config.id === id)
  }

  const stopSandboxInternal = (id: string) => {
    const existing = running.get(id)
    if (!existing) return
    running.delete(id)
    try {
      existing.stop()
    } catch {
      // ignore stop errors
    }
  }

  const startSandboxInternal = async (id: string) => {
    const item = state.sandboxes.find((x) => x.config.id === id)
    if (!item) return
    const attempt = nextStartAttempt(id)
    stopSandboxInternal(id)
    if (!isCurrentStartAttempt(id, attempt)) return
    setRuntime(id, { kind: "starting" })
    logger?.log("sandbox starting", { id, backend: item.config.backend })
    try {
      const sandbox = await requireProvider(item.config.backend).start(item.config)
      if (!isCurrentStartAttempt(id, attempt)) {
        try {
          sandbox.stop()
        } catch {
          // ignore stop errors for stale sandboxes
        }
        return
      }
      running.set(id, sandbox)
      setRuntime(id, {
        kind: "ready",
        url: sandbox.url,
        username: sandbox.username,
        password: sandbox.password,
        mounts: sandbox.mounts,
      })
      sandbox.onExit((code, signal) => {
        if (running.get(id) !== sandbox) return
        running.delete(id)
        setRuntime(id, { kind: "failed", message: exitFailure(code, signal) })
        logger?.error("sandbox exited", { id, code, signal })
      })
      logger?.log("sandbox ready", { id, url: sandbox.url })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isCurrentStartAttempt(id, attempt)) return
      setRuntime(id, { kind: "failed", message })
      logger?.error("sandbox failed to start", { id, message })
    }
  }

  return {
    getState() {
      return state
    },
    subscribe(listener: (event: SandboxesEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async initialize() {
      const persisted = options.readSandboxes()
      setState({
        sandboxes: persisted.map((config) => {
          const existing = state.sandboxes.find((item) => item.config.id === config.id)
          return { config, runtime: existing?.runtime ?? { kind: "stopped" } }
        }),
      })
      // A sandbox the user stopped stays stopped across app restarts: it is
      // the only way to keep a machine's sandboxes from all booting at launch.
      for (const item of state.sandboxes) {
        if (!item.config.stopped) void startSandboxInternal(item.config.id)
      }
    },

    async addSandbox(config: SandboxConfig) {
      if (state.sandboxes.some((item) => item.config.id === config.id)) {
        throw new Error(`${config.id} is already added`)
      }
      const provider = requireProvider(config.backend)
      const created = await runJob("create", config.id, async (abort, report) => {
        await provider.create(config, { signal: abort.signal, onProgress: report })
        return true
      })
      // A cancelled create resolves to undefined: nothing is persisted or
      // started, and the caller reports "cancelled" rather than an error.
      if (!created) return undefined
      options.writeSandboxes([...options.readSandboxes(), config])
      setState({ sandboxes: [...state.sandboxes, { config, runtime: { kind: "starting" } }] })
      void startSandboxInternal(config.id)
      return config
    },

    // Aborts this sandbox's job, running or still queued (the dialog cancels a
    // create mid-download); a sandbox with no job is a no-op.
    cancelJob(id: string) {
      queue.find((entry) => entry.job.id === id)?.abort.abort()
    },

    async removeSandbox(id: string) {
      const item = state.sandboxes.find((x) => x.config.id === id)
      if (!item) return
      invalidateStartAttempt(id)
      stopSandboxInternal(id)
      await runJob("destroy", id, async (abort) => {
        await requireProvider(item.config.backend).destroy(item.config, { signal: abort.signal })
      })
      options.writeSandboxes(options.readSandboxes().filter((config) => config.id !== id))
      setState({ sandboxes: state.sandboxes.filter((x) => x.config.id !== id) })
    },

    async resetSandbox(id: string) {
      const item = state.sandboxes.find((x) => x.config.id === id)
      if (!item) return
      invalidateStartAttempt(id)
      stopSandboxInternal(id)
      setRuntime(id, { kind: "stopped" })
      const done = await runJob("reset", id, async (abort, report) => {
        await requireProvider(item.config.backend).reset(item.config, { signal: abort.signal, onProgress: report })
        return true
      })
      // A cancelled reset may have discarded guest state already; leave the
      // sandbox stopped instead of starting from a half-reset image.
      if (!done) return
      // Resetting a sandbox the user stopped re-provisions it but does not
      // bring it up — Start is still theirs to press.
      if (state.sandboxes.find((x) => x.config.id === id)?.config.stopped) return
      await startSandboxInternal(id)
    },

    // Replaces the extra-mount list. Applied hot where the provider can
    // (WSL), otherwise by restarting a live sandbox; a stopped or failed
    // sandbox just persists the change for its next start.
    async updateSandboxMounts(id: string, mounts: SandboxMount[]) {
      const item = state.sandboxes.find((x) => x.config.id === id)
      if (!item) throw new Error(`no sandbox with id ${id}`)
      if (queue.some((entry) => entry.job.id === id))
        throw new Error("the sandbox has an operation in progress; wait for it to finish")
      const provider = requireProvider(item.config.backend)
      const config = { ...item.config, mounts }
      const persist = () => patchConfig(id, { mounts })
      const current = running.get(id)
      if (current && provider.applyMounts) {
        // Hot path: apply against the live guest before persisting, so a bad
        // path never lands in the stored config.
        const resolved = await provider.applyMounts(config)
        persist()
        // The instance can change under the await; the persisted config still
        // wins on the next start, but the stale runtime must not be patched.
        if (running.get(id) !== current) return
        const runtime = state.sandboxes.find((x) => x.config.id === id)?.runtime
        if (runtime?.kind === "ready") setRuntime(id, { ...runtime, mounts: resolved })
        logger?.log("sandbox mounts applied", { id, mounts: resolved.length })
        return
      }
      // Restart path: persist first so the new mount set survives a failed
      // restart, then restart only a live sandbox.
      persist()
      if (item.runtime.kind !== "ready" && item.runtime.kind !== "starting") return
      logger?.log("sandbox restarting to apply mounts", { id })
      await startSandboxInternal(id)
    },

    // The user asking for a start clears the stopped flag; the internal
    // restarts (initialize, reset, a mount change) leave their intent alone.
    async startSandbox(id: string) {
      if (state.sandboxes.find((x) => x.config.id === id)?.config.stopped) patchConfig(id, { stopped: false })
      await startSandboxInternal(id)
    },

    // Restarts every sandbox that is up, so its guest picks up host-side state
    // it only reads at boot — the injected codev config and the broker's route
    // table, both resolved in the provider's start(). Stopped, failed and
    // half-created sandboxes need nothing: whenever they next start they
    // resolve everything fresh.
    //
    // Deliberately only sandboxes that are `ready`. Restarting one that is
    // still starting would run a second guest against the same instance disk
    // until the first one's stale-attempt guard caught up, and the window this
    // is called in (finishing first-run setup) has had every sandbox up since
    // launch.
    async restartRunning() {
      for (const item of state.sandboxes) {
        if (item.runtime.kind !== "ready") continue
        await startSandboxInternal(item.config.id)
      }
    },

    // Shuts the guest down and keeps it down: unlike a failed or restarting
    // sandbox this is a decision, so it persists and survives a relaunch.
    // Cancels a start already in flight too — the stale-attempt guard makes it
    // discard the instance it was waiting on.
    async stopSandbox(id: string) {
      if (!state.sandboxes.some((x) => x.config.id === id)) return
      invalidateStartAttempt(id)
      stopSandboxInternal(id)
      patchConfig(id, { stopped: true })
      setRuntime(id, { kind: "stopped" })
      logger?.log("sandbox stopped", { id })
    },

    stopAll() {
      for (const item of state.sandboxes) invalidateStartAttempt(item.config.id)
      for (const existing of running.values()) {
        try {
          existing.stop()
        } catch {
          // ignore
        }
      }
      running.clear()
    },
  }
}

function aborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function exitFailure(code: number | null, signal: NodeJS.Signals | null) {
  return `sandbox server exited after startup (code=${code ?? "null"} signal=${signal ?? "null"})`
}
