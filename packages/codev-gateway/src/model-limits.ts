import { loadModelLimits, saveModelLimits } from "./auth-file"

// Per-model context windows and auto-compaction triggers, modeled on the
// codev hub's src/lib/model-limits.ts (same window table, same auth-file
// cache; triggers here are uniformly COMPACT_PCT of the window). The gateway
// serves custom models opencode doesn't recognize — a config model entry with
// no `limit` resolves to context 0, which mis-sizes the window gauge and
// disables auto-compaction outright — so every model written into a config
// block needs limits from here.

export interface ModelLimits {
  // The model's true window, written verbatim into `limit.context` — it drives
  // the "% context used" gauge, so understating it misreports every session.
  context: number
  // Where auto-compaction should fire: always COMPACT_PCT of the window here
  // (see limitsFromWindow), though a cached hub-written entry may carry its
  // own number.
  trigger: number
  // Max output tokens. Absent ⇒ DEFAULT_OUTPUT_TOKENS.
  output?: number
}

export const DEFAULT_OUTPUT_TOKENS = 65536

// The global `compaction.reserved` — opencode's config schema has a single
// shared reserve with no per-model variant. See declaredInput() for how a
// shared reserve still yields exact per-model triggers.
export const COMPACT_RESERVED = 40000

// The trigger is always this share of the window, whatever its source — the
// table, the default, or a gateway-reported window.
export const COMPACT_PCT = 90

// Known gateway models' context windows, keyed by the exact id `/v1/models`
// reports. M3's and GLM-5.3-Flash's windows are capped at 262144 on the current
// deployment (the models support more, the gateway's resources don't). Models
// served at the 200K default are deliberately absent: DEFAULT_WINDOW already
// describes them, and an entry restating the default is one more thing to keep
// in sync.
const TABLE: Record<string, number> = {
  "MiniMax/MiniMax-M3": 262144,
  "zai-org/GLM-5.3-Flash": 262144,
}

// Unrecognized models are treated as 200K-class: it matches the smaller of the
// models actually served, and guessing low is the safe direction — too small a
// window wastes capacity, too large overruns the model and 400s mid-session.
const DEFAULT_WINDOW = 200000

export const DEFAULT_LIMITS: ModelLimits = limitsFromWindow(DEFAULT_WINDOW)

// Windows reported by the gateway, cached in the shared auth file (the hub
// writes the same key from its model-choice step). Read once per process:
// building a config block calls limitsFor once per model and none of them can
// change the file mid-run.
let remoteCache: Record<string, ModelLimits> | null | undefined

function remoteLimits(): Record<string, ModelLimits> | null {
  if (remoteCache === undefined) remoteCache = loadModelLimits()
  return remoteCache
}

// Test seam, also used by cacheModelLimits: lets a fresh write become visible
// without the once-per-process cache leaking across cases.
export function resetModelLimitsCache(): void {
  remoteCache = undefined
}

// Persist gateway-reported windows for limitsFor's remote tier. Unlike the
// hub's one-shot CLI, the TUI and desktop are long-lived processes that write
// the cache and build a config block in the same run, so the process-local
// cache is reset alongside the write. An empty map is skipped entirely — a
// gateway that reports nothing must not churn the auth file or clear limits
// the hub cached.
export function cacheModelLimits(windows: Record<string, { context: number; output?: number }>): void {
  const entries = Object.entries(windows)
  if (entries.length === 0) return
  saveModelLimits(Object.fromEntries(entries.map(([id, w]) => [id, limitsFromWindow(w.context, w.output)])))
  resetModelLimitsCache()
}

// Resolve one model's limits. Precedence is remote → table → default: the
// gateway is authoritative about its own models when it says anything at all,
// and the table carries the models it currently reports nothing for.
export function limitsFor(modelId: string): ModelLimits {
  const remote = remoteLimits()?.[modelId]
  if (remote) return remote
  const window = TABLE[modelId]
  return window ? limitsFromWindow(window) : DEFAULT_LIMITS
}

// Turn a context window into full limits, wherever the window came from.
export function limitsFromWindow(context: number, output?: number): ModelLimits {
  return {
    context,
    trigger: Math.round((context * COMPACT_PCT) / 100),
    ...(output ? { output } : {}),
  }
}

// opencode's trigger is `limit.input − compaction.reserved`, falling back to
// `limit.context − maxOutputTokens` when `limit.input` is absent — a branch
// that ignores `reserved` entirely. So `input` is what makes the reserve
// authoritative, and the only per-model lever over a trigger that otherwise
// shares one global reserve across every model in the config. Solving
// `input − reserved = trigger` gives `input = trigger + reserved`, landing each
// model's trigger exactly on target regardless of what the others need.
//
// Clamped to the true window: above `context` the declared budget would let a
// session run past the model's real ceiling before compacting. Clamping only
// moves a trigger earlier, so a bad table entry degrades into early compaction
// rather than 400s.
export function declaredInput(limits: ModelLimits): number {
  return Math.min(limits.trigger + COMPACT_RESERVED, limits.context)
}

export function outputTokens(limits: ModelLimits): number {
  return limits.output ?? DEFAULT_OUTPUT_TOKENS
}
