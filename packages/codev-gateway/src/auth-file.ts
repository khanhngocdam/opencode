import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
// Type-only: model-limits.ts imports loadModelLimits from here, so a value
// import would close a require cycle (hub src/lib/auth.ts has the same note).
import type { ModelLimits } from "./model-limits"

export interface AuthData {
  access_token: string
  id_token: string
  refresh_token?: string
  expires_at: number
  user: {
    sub: string
    email: string
    displayName: string
  }
}

export interface ApiKeyCreds {
  apiKey: string
  baseUrl?: string
  model?: string
  // Set only by the hub's manual-key path, where the user names their own
  // provider. Absent ⇒ the key is SSO-issued and takes the AIGW default.
  providerId?: string
  providerName?: string
}

export interface CodevConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  gatewayUrl: string
}

// The auth file is SHARED with the codev hub: identical shape (hub
// src/lib/auth.ts AuthFileContents). The hub owns ~/.codev-hub/auth.json; when
// that file exists we read AND write it — writes must follow reads because a
// silent refresh may rotate the refresh_token, and persisting the rotated
// token anywhere else would strand the hub on a dead session. Without a hub
// file we fall back to our own ~/.codev/auth.json. Three independent blocks —
// SSO tokens, gateway API key, CoDev runtime config — each updated in
// isolation so saving one never clobbers the others. skillhub_cookie is
// hub-only; the read-merge-write pattern preserves it untouched.
interface AuthFileContents {
  access_token?: string
  id_token?: string
  refresh_token?: string
  expires_at?: number
  user?: AuthData["user"]
  api_key?: string
  base_url?: string
  model?: string
  provider_id?: string
  provider_name?: string
  supabase_url?: string
  supabase_anon_key?: string
  gateway_url?: string
  skillhub_cookie?: string
  model_limits?: Record<string, ModelLimits>
}

// Keyed off the hub's auth.json rather than the ~/.codev-hub/ dir (mirroring
// the hub's own fresh-install check): unrelated code creates the directory,
// so only the file signals a hub session worth adopting. Home is resolved per
// call via CODEV_TEST_HOME (same convention as core's Global) because
// Bun's homedir() ignores runtime HOME changes, which tests rely on.
function authDir() {
  const home = process.env.CODEV_TEST_HOME ?? homedir()
  const hub = join(home, ".codev-hub")
  if (existsSync(join(hub, "auth.json"))) return hub
  return join(home, ".codev")
}

export function authFilePath() {
  return join(authDir(), "auth.json")
}

// Written by the hub's `codevhub logout` (revoking tokens doesn't end the
// IdP's browser session); honored here so a post-logout login re-prompts for
// credentials instead of silently riding the session cookie. Resolved against
// the same dir as auth.json so we honor the hub's sentinel when riding its
// session.
export function forceLoginPath() {
  return join(authDir(), "force-login")
}

// Hub-parity sentinel writer (hub src/lib/auth.ts markForceLogin): revoking
// tokens does not end the IdP's browser-session cookie, so logout leaves this
// marker and the next login() bounces through the IdP's /logout first.
export function markForceLogin(): void {
  const path = forceLoginPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, "", { mode: 0o600 })
}

export function readAuthFile(): AuthFileContents | null {
  try {
    return JSON.parse(readFileSync(authFilePath(), "utf-8")) as AuthFileContents
  } catch {
    return null
  }
}

function writeAuthFile(data: AuthFileContents): void {
  const path = authFilePath()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdirSync's mode is ignored when the directory already exists, and
  // writeFileSync's mode is ignored when the file already exists, so re-apply
  // permissions explicitly to tighten any pre-existing loose perms.
  chmodSync(dir, 0o700)
  // Atomic write: stage to a per-process tmp sibling, chmod 0600 before rename
  // so the published file never appears world-readable, then rename over the
  // live path — concurrent writers (the hub's daemon, another codev process)
  // end up with one whole write or the other, never a torn merge.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp may already be absent.
    }
    throw err
  }
  // Re-apply mode after rename for the overwrite case where the renamed inode
  // inherits the destination's prior mode on some platforms.
  chmodSync(path, 0o600)
}

export function loadAuth(): AuthData | null {
  const raw = readAuthFile()
  if (!raw) return null
  if (!raw.access_token || !raw.id_token || !raw.expires_at || !raw.user) return null
  if (Date.now() > raw.expires_at) return null
  return {
    access_token: raw.access_token,
    id_token: raw.id_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at,
    user: raw.user,
  }
}

export function saveAuth(data: AuthData): void {
  writeAuthFile({
    ...(readAuthFile() ?? {}),
    access_token: data.access_token,
    id_token: data.id_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    user: data.user,
  })
}

// Writes the whole api-key block (hub saveApiKey semantics): an omitted
// provider pair *clears* it — JSON.stringify drops the undefineds — so saving
// a fresh SSO key over a hub-written manually-named key doesn't leave a stale
// identity behind for the hub to misattribute.
export function saveApiKey(creds: ApiKeyCreds): void {
  writeAuthFile({
    ...(readAuthFile() ?? {}),
    api_key: creds.apiKey,
    base_url: creds.baseUrl,
    model: creds.model,
    provider_id: creds.providerId,
    provider_name: creds.providerName,
  })
}

