import { readFileSync } from "node:fs"
import { GATEWAY_PROVIDER, LEGACY_GATEWAY_PROVIDER_IDS, loadApiKey } from "@codev/gateway"
import { statsStatusPath } from "./paths"

// The sign-in nudge: the launch-time stats push needs a live CoDev SSO
// session, but the agent itself only needs the gateway api key — so a machine
// whose session died keeps working while its usage reporting silently stops,
// forever. The push records that stall in stats-status.json; the TUI and the
// desktop ask this module at startup whether to surface it. Kept free of
// sqlite/child_process imports so both can import it via the
// `@codev/upload/nudge` subpath without dragging the whole uploader into
// their module graphs.

// Opt-out for the automatic stats push. The interactive `codev upload`
// deliberately ignores it — typing the command is the opt-in.
export function metricsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CODEV_DISABLE_METRICS
  return value === "1" || value === "true"
}

// Shape of stats-status.json. `skipped` is written only for the not-signed-in
// stall; the other skips (opt-out, lock held) write nothing.
export interface StatsStatus {
  ok: boolean
  startedAt: string
  finishedAt: string
  skipped?: "not-logged-in"
  summary?: {
    found: number
    sent: number
    unchanged: number
    unsupported?: boolean
  }
  error?: string
}

export function readLastStatsStatus(): StatsStatus | null {
  try {
    return JSON.parse(readFileSync(statsStatusPath(), "utf-8")) as StatsStatus
  } catch {
    return null
  }
}

// Whether to show the "sign in to resume usage reporting" toast at this
// launch. Deliberately unthrottled — the toast repeats every startup until the
// user signs back in (or opts out). Conditions, in order:
//   - metrics not opted out (a user who disabled them asked for silence);
//   - a gateway api key exists AND is SSO-origin (no provider id, or the
//     AIGW identity, current or pre-rename). A manually-named provider may
//     belong to someone with no CoDev SSO account at all — nagging them to
//     sign in to something they can't would be wrong;
//   - the last push recorded the not-logged-in stall.
export function shouldNudgeSignIn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (metricsDisabled(env)) return false
  const key = loadApiKey()
  if (!key?.apiKey) return false
  if (key.providerId && key.providerId !== GATEWAY_PROVIDER.id && !LEGACY_GATEWAY_PROVIDER_IDS.includes(key.providerId))
    return false
  return readLastStatsStatus()?.skipped === "not-logged-in"
}
