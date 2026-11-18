import { BACKEND_URL } from "./const"
import type { CodevConfig } from "./auth-file"

interface ErrorResponse {
  error?: string
  // Machine-readable reason the backend attaches to some failures; see
  // BackendError.
  code?: string
}

// A non-2xx from the CoDev backend. Beyond the message every caller already
// prints, it keeps the backend's own `error` text (`reason`) and, when the
// backend sends one, its `code` — so a caller can branch on what kind of
// failure this was without pattern-matching prose. Hub parity: codev-hub's
// lib/backend.ts throws the same shape.
export class BackendError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason: string,
    public code?: string,
  ) {
    super(message)
    this.name = "BackendError"
  }
}

// The gateway looked at this user and declined to issue a key — today, an
// email domain outside its allowlist. The backend answers 403 with
// `code: "key_refused"`. Nothing on this machine changes the answer: retrying
// is pointless, and the way forward is a key issued by hand (the manual-entry
// path) or a fix on the gateway side. The code string is a wire contract with
// codev-backend/src/litellm.ts.
export function isKeyRefusal(err: unknown): err is BackendError {
  return err instanceof BackendError && err.code === "key_refused"
}

// Callers embedded in Electron pass the host-aware net.fetch so enterprise
// proxies and PAC files apply; everything else uses the runtime's fetch.
type FetchOptions = { fetchImpl?: typeof fetch }

const VALIDATE_TIMEOUT_MS = 5_000
const MODELS_TIMEOUT_MS = 10_000
// Backend endpoints are quick: a token exchange and a tiny config blob. Cap
// them so a stalled gateway surfaces as an error instead of wedging the TUI.
const BACKEND_TIMEOUT_MS = 10_000

// SSO access token → gateway API key (backend /auth/exchange). An empty key is
// returned, not thrown — callers route to the manual-credentials fallback.
export async function fetchApiKey(accessToken: string, opts?: FetchOptions): Promise<string> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const res = await fetchImpl(`${BACKEND_URL}/auth/exchange`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorResponse
    const reason = body.error || res.statusText
    throw new BackendError(`Backend /auth/exchange failed (${res.status}): ${reason}`, res.status, reason, body.code)
  }
  const data = (await res.json()) as { api_key?: string }
  return data.api_key ?? ""
}

// Pulls the runtime coordinates that are not baked into the binary — most
// importantly the public gateway base URL. Persisted next to the SSO session
// via saveCodevConfig, where the hub also reads it.
export async function fetchCodevConfig(accessToken: string, opts?: FetchOptions): Promise<CodevConfig> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const res = await fetchImpl(`${BACKEND_URL}/config`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorResponse
    throw new Error(`Backend /config failed (${res.status}): ${body.error || res.statusText}`)
  }
  const data = (await res.json()) as Partial<{ supabaseUrl: string; supabaseAnonKey: string; gatewayUrl: string }>
  if (!data.supabaseUrl || !data.supabaseAnonKey || !data.gatewayUrl) {
    throw new Error(`Backend /config returned incomplete payload: ${JSON.stringify(data)}`)
  }
  return {
    supabaseUrl: data.supabaseUrl,
    supabaseAnonKey: data.supabaseAnonKey,
    gatewayUrl: data.gatewayUrl,
  }
}

export interface AnalysisBackendSession {
  access_token: string
  refresh_token?: string
  expires_at?: number
  expires_in?: number
  user: {
    id: string
    email: string
  }
}

// SSO access token → analysis-backend (Supabase) session, for the session
// uploader. The `/supabase/exchange` path keeps the backend's own route name —
// it's the literal URL a reader has to grep the backend for when this fails —
// and the `failed (NNN)` error shape is what the uploader's refresh-retry
// trigger matches on (hub isRefreshableError parity).
export async function supabaseExchange(accessToken: string, opts?: FetchOptions): Promise<AnalysisBackendSession> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const res = await fetchImpl(`${BACKEND_URL}/supabase/exchange`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorResponse
    throw new Error(`Backend /supabase/exchange failed (${res.status}): ${body.error || res.statusText}`)
  }
  return (await res.json()) as AnalysisBackendSession
}