export function loadApiKey(): ApiKeyCreds | null {
  const raw = readAuthFile()
  if (!raw?.api_key) return null
  return {
    apiKey: raw.api_key,
    baseUrl: raw.base_url,
    model: raw.model,
    providerId: raw.provider_id,
    providerName: raw.provider_name,
  }
}

// The gateway's per-model windows, shared with the hub (hub saveModelLimits
// writes the same key). Skips the write entirely for an empty map so a gateway
// that reports nothing — every max_input_tokens null, the case today — doesn't
// churn the auth file on every configure run. Callers go through
// model-limits.ts cacheModelLimits, which also resets its process-local cache.
export function saveModelLimits(limits: Record<string, ModelLimits>): void {
  if (Object.keys(limits).length === 0) return
  writeAuthFile({ ...(readAuthFile() ?? {}), model_limits: limits })
}

export function loadModelLimits(): Record<string, ModelLimits> | null {
  return readAuthFile()?.model_limits ?? null
}

// Hub-only credential (written by `codevhub login --admin`); read here so
// skill commands can ride an existing admin session, never written.
export function loadSkillhubCookie(): string | null {
  return readAuthFile()?.skillhub_cookie ?? null
}

// Port of hub clearSkillhubCookie (src/lib/auth.ts): drops only the cookie so
// a sign-out ends the admin session without touching the SSO or api-key
// blocks. Deletes the file when the cookie was its only content.
export function clearSkillhubCookie(): boolean {
  const raw = readAuthFile()
  if (!raw?.skillhub_cookie) return false
  const rest: AuthFileContents = { ...raw, skillhub_cookie: undefined }
  writeOrDelete(rest)
  return true
}

// The signed-in identity for display. A stale access token with a
// refresh_token on disk still counts (silentSso revives it), so this must not
// gate on loadAuth()'s expiry check alone — but a dead-dead session (expired
// access token and nothing to refresh with) reads as logged out. Whether a
// present refresh_token is still honored server-side is unknowable from disk;
// that stays optimistic.
export function loadAccount(): { email: string; displayName: string } | null {
  const raw = readAuthFile()
  if (!raw?.user) return null
  const revivable = raw.refresh_token || (raw.access_token && raw.expires_at && Date.now() <= raw.expires_at)
  if (!revivable) return null
  return { email: raw.user.email, displayName: raw.user.displayName }
}

// The file half of logout (hub src/lib/auth.ts logout): an allowlist rewrite
// that drops the SSO block and keeps everything else — the gateway api-key
// block, the runtime config, the hub's admin cookie, cached model limits.
// Deletes the file outright when nothing survives. Returns the dropped tokens
// for best-effort revocation, or null when there was no session to clear.
export function clearSsoSession(): { accessToken?: string; refreshToken?: string } | null {
  const raw = readAuthFile()
  if (!raw) return null
  if (!raw.access_token && !raw.refresh_token) return null
  const preserved: AuthFileContents = {
    api_key: raw.api_key,
    base_url: raw.base_url,
    model: raw.model,
    provider_id: raw.provider_id,
    provider_name: raw.provider_name,
    supabase_url: raw.supabase_url,
    supabase_anon_key: raw.supabase_anon_key,
    gateway_url: raw.gateway_url,
    skillhub_cookie: raw.skillhub_cookie,
    model_limits: raw.model_limits,
  }
  writeOrDelete(preserved)
  return { accessToken: raw.access_token, refreshToken: raw.refresh_token }
}

// JSON.stringify drops undefined values, so a rewrite whose every field is
// undefined would leave a misleading "{}" behind — delete the file instead
// (hub logout does the same).
function writeOrDelete(contents: AuthFileContents): void {
  if (Object.values(contents).some((value) => value !== undefined)) {
    writeAuthFile(contents)
    return
  }
  unlinkSync(authFilePath())
}

export function saveCodevConfig(config: CodevConfig): void {
  writeAuthFile({
    ...(readAuthFile() ?? {}),
    supabase_url: config.supabaseUrl,
    supabase_anon_key: config.supabaseAnonKey,
    gateway_url: config.gatewayUrl,
  })
}

export function loadGatewayUrl(): string | null {
  return readAuthFile()?.gateway_url ?? null
}

// Full runtime-config readback for the session uploader. null until a login
// has populated the cache via saveCodevConfig — callers refresh and retry
// rather than guessing coordinates.
export function loadCodevConfig(): CodevConfig | null {
  const raw = readAuthFile()
  if (!raw?.supabase_url || !raw.supabase_anon_key || !raw.gateway_url) return null
  return {
    supabaseUrl: raw.supabase_url,
    supabaseAnonKey: raw.supabase_anon_key,
    gatewayUrl: raw.gateway_url,
  }
}
