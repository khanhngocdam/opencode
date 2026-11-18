import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadApiKey } from "@codev/gateway"
import { parse as parseJsonc } from "jsonc-parser"

// Reads the gateway base URL back out of the CoDev-managed codev.json — the
// same source, candidate provider ids, and .jsonc-vs-.json resolution the
// hub's readAgentConfig("codev-code") uses, so both sides stamp the same
// base_url into the session comment.

function configPath(): string | null {
  const home = process.env.CODEV_TEST_HOME ?? homedir()
  const dir = join(home, ".config", "codev")
  const jsonc = join(dir, "codev.jsonc")
  if (existsSync(jsonc)) return jsonc
  const json = join(dir, "codev.json")
  if (existsSync(json)) return json
  return null
}

// Saved provider id first (a manually-named provider), then the built-in
// identities, then the pre-rename legacy ids (hub codevProviderIds parity).
function providerCandidates(): string[] {
  const ids = ["aigw", "netgate", "ai-gateway", "aigateway"]
  const saved = loadApiKey()?.providerId
  if (saved && !ids.includes(saved)) ids.unshift(saved)
  return ids
}

export function readCodevCodeBaseUrl(): string | undefined {
  const path = configPath()
  if (!path) return undefined
  try {
    const raw = parseJsonc(readFileSync(path, "utf-8")) as unknown
    if (!raw || typeof raw !== "object") return undefined
    const provider = (raw as Record<string, unknown>).provider
    if (!provider || typeof provider !== "object") return undefined
    for (const id of providerCandidates()) {
      const entry = (provider as Record<string, unknown>)[id]
      if (!entry || typeof entry !== "object") continue
      const options = (entry as Record<string, unknown>).options
      if (!options || typeof options !== "object") continue
      const baseURL = (options as Record<string, unknown>).baseURL
      if (typeof baseURL === "string" && baseURL) return baseURL
    }
    return undefined
  } catch {
    // A config we can't parse is a config we don't read a base URL from —
    // the export still proceeds, just without the base_url tag.
    return undefined
  }
}
