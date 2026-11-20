import { PACKAGE_NAME } from "@codev/brand"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Duration, Effect, FileSystem, Layer, Ref } from "effect"
import { ChildProcess } from "effect/process"
import path from "node:path"
import { OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { RetainedImage } from "./retained-image"
import { Updater } from "./updater"
import { action, parseReleaseVersion } from "./updater-action"
import { errorMessage } from "../util/error"

// Codev (v1 parity): updates come from the npm package `codev2-code` and only ever touch that package, never an
// OpenCode or Codev v1 install. The TUI asks before installing; with `autoupdate: true` (or `update: "auto"`) a
// same-minor release such as 2.3.0-2 → 2.3.0-3 or 2.3.1 installs by itself, and anything larger still asks.

const manual = `Update with: npm i -g ${PACKAGE_NAME}@latest`
const methods = ["npm", "pnpm", "bun"] as const
type Method = (typeof methods)[number]

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const flock = yield* EffectFlock.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const executable = yield* fs.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath))
  // The npm wrapper places the binary at <package>/bin/codev2.exe; a source checkout runs inside bun or node.
  const packageDirectory = path.dirname(path.dirname(executable))
  const installed = yield* fs.readFileString(path.join(packageDirectory, "package.json")).pipe(
    Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as { name?: string; bin?: Record<string, string> })),
    Effect.map(
      (manifest) =>
        manifest.name === PACKAGE_NAME &&
        Object.values(manifest.bin ?? {}).some((bin) => path.resolve(packageDirectory, bin) === executable),
    ),
    Effect.orElseSucceed(() => false),
  )
  // POSIX npm keeps globals in <prefix>/lib/node_modules, so target the prefix that owns the running binary.
  const npmSuffix = path.join("/lib/node_modules", PACKAGE_NAME)
  const npmPrefixArgs =
    process.platform !== "win32" && packageDirectory.endsWith(npmSuffix)
      ? ["--prefix", packageDirectory.slice(0, -npmSuffix.length) || "/"]
      : []

  const exec = (command: string[], timeout: Duration.Input = "30 seconds") =>
    appProcess
      .run(ChildProcess.make(command[0]!, command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
      )

  const method = () =>
    Effect.sync((): Method | undefined => {
      if (!installed) return undefined
      const parts = executable.toLowerCase().split(path.sep)
      if (parts.includes(".bun")) return "bun"
      if (parts.some((part) => part.includes("pnpm"))) return "pnpm"
      return "npm"
    })

  // The registry npm itself uses, so a corporate mirror keeps working.
  const registry = yield* Effect.cached(
    exec(["npm", "config", "get", "registry"], "10 seconds").pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
      Effect.map((value) => (value.startsWith("http") ? value : "https://registry.npmjs.org").replace(/\/+$/, "")),
    ),
  )
  const latest = () =>
    Effect.gen(function* () {
      const base = yield* registry
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${base}/${PACKAGE_NAME}/${encodeURIComponent(OPENCODE_CHANNEL)}`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          }),
        catch: (cause) => new Error(`Could not check for Codev Code updates: ${errorMessage(cause)}`),
      })
      if (!response.ok) return yield* Effect.fail(new Error(`The npm registry returned HTTP ${response.status}`))
      const data = (yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new Error("The npm registry returned an unreadable answer"),
      })) as { version?: unknown }
      if (typeof data.version !== "string" || !parseReleaseVersion(data.version))
        return yield* Effect.fail(new Error("The npm registry returned no valid version"))
      return data.version
    })

  const readPolicy = Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
    fs.readFileString(path.join(global.config, name)).pipe(
      Effect.map(Updater.decodePolicy),
      Effect.orElseSucceed(() => undefined),
    ),
  ).pipe(Effect.map((values) => values.findLast((value) => value !== undefined) ?? "notify"))

  const upgrade = Effect.fnUntraced(function* (selected: Method, input: string) {
    if (!parseReleaseVersion(input)) return yield* Effect.fail(new Error(`Invalid version: ${input}`))
    if (!installed) return yield* Effect.fail(new Error(manual))
    const version = input.trim().replace(/^v/, "")
    const target = `${PACKAGE_NAME}@${version}`
    const commands: Record<Method, string[]> = {
      npm: ["npm", "install", "--global", ...npmPrefixArgs, `--allow-scripts=${PACKAGE_NAME}`, target],
      pnpm: ["pnpm", "add", "--global", `--allow-build=${PACKAGE_NAME}`, target],
      bun: ["bun", "install", "--global", "--trust", target],
    }
    const command = commands[selected]
    const install = exec(command, "5 minutes").pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.void
          : Effect.fail(
              new Error(`${command.join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(-2000)}`),
            ),
      ),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Another codev2 process may be installing at the same time.
        yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
        // Windows refuses to replace the running codev2.exe while it is its only link; a second link held in the
        // cache lets npm swap the file (see RetainedImage).
        if (process.platform === "win32") yield* RetainedImage.retain(global.cache, "upgrade")
        yield* install
      }),
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs))
    // A package manager can report success while updating another copy (a different prefix).
    const now = yield* fs.readFileString(path.join(packageDirectory, "package.json")).pipe(
      Effect.map((text) => (JSON.parse(text) as { version?: string }).version),
      Effect.orElseSucceed(() => undefined),
    )
    if (now !== version)
      return yield* Effect.fail(
        new Error(`${selected} reported success, but ${executable} is still ${now ?? "unknown"}. ${manual}`),
      )
    yield* Ref.set(installedVersion, version)
  })

  const check = Effect.fn("cli.codev-updater.check")(function* () {
    if (OPENCODE_LOCAL || !installed) return { type: "unavailable" as const, message: manual }
    const version = yield* latest()
    const current = yield* Ref.get(installedVersion)
    if (action(current, version, "auto") === "none")
      return action(OPENCODE_VERSION, current, "auto") === "none"
        ? undefined
        : { type: "installed" as const, version: current }
    return { type: "available" as const, version }
  })

  const apply = Effect.fn("cli.codev-updater.apply")(function* (version: string) {
    const selected = yield* method()
    if (!selected) return yield* Effect.fail(new Error(manual))
    yield* upgrade(selected, version)
  })

  const run = Effect.fn("cli.codev-updater.run")(
    function* (onInstall: (version: string) => void = () => {}) {
      const disabled = ["CODEV_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_AUTOUPDATE"].some((name) =>
        ["1", "true"].includes(process.env[name]?.toLowerCase() ?? ""),
      )
      if (OPENCODE_LOCAL || disabled || !installed) return undefined
      const policy = yield* readPolicy
      if (policy === "disable") return undefined
      const current = yield* Ref.get(installedVersion)
      const version = yield* latest()
      if (action(current, version, policy) === "none") return undefined
      const selected = yield* method()
      if (policy === "notify" || !selected || !sameMinor(current, version))
        return { type: "available" as const, version }
      onInstall(version)
      yield* upgrade(selected, version)
      return { type: "installed" as const, version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Updater.Service.of({
    run,
    check,
    apply,
    method,
    managed: () => Effect.succeed(undefined),
    latest: () => latest(),
    upgrade: (selected, version) =>
      methods.includes(selected as Method)
        ? upgrade(selected as Method, version)
        : Effect.fail(new Error(`${selected} cannot update ${PACKAGE_NAME}. ${manual}`)),
    // `codev2 uninstall` keeps its own scope; the updater never removes a package.
    removal: () => undefined,
  })
})

// The fork's revision bumps (2.3.0-2 → 2.3.0-3) and patch releases install silently under `autoupdate: true`;
// a new minor or major always asks first, as in Codev v1.
function sameMinor(current: string, latest: string) {
  const [a, b] = [parseReleaseVersion(current), parseReleaseVersion(latest)]
  if (!a || !b) return false
  return a.core.split(".").slice(0, 2).join(".") === b.core.split(".").slice(0, 2).join(".")
}

export const layer = Layer.effect(Updater.Service, make)

export * as CodevUpdater from "./codev-updater"