// Build a `<base>/v1/<suffix>` gateway URL. Manual base URLs may or may not
// carry a /v1 suffix — normalize so exactly one /v1 segment precedes the
// suffix either way.
function gatewayV1Url(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/$/, "")
  const withV1 = /\/v1$/.test(base) ? base : `${base}/v1`
  return `${withV1}/${suffix}`
}

// Fetches the model ids available to the given key via the OpenAI-compatible
// /v1/models endpoint. Throws on non-2xx, network errors, timeout, or an
// empty result — the caller decides whether to fall back.
export async function fetchModels(apiKey: string, baseUrl: string, opts?: FetchOptions): Promise<string[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const res = await fetchImpl(gatewayV1Url(baseUrl, "models"), {
    headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorResponse
    throw new Error(`Models fetch failed (${res.status}): ${body.error || res.statusText}`)
  }
  const data = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0)
  if (ids.length === 0) throw new Error("Gateway returned no models")
  return ids
}

// A window as the gateway reports it (hub ModelWindow). Deliberately NOT
// model-limits.ts's ModelLimits: callers convert with limitsFromWindow (via
// cacheModelLimits), which decides where the trigger belongs.
export interface ModelWindow {
  context: number
  output?: number
}

// Per-model context windows from LiteLLM's /model_group/info, keyed by
// model_group id — the same id /v1/models reports. Entries whose
// max_input_tokens the gateway hasn't been told are skipped, which today is
// all of them: the field is nullable and only populated when an admin sets it
// on the model. So this returns {} on the current deployment and the static
// table in model-limits.ts carries every model; the moment an admin fills the
// field in, that model becomes gateway-driven with no CoDev Code release.
//
// Unlike fetchModels, this NEVER throws and never fail-stops the caller: a
// window is an optimization over a sane default, and configure must not break
// because a metadata endpoint 404s on some other gateway build. The endpoint
// lives at the gateway root, so a trailing /v1 is stripped before joining.
export async function fetchModelWindows(
  apiKey: string,
  baseUrl: string,
  opts?: FetchOptions,
): Promise<Record<string, ModelWindow>> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  try {
    const stripped = baseUrl.replace(/\/?v1\/?$/, "")
    const res = await fetchImpl(`${stripped.endsWith("/") ? stripped : `${stripped}/`}model_group/info`, {
      headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    })
    if (!res.ok) return {}
    const data = (await res.json()) as {
      data?: Array<{ model_group?: string; max_input_tokens?: number | null; max_output_tokens?: number | null }>
    }
    const out: Record<string, ModelWindow> = {}
    for (const entry of data.data ?? []) {
      const id = entry.model_group
      const context = entry.max_input_tokens
      if (!id || typeof context !== "number" || context <= 0) continue
      const output =
        typeof entry.max_output_tokens === "number" && entry.max_output_tokens > 0 ? entry.max_output_tokens : undefined
      out[id] = { context, ...(output ? { output } : {}) }
    }
    return out
  } catch {
    return {}
  }
}

// Validates a key against the gateway's /key/info endpoint (LiteLLM): true on
// 2xx, false on 401/403 (invalid/revoked), throws on anything else so callers
// can distinguish "key is bad" from "couldn't reach the gateway". /key/info
// lives at the gateway root, so a trailing /v1 is stripped before joining.
export async function validateApiKey(apiKey: string, baseUrl: string, opts?: FetchOptions): Promise<boolean> {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const stripped = baseUrl.replace(/\/?v1\/?$/, "")
  const url = `${stripped.endsWith("/") ? stripped : `${stripped}/`}key/info`
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) return false
  if (!res.ok) throw new Error(`Validation failed (${res.status}): ${res.statusText}`)
  return true
}
