import { describe, expect, test } from "bun:test"
import { ensureGatewayKey } from "../src/ensure-key"
import { GATEWAY_PROVIDER, LEGACY_GATEWAY_PROVIDER_IDS } from "../src/provider"
import type { AuthData } from "../src/auth-file"

// The startup pre-flight shared by the desktop controller and the TUI. Only a
// definite rejection acts, and it prompts only when a silent re-mint is
// impossible.
describe("ensureGatewayKey", () => {
  const creds = { apiKey: "sk-old", model: "m", baseUrl: "https://gw.test" }
  const auth: AuthData = {
    access_token: "token",
    id_token: "id",
    expires_at: Date.now() + 60_000,
    user: { sub: "sub", email: "user@example.test", displayName: "User" },
  }

  test("leaves a valid key alone", async () => {
    const result = await ensureGatewayKey({
      fns: { loadApiKey: () => creds, validateApiKey: async () => true },
    })
    expect(result).toEqual({ status: "ok" })
  })

  // A gateway that cannot be reached is not evidence the key is dead, and
  // must never cost someone their session.
  test("leaves the key alone when validation cannot answer", async () => {
    let refreshed = false
    const result = await ensureGatewayKey({
      fns: {
        loadApiKey: () => creds,
        validateApiKey: async () => {
          throw new Error("network down")
        },
        silentSso: async () => {
          refreshed = true
          return auth
        },
      },
    })
    expect(result).toEqual({ status: "ok" })
    expect(refreshed).toBe(false)
  })

  test("a validation slower than the cap counts as no answer", async () => {
    const result = await ensureGatewayKey({
      timeoutMs: 10,
      fns: {
        loadApiKey: () => creds,
        validateApiKey: () => new Promise((resolve) => setTimeout(resolve, 200, false)),
      },
    })
    expect(result).toEqual({ status: "ok" })
  })

  test("re-mints a rejected key silently and hands back the credential", async () => {
    let saved: { apiKey: string; model?: string } | undefined
    const fetchImpl: typeof fetch = (async (_input: string | URL | Request) => new Response("")) as typeof fetch
    const seen: Array<typeof fetch | undefined> = []
    const result = await ensureGatewayKey({
      fetchImpl,
      fns: {
        loadApiKey: () => creds,
        validateApiKey: async (_key, _url, opts) => {
          seen.push(opts?.fetchImpl)
          return false
        },
        silentSso: async (opts) => {
          seen.push(opts?.fetchImpl)
          return auth
        },
        fetchApiKey: async (_token, opts) => {
          seen.push(opts?.fetchImpl)
          return "sk-new"
        },
        saveApiKey: (next) => {
          saved = next
        },
      },
    })
    expect(result).toEqual({
      status: "refreshed",
      // Legacy ids ride along so a pre-rename config block is re-keyed too.
      providerIDs: [GATEWAY_PROVIDER.id, ...LEGACY_GATEWAY_PROVIDER_IDS],
      apiKey: "sk-new",
      baseUrl: "https://gw.test",
      auth,
    })
    expect(saved?.apiKey).toBe("sk-new")
    // The rest of the record survives: model and provider identity are what a
    // manually named provider is rewritten from.
    expect(saved?.model).toBe("m")
    // The host fetch reaches the check, the refresh, and the re-mint alike.
    expect(seen).toEqual([fetchImpl, fetchImpl, fetchImpl])
  })

  test("asks for a login when the session cannot re-mint", async () => {
    const result = await ensureGatewayKey({
      fns: { loadApiKey: () => creds, validateApiKey: async () => false, silentSso: async () => null },
    })
    expect(result).toEqual({ status: "needs-login", reason: "rejected" })
    const empty = await ensureGatewayKey({
      fns: {
        loadApiKey: () => creds,
        validateApiKey: async () => false,
        silentSso: async () => auth,
        fetchApiKey: async () => "",
      },
    })
    expect(empty).toEqual({ status: "needs-login", reason: "rejected" })
  })

  test("reports a missing key as such, not as a rejection", async () => {
    expect(await ensureGatewayKey({ fns: { loadApiKey: () => null } })).toEqual({
      status: "needs-login",
      reason: "no-key",
    })
  })

  test("falls back to the saved gateway url when the key records none", async () => {
    const urls: string[] = []
    const result = await ensureGatewayKey({
      fns: {
        loadApiKey: () => ({ apiKey: "sk-old" }),
        loadGatewayUrl: () => "https://saved.test",
        validateApiKey: async (_key, url) => {
          urls.push(url)
          return true
        },
        probeSession: async () => "live",
      },
    })
    expect(result).toEqual({ status: "ok" })
    expect(urls).toEqual(["https://saved.test"])
    const none = await ensureGatewayKey({
      fns: { loadApiKey: () => ({ apiKey: "sk-old" }), loadGatewayUrl: () => null },
    })
    expect(none).toEqual({ status: "needs-login", reason: "no-key" })
  })

  // An SSO-minted key (no base_url) lives only as long as the session that
  // minted it, even while the gateway still accepts it.
  describe("SSO session expiry", () => {
    const ssoCreds = { apiKey: "sk-sso", model: "m" }
    const base = { loadApiKey: () => ssoCreds, loadGatewayUrl: () => "https://saved.test" }

    test("a valid SSO key with a dead session needs a fresh sign-in", async () => {
      const result = await ensureGatewayKey({
        fns: { ...base, validateApiKey: async () => true, probeSession: async () => "dead" },
      })
      expect(result).toEqual({ status: "needs-login", reason: "expired" })
    })

    test("a live or unreachable session leaves a valid SSO key alone", async () => {
      for (const verdict of ["live", "unknown"] as const) {
        const result = await ensureGatewayKey({
          fns: { ...base, validateApiKey: async () => true, probeSession: async () => verdict },
        })
        expect(result).toEqual({ status: "ok" })
      }
      const thrown = await ensureGatewayKey({
        fns: {
          ...base,
          validateApiKey: async () => true,
          probeSession: async () => {
            throw new Error("network down")
          },
        },
      })
      expect(thrown).toEqual({ status: "ok" })
    })

    test("an unreachable gateway still enforces a dead session", async () => {
      const result = await ensureGatewayKey({
        fns: {
          ...base,
          validateApiKey: async () => {
            throw new Error("gateway down")
          },
          probeSession: async () => "dead",
        },
      })
      expect(result).toEqual({ status: "needs-login", reason: "expired" })
    })

    test("a rejected SSO key whose session is dead reads as expired, not rejected", async () => {
      const result = await ensureGatewayKey({
        fns: {
          ...base,
          validateApiKey: async () => false,
          silentSso: async () => null,
          probeSession: async () => "dead",
        },
      })
      expect(result).toEqual({ status: "needs-login", reason: "expired" })
      const unknown = await ensureGatewayKey({
        fns: {
          ...base,
          validateApiKey: async () => false,
          silentSso: async () => null,
          probeSession: async () => "unknown",
        },
      })
      expect(unknown).toEqual({ status: "needs-login", reason: "rejected" })
    })

    test("a manually entered key is never tied to the SSO session", async () => {
      let probed = false
      const probeSession = async () => {
        probed = true
        return "dead" as const
      }
      expect(
        await ensureGatewayKey({ fns: { loadApiKey: () => creds, validateApiKey: async () => true, probeSession } }),
      ).toEqual({ status: "ok" })
      expect(
        await ensureGatewayKey({
          fns: {
            loadApiKey: () => creds,
            validateApiKey: async () => false,
            silentSso: async () => null,
            probeSession,
          },
        }),
      ).toEqual({ status: "needs-login", reason: "rejected" })
      expect(probed).toBe(false)
    })
  })
})
