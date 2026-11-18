import { ConfigFlag } from "@opencode/schema/config/flag"
import { Effect } from "effect"
import { OPENCODE_CHANNEL } from "../version"

type CodevKey = Extract<ConfigFlag.Key, `codev_${string}`>

/**
 * Resolves a Codev feature flag for commands that run before any Location exists.
 * Mirrors Core's `Flag` precedence for `OPENCODE_FLAGS` (`key`, `-key`, `all`), then defaults on for local and dev
 * builds. `experimental.<key>` in config is not read here; set the environment variable to enable in releases.
 */
export function codevFlagEnabled(key: CodevKey, env: string | undefined = process.env.OPENCODE_FLAGS) {
  const entries = new Map(
    (env ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item): [string, boolean] => (item.startsWith("-") ? [item.slice(1), false] : [item, true])),
  )
  const explicit = entries.get(key)
  if (explicit !== undefined) return explicit
  if (entries.get(ConfigFlag.wildcard) === true && !ConfigFlag.optInOnly.has(key)) return true
  return !ConfigFlag.optInOnly.has(key) && (OPENCODE_CHANNEL === "local" || OPENCODE_CHANNEL === "dev")
}

/** Fails the command unless the flag is enabled. */
export const requireCodevFlag = (key: CodevKey) =>
  codevFlagEnabled(key)
    ? Effect.void
    : Effect.fail(new Error(`This command is disabled. Enable it with OPENCODE_FLAGS=${key}`))

/** Maps a wrapped command's numeric exit status onto the process exit code. */
export const exitWith = (code: number) =>
  Effect.sync(() => {
    if (code !== 0) process.exitCode = code
  })
