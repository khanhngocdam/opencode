import { existsSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  authFilePath,
  clearSsoSession,
  forceLoginPath,
  loadAuth,
  markForceLogin,
  readAuthFile,
  saveAuth,
  type AuthData,
} from "./auth-file"
import { CLIENT_ID, LOGIN_SUCCESS_URL, SSO_URL } from "./const"

// Token/userinfo endpoints are quick handshakes — cap them so a hung IdP
// surfaces as an error instead of wedging the configure dialog indefinitely.
const SSO_FETCH_TIMEOUT_MS = 10_000
// How long we wait for the authorization code — via the loopback callback or
// a manual paste-back. Generous because a no-browser user may be hopping to
// another device to authenticate and copy the URL back by hand.
const AUTH_CALLBACK_TIMEOUT_MS = 300_000
// Revocation is best-effort (an unrevoked token just expires naturally), so
// give a hung IdP a short leash instead of stalling the sign-out UI.
const REVOKE_TIMEOUT_MS = 3_000

interface TokenResponse {
  access_token: string
  id_token: string
  refresh_token?: string
  expires_in: number
}

// How login() hands the interactive step back to its caller: a function that
// opens the browser, the directly-pasteable /authorize URL for no-browser
// environments, and a manual paste-back submitter that returns an inline error
// string to re-prompt (or null once the code is accepted — the login() promise
// then resolves on its own).
export type OnLoginReady = (
  openBrowserFn: () => void,
  authUrl: string,
  submitManualCode: (pasted: string) => string | null,
) => void

export interface LoginOptions {
  onLog: (msg: string) => void
  onReady: OnLoginReady
  // Browser launcher; the TUI passes its own `open` util. Fire-and-forget —
  // the loopback server resolves the flow whether or not a browser launched.
  openUrl: (url: string) => Promise<unknown>
  // Callers embedded in Electron pass the host-aware net.fetch so the token
  // exchange rides the same proxies and PAC files as the backend calls;
  // everything else uses the runtime's fetch.
  fetchImpl?: typeof fetch
  // Aborting closes the loopback server and rejects with a cancellation
  // (isLoginCancelled) at whichever step the flow is on, so a sign-in the user
  // backed out of can't complete later and write a session behind their back.
  signal?: AbortSignal
}

// Whether a login() rejection is the caller's own abort rather than a failure
// worth surfacing.
export function isLoginCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "LoginCancelled"
}

function loginCancelled(): Error {
  const error = new Error("Login cancelled")
  error.name = "LoginCancelled"
  return error
}

// Combines the per-request timeout with the caller's abort, when there is one.
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

// An abort mid-request surfaces as the fetch's own AbortError; report it as
// the cancellation it is so callers don't show it as a failure.
function rethrow(signal?: AbortSignal) {
  return (error: unknown): never => {
    if (signal?.aborted) throw loginCancelled()
    throw error
  }
}

/**
 * OAuth2 Authorization Code flow with PKCE against the CoDev SSO wrapper,
 * ported from the hub (src/lib/auth.ts) so both tools share one session in
 * the resolved auth file (the hub's ~/.codev-hub/auth.json when present, else
 * our own ~/.codev/auth.json):
 * 1. Reuse cached tokens if still valid
 * 2. Try a silent refresh if a refresh_token is on disk
 * 3. Otherwise: loopback HTTP server, /authorize with state + nonce + PKCE,
 *    wait for the callback (or manual paste), exchange code for tokens, fetch
 *    userinfo, persist.
 */
