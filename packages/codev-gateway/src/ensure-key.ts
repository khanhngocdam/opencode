import { loadApiKey, loadGatewayUrl, saveApiKey, type AuthData } from "./auth-file"
import { fetchApiKey, validateApiKey } from "./backend"
import { GATEWAY_PROVIDER, LEGACY_GATEWAY_PROVIDER_IDS } from "./provider"
import { probeSession, silentSso } from "./sso"

// Cap the key check so a slow or hung gateway never delays startup. A real
// /key/info round-trip is far under this; past it we cannot prove the key is
// dead, so we leave it alone (mirrors codev-hub's launch pre-flight).
const KEY_CHECK_TIMEOUT_MS = 2_500

export type GatewayKeyCheck =
  // Key validated, or the gateway could not be reached to say otherwise.
  | { status: "ok" }
  // A rejected key was re-minted silently. Every id in providerIDs needs the
  // new credential in the local server's auth registry: the current SSO
  // identity plus its pre-rename spellings, so a config block written before
  // an identity rename is re-keyed too instead of 401ing on a credential
  // nothing updates. baseUrl and auth are what a caller that tracks the
  // signed-in session (the desktop controller) adopts from the refresh.
  | { status: "refreshed"; providerIDs: string[]; apiKey: string; baseUrl: string; auth: AuthData }
  // "no-key": nothing stored — a machine set up with a non-gateway provider,
  // or never set up. "rejected": the gateway refused the stored key and the
  // SSO session could not re-mint it without a browser sign-in. "expired": the
  // key was minted through SSO and the IdP has definitively rejected that
  // session's refresh token, so CoDev must not be used until the user signs in
  // again — whether or not the gateway still accepts the key.
  | { status: "needs-login"; reason: "no-key" | "rejected" | "expired" }

export type EnsureKeyFns = {
  loadApiKey: typeof loadApiKey
  loadGatewayUrl: typeof loadGatewayUrl
  validateApiKey: typeof validateApiKey
  silentSso: typeof silentSso
  probeSession: typeof probeSession
  fetchApiKey: typeof fetchApiKey
  saveApiKey: typeof saveApiKey
}

export interface EnsureKeyOptions {
  // Electron callers pass the host-aware net.fetch so proxies and PAC files
  // apply to the check and the re-mint alike.
  fetchImpl?: typeof fetch
  timeoutMs?: number
  // Injectable for tests; defaults to this package's own functions.
  fns?: Partial<EnsureKeyFns>
}

// Startup pre-flight for the stored gateway key, the client twin of
// codev-hub's ensureFreshGatewayKey. Gateway keys have a lifetime CoDev does
// not control, and nothing else notices a dead one: the provider stays
// "connected" with a credential that 401s on every message, and the configure
// gate only fires when no provider is connected at all — so the sign-in flow
// was unreachable exactly when it was needed.
//
// A rejected key is refreshed silently when the SSO session still allows it,
// which is the common case and costs the user nothing; the refreshed key is
// written to the shared auth file here, and the caller merges it into the
// local server's auth registry. Only a key that cannot be refreshed without a
// browser round-trip asks for one. Never throws on network trouble: only a
// definite rejection acts, because a gateway that is slow or unreachable must
// never cost someone their session.
export async function ensureGatewayKey(options: EnsureKeyOptions = {}): Promise<GatewayKeyCheck> {
  const fns: EnsureKeyFns = {
    loadApiKey,
    loadGatewayUrl,
    validateApiKey,
    silentSso,
    probeSession,
    fetchApiKey,
    saveApiKey,
    ...options.fns,
  }
  const fetchOpts = { fetchImpl: options.fetchImpl }
  const creds = fns.loadApiKey()
  if (!creds?.apiKey) return { status: "needs-login", reason: "no-key" }
  // SSO-minted keys record no base_url (the configure flows write it for
  // manual keys only), so fall back to the gateway URL saved with the config
  // block.
  const baseUrl = creds.baseUrl ?? fns.loadGatewayUrl()
  if (!baseUrl) return { status: "needs-login", reason: "no-key" }

  // true = valid, false = rejected, null = could not tell.
  const valid = await Promise.race([
    fns.validateApiKey(creds.apiKey, baseUrl, fetchOpts).catch(() => null),
    new Promise<null>((resolve) => setTimeout(resolve, options.timeoutMs ?? KEY_CHECK_TIMEOUT_MS, null)),
  ])
  // SSO-minted keys record no base_url; a manually entered key does, and is
  // not tied to any SSO session.
  const ssoMinted = !creds.baseUrl
  const sessionDead = async () =>
    ssoMinted && (await fns.probeSession(fetchOpts).catch(() => "unknown" as const)) === "dead"
  if (valid !== false) {
    if (await sessionDead()) return { status: "needs-login", reason: "expired" }
    return { status: "ok" }
  }

  const auth = await fns.silentSso(fetchOpts).catch(() => null)
  if (!auth) {
    if (await sessionDead()) return { status: "needs-login", reason: "expired" }
    return { status: "needs-login", reason: "rejected" }
  }
  const refreshed = await fns.fetchApiKey(auth.access_token, fetchOpts).catch(() => "")
  if (!refreshed) return { status: "needs-login", reason: "rejected" }

  // Keep every other field: the provider identity and model are what a
  // manually named provider is rewritten from, and dropping them would
  // silently re-label it.
  fns.saveApiKey({ ...creds, apiKey: refreshed })
  return {
    status: "refreshed",
    providerIDs: [GATEWAY_PROVIDER.id, ...LEGACY_GATEWAY_PROVIDER_IDS],
    apiKey: refreshed,
    baseUrl,
    auth,
  }
}
