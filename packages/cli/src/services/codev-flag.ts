import { ConfigFlag } from "@opencode/schema/config/flag"
import { Effect } from "effect"
import { OPENCODE_CHANNEL } from "../version"

type CodevKey = Extract<ConfigFlag.Key, `codev_${string}`>

// Verified Codev CLI features ship in every build. The rest (sandbox, v1 import) stay dev-only until verified.
const RELEASED = new Set<CodevKey>(["codev_gateway", "codev_skillhub", "codev_upload"])

/**
 * Resolves a Codev feature flag for commands that run before any Location exists.
 * Mirrors Core's `Flag` precedence for `OPENCODE_FLAGS` (`key`, `-key`, `all`), then defaults on for released keys
 * in every build and for the rest in local and dev builds. `experimental.<key>` in config is not read here.
 */
export function codevFlagEnabled(
  key: CodevKey,
  env: string | undefined = process.env.OPENCODE_FLAGS,
  channel: string = OPENCODE_CHANNEL,
) {
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
  if (RELEASED.has(key)) return true
  return !ConfigFlag.optInOnly.has(key) && (channel === "local" || channel === "dev")
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