export async function login(options: LoginOptions): Promise<AuthData> {
  const log = options.onLog
  log("Starting SSO login...")

  // Dev escape hatch (hub parity): skip OAuth and persist a stub session so
  // the rest of the flow can be exercised while the SSO wrapper is down.
  if (process.env.CODEV_BYPASS_LOGIN === "1") {
    log("CODEV_BYPASS_LOGIN=1 — skipping SSO, using stub session.")
    const authData: AuthData = {
      access_token: "codev-bypass-no-sso",
      id_token: "codev-bypass-no-sso",
      expires_at: Date.now() + 3_600_000,
      user: { sub: "codev-bypass", email: "bypass@local", displayName: "Bypass User" },
    }
    saveAuth(authData)
    clearForceLogin()
    log(`Logged in as ${authData.user.email}`)
    return authData
  }

  const existing = loadAuth()
  if (existing) {
    log(`Already logged in as ${existing.user.email}`)
    return existing
  }

  const stale = readAuthFile()
  if (stale?.refresh_token) {
    try {
      log("Refreshing session...")
      const authData = await refreshToAuthData(stale.refresh_token, options.fetchImpl, options.signal)
      saveAuth(authData)
      log(`Logged in as ${authData.user.email}`)
      return authData
    } catch {
      if (options.signal?.aborted) throw loginCancelled()
      log("Refresh failed, starting full login...")
    }
  }

  // Force re-auth via the IdP login form (prompt=login bounce) when there is
  // no auth.json at all (fresh machine / post-`codevhub remove`) or the hub's
  // logout left its force-login sentinel — revoking tokens does not terminate
  // the IdP's browser-session cookie.
  const forceLogin = !existsSync(authFilePath()) || existsSync(forceLoginPath())

  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  const state = crypto.randomUUID()
  const nonce = crypto.randomUUID()

  const { code, redirectUri } = await getAuthCode(options, state, challenge, nonce, forceLogin)

  const tokenRes = await exchangeCode(code, redirectUri, verifier, options).catch(rethrow(options.signal))
  const user = await fetchUserInfo(tokenRes.access_token, options.fetchImpl, options.signal).catch(
    rethrow(options.signal),
  )

  const authData: AuthData = {
    access_token: tokenRes.access_token,
    id_token: tokenRes.id_token,
    refresh_token: tokenRes.refresh_token,
    expires_at: Date.now() + tokenRes.expires_in * 1000,
    user: {
      sub: user.sub,
      email: user.email,
      displayName: user.displayName || user.name || user.sub,
    },
  }

  // The last window an abort can land in: nothing may reach disk after it.
  if (options.signal?.aborted) throw loginCancelled()
  saveAuth(authData)
  clearForceLogin()
  log(`Logged in as ${authData.user.email}`)
  return authData
}

// Non-interactive SSO: reuse a non-expired cached session, else silently
// refresh via the stored refresh_token. Returns null when neither works —
// callers then run the interactive login().
export async function silentSso(opts?: { fetchImpl?: typeof fetch }): Promise<AuthData | null> {
  const cached = loadAuth()
  if (cached) return cached
  const stale = readAuthFile()
  if (!stale?.refresh_token) return null
  try {
    const authData = await refreshToAuthData(stale.refresh_token, opts?.fetchImpl)
    saveAuth(authData)
    return authData
  } catch {
    return null
  }
}

export type SessionProbe = "live" | "dead" | "unknown"

// Whether the SSO session on disk is actually usable, distinguishing a dead
// session from an unreachable IdP: only the wrapper definitively rejecting the
// refresh token reads as "dead" (mirrors ensureKey's rule that a network
// failure must never cost someone their session — callers treat "unknown" as
// optimistically live). A successful probe persists the refreshed tokens, so
// the next check short-circuits on the unexpired access token.
export async function probeSession(opts?: { fetchImpl?: typeof fetch }): Promise<SessionProbe> {
  if (loadAuth()) return "live"
  const stale = readAuthFile()
  if (!stale?.refresh_token) return "dead"
  const fetchImpl = opts?.fetchImpl ?? fetch
  const res = await fetchImpl(`${SSO_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stale.refresh_token,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(SSO_FETCH_TIMEOUT_MS),
  }).catch(() => null)
  if (!res) return "unknown"
  if (!res.ok) {
    // 400 is what OAuth's invalid_grant rides on; 401/403 are wrapper
    // rejections. Anything else (5xx, gateway errors) proves nothing.
    return res.status === 400 || res.status === 401 || res.status === 403 ? "dead" : "unknown"
  }
  const tokens = (await res.json().catch(() => null)) as TokenResponse | null
  if (!tokens) return "unknown"
  // Persist before returning: a successful refresh may rotate the
  // refresh_token, and dropping the rotation would strand the very session
  // the probe just proved live. The stale user block stands in when the
  // userinfo round-trip fails — the identity does not change on a refresh.
  const user = await fetchUserInfo(tokens.access_token, fetchImpl).catch(() => null)
  saveAuth({
    access_token: tokens.access_token,
    id_token: tokens.id_token,
    refresh_token: tokens.refresh_token || stale.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    user: user
      ? { sub: user.sub, email: user.email, displayName: user.displayName || user.name || user.sub }
      : (stale.user ?? { sub: "", email: "", displayName: "" }),
  })
  return "live"
}

// Port of hub logout (src/lib/auth.ts): drop the SSO block from the auth file
// (the api-key/config blocks and hub cookie survive — the app keeps running on
// the gateway key), leave the force-login sentinel so the next login re-prompts
// for credentials instead of riding the IdP's session cookie, then best-effort
// revoke the dropped tokens. Returns false when there was no session to end.
// Disk first, network second: a hung IdP must never leave the session on disk.
export async function logout(opts?: { fetchImpl?: typeof fetch }): Promise<boolean> {
  const dropped = clearSsoSession()
  if (!dropped) return false
  markForceLogin()
  const fetchImpl = opts?.fetchImpl ?? fetch
  await Promise.all([
    revokeToken(fetchImpl, dropped.accessToken, "access_token"),
    revokeToken(fetchImpl, dropped.refreshToken, "refresh_token"),
  ])
  return true
}

// RFC 7009 revocation against the SSO wrapper. Fire-and-forget semantics: all
// errors (timeouts, non-2xx) are swallowed — an unrevoked token expires on its
// own, and logout already succeeded the moment the file was rewritten.
async function revokeToken(fetchImpl: typeof fetch, token: string | undefined, hint: string): Promise<void> {
  if (!token) return
  await fetchImpl(`${SSO_URL}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: hint, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  }).catch(() => {})
}

