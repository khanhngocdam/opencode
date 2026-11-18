import { COMPACT_RESERVED, declaredInput, limitsFor, outputTokens } from "./model-limits"
import { GATEWAY_PROVIDER } from "./provider"

// v2 config uses `providers` + `package` + `settings` + `capabilities` (see
// @opencode/schema Config.Provider). Keep the same hub-attribution provider id.
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

type Capability = "text" | "image"

const MODEL_CAPABILITIES: {
  capabilities: { input: Capability[]; output: Capability[] }
} = {
  capabilities: {
    input: ["text", "image"],
    output: ["text"],
  },
}

/** Build an opencode.json fragment that registers the CoDev AI gateway. */
export function buildGatewayConfig(input: { apiKey?: string; baseUrl: string; model: string; models?: string[] }) {
  const ids = [...new Set([input.model, ...(input.models ?? [])])]
  return {
    compaction: {
      auto: true,
      buffer: COMPACT_RESERVED,
    },
    providers: {
      [GATEWAY_PROVIDER.id]: {
        package: PROVIDER_PACKAGE,
        name: GATEWAY_PROVIDER.name,
        settings: {
          baseURL: normalizeGatewayBaseUrl(input.baseUrl),
          ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        },
        models: Object.fromEntries(ids.map((id) => [id, modelEntry(id)])),
      },
    },
  }
}

function modelEntry(id: string) {
  const limits = limitsFor(id)
  return {
    name: id,
    ...MODEL_CAPABILITIES,
    limit: {
      context: limits.context,
      input: declaredInput(limits),
      output: outputTokens(limits),
    },
  }
}

/** Config fragment for a user-named custom OpenAI-compatible provider. */
export function buildCustomProviderConfig(input: {
  providerID: string
  name: string
  baseUrl: string
  models: string[]
}) {
  return {
    providers: {
      [input.providerID]: {
        package: PROVIDER_PACKAGE,
        name: input.name,
        settings: {
          baseURL: normalizeGatewayBaseUrl(input.baseUrl),
        },
        models: Object.fromEntries(input.models.map((id) => [id, modelEntry(id)])),
      },
    },
  }
}

/** Normalize a gateway origin to a single trailing `/v1`. */
export function normalizeGatewayBaseUrl(base: string): string {
  const stripped = base.replace(/\/$/, "")
  return /\/v1$/.test(stripped) ? stripped : `${stripped}/v1`
}
