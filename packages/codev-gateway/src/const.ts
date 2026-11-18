// CoDev backend coordinates, mirrored from the codev hub's src/lib/const.ts so
// a standalone CoDev Code install can configure the gateway without the hub.
// Base64 (like the hub) to keep the host out of casual greps, not as a secret.
const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4=")
// `CODEV_BACKEND_URL` points the client at a codev-backend running somewhere
// else — `bun dev` in that repo serves http://127.0.0.1:8787. Unset in every
// real install, so the baked URL is what ships. SSO is deliberately NOT
// overridable: a local backend still verifies tokens against the real
// provider, so the login flow has to mint a real one.
export const BACKEND_URL = process.env.CODEV_BACKEND_URL || `${BASE_URL}/codev-backend`
export const SSO_URL = `${BASE_URL}/sso-wrapper`
export const LOGIN_SUCCESS_URL = `${BASE_URL}/codev/oauth/success`

export const CLIENT_ID = atob("bGl0ZWxsbS10ZXN0")

// Context windows and compaction triggers are per-model and live in
// model-limits.ts, mirrored from the hub's src/lib/model-limits.ts. They used
// to be flat GATEWAY_CONTEXT_WINDOW / GATEWAY_COMPACT_* constants here, which
// assumed every gateway model shared one 196608-token window — untrue once
// the gateway served differently sized models.