async function refreshToAuthData(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AuthData> {
  const refreshed = await refreshTokens(refreshToken, fetchImpl, signal)
  const user = await fetchUserInfo(refreshed.access_token, fetchImpl, signal)
  return {
    access_token: refreshed.access_token,
    id_token: refreshed.id_token,
    refresh_token: refreshed.refresh_token || refreshToken,
    expires_at: Date.now() + refreshed.expires_in * 1000,
    user: {
      sub: user.sub,
      email: user.email,
      displayName: user.displayName || user.name || user.sub,
    },
  }
}

function clearForceLogin() {
  try {
    unlinkSync(forceLoginPath())
  } catch {
    // Fine if it didn't exist.
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = ""
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(hash))
}

// Extracts OAuth callback params from pasted text: a full callback URL, a
// scheme-less "127.0.0.1:PORT/callback?...", a bare query string, or a leading
// "?". Returns null when the paste carries no recognizable params — the caller
// then treats it as a bare authorization code.
export function parseCallbackParams(pasted: string): URLSearchParams | null {
  try {
    return new URL(pasted).searchParams
  } catch {
    // Not a full URL — fall through.
  }
  const query = pasted.includes("?") ? pasted.slice(pasted.indexOf("?") + 1) : pasted
  if (/(?:^|&)(?:code|state|error)=/.test(query)) {
    return new URLSearchParams(query)
  }
  return null
}

function getAuthCode(
  options: LoginOptions,
  expectedState: string,
  codeChallenge: string,
  nonce: string,
  forceLogin: boolean,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    // Set once the flow resolves or rejects — by the loopback callback, a
    // manual paste, the timeout, or the caller's abort — so no two paths can
    // both fire.
    let settled = false
    const onAbort = () => failWith(loginCancelled())
    const finish = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      options.signal?.removeEventListener("abort", onAbort)
    }

    // Captured once when listen() completes — server.address() returns null
    // after close(), and a stray keep-alive request can arrive that late.
    let boundPort = 0

    // Two authorize targets, mirroring loopback OAuth CLIs (gh, gcloud): the
    // local browser is sent straight to the loopback callback; the manual
    // paste-back channel gets the public success page, which displays the code
    // to copy when the terminal is on another machine. The wrapper keys the
    // code to PKCE, so the token exchange can use the loopback redirect_uri
    // for either.
    const buildAuthorizeUrl = (redirectUri: string) =>
      `${SSO_URL}/authorize?` +
      `response_type=code` +
      `&client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=openid%20profile%20email%20offline_access` +
      `&state=${expectedState}` +
      `&nonce=${nonce}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256` +
      // OIDC's own re-authentication signal, in place of an earlier bounce
      // through the wrapper's /logout: that endpoint answered a sign-in with no
      // live IdP session with its refusal page, and it was the first window a
      // fresh machine ever opened. A wrapper that ignores prompt=login reuses
      // the live session instead, which is the recoverable outcome.
      (forceLogin ? `&prompt=login` : ``)

    const loopbackAuthorizeUrl = (port: number) => buildAuthorizeUrl(`http://127.0.0.1:${port}/callback`)
    const manualAuthorizeUrl = buildAuthorizeUrl(LOGIN_SUCCESS_URL)

    const succeed = (code: string) => {
      if (settled) return
      settled = true
      finish()
      server.close()
      resolve({ code, redirectUri: `http://127.0.0.1:${boundPort}/callback` })
    }

    const failWith = (err: Error) => {
      if (settled) return
      settled = true
      finish()
      server.close()
      reject(err)
    }

    // Manual paste-back for no-browser environments: accepts a full URL, a
    // bare query string, or a bare code. Returns an inline error string to
    // re-prompt without restarting, or null once the code is accepted.
    const submitManualCode = (pasted: string): string | null => {
      if (settled) return null
      const trimmed = pasted.trim()
      if (!trimmed) return "Paste the callback URL (or code) first."

      const params = parseCallbackParams(trimmed)
      const errParam = params?.get("error")
      if (errParam) {
        return `SSO returned an error: ${params?.get("error_description") || errParam}`
      }

      // No params → treat the whole paste as a bare authorization code. There
      // is no state to cross-check, but PKCE still binds it to our verifier at
      // the token exchange.
      const code = params ? params.get("code") : trimmed
      if (!code) return "No authorization code found in the pasted URL."
      const returnedState = params?.get("state") ?? null
      if (returnedState !== null && returnedState !== expectedState) {
        return "That URL is from a different login attempt (state mismatch). Use the most recent URL."
      }

      succeed(code)
      return null
    }

    const server = createServer((req, res) => {
      // Parsed against a fixed base, never the Host header: the server is
      // bound to 127.0.0.1 and only the path and query matter. Building the
      // base from Host used to throw on a malformed value (any local process
      // can send `Host: [`), and an exception in the request listener is an
      // uncaught exception that took the whole process down for the length of
      // the sign-in wait. A target the parser still rejects is answered.
      const url = URL.parse(req.url ?? "/", "http://127.0.0.1")
      if (!url) {
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("Bad request")
        return
      }

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("Not found")
        return
      }

      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error")
      const returnedState = url.searchParams.get("state")

      // Hand the browser on to the hosted success page as the user-facing
      // confirmation; failures carry ?error=... so the page renders an error.
      const respond = (ok: boolean, msg?: string) => {
        const sep = LOGIN_SUCCESS_URL.includes("?") ? "&" : "?"
        const location = ok
          ? LOGIN_SUCCESS_URL
          : `${LOGIN_SUCCESS_URL}${sep}error=login_failed&error_description=${encodeURIComponent(msg ?? "Unknown error")}`
        res.writeHead(302, { Location: location })
        res.end()
      }

      if (error) {
        const desc = url.searchParams.get("error_description") || error
        respond(false, desc)
        failWith(new Error(`SSO login failed: ${desc}`))
        return
      }
      if (!code) {
        respond(false, "No authorization code received")
        failWith(new Error("No authorization code received"))
        return
      }
      if (returnedState !== expectedState) {
        respond(false, "State mismatch")
        failWith(new Error("State mismatch (possible CSRF attack)"))
        return
      }

      respond(true)
      succeed(code)
    })

    if (options.signal?.aborted) {
      reject(loginCancelled())
      return
    }
    // Armed before listen() so an abort that lands while the port is still
    // being bound closes the server instead of leaving it listening.
    options.signal?.addEventListener("abort", onAbort, { once: true })

    server.listen(0, "127.0.0.1", () => {
      // Aborted while the port was being bound: the abort's close() found no
      // running server, so close the one that just came up.
      if (settled) {
        server.close()
        return
      }
      boundPort = (server.address() as AddressInfo).port
      // Local browser: the loopback authorize URL. Manual channel: the public
      // success-page authorize URL a remote browser can complete.
      const initialUrl = loopbackAuthorizeUrl(boundPort)

      // Arm the timeout before handing control to the caller so a caller that
      // settles synchronously clears a real timer instead of leaking one.
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null
        failWith(new Error("Login timed out after 5 minutes"))
      }, AUTH_CALLBACK_TIMEOUT_MS)

      options.onReady(
        () => {
          options.onLog("Opening browser for SSO login...")
          options.openUrl(initialUrl).catch(() => {})
        },
        manualAuthorizeUrl,
        submitManualCode,
      )
    })
  })
}

async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  options: Pick<LoginOptions, "fetchImpl" | "signal">,
): Promise<TokenResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const res = await fetchImpl(`${SSO_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
    signal: requestSignal(SSO_FETCH_TIMEOUT_MS, options.signal),
  })
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as TokenResponse
}

async function refreshTokens(
  refreshToken: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const res = await fetchImpl(`${SSO_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: requestSignal(SSO_FETCH_TIMEOUT_MS, signal),
  })
  if (!res.ok) throw new Error(`Token refresh failed (${res.status})`)
  return (await res.json()) as TokenResponse
}

async function fetchUserInfo(accessToken: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  const res = await fetchImpl(`${SSO_URL}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: requestSignal(SSO_FETCH_TIMEOUT_MS, signal),
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch user info (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as { sub: string; email: string; displayName?: string; name?: string }
}
