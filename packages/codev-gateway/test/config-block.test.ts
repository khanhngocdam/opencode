import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCustomProviderConfig, buildGatewayConfig, normalizeGatewayBaseUrl } from "../src/config-block"
import { resetModelLimitsCache } from "../src/model-limits"

let tempDir: string
let originalTestHome: string | undefined

// The config block resolves limits through limitsFor, whose remote tier reads
// the shared auth file — point it at an empty home so a hub-cached
// model_limits on the developer's machine can't leak into the expectations.
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-gateway-config-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  process.env.CODEV_TEST_HOME = tempDir
  resetModelLimitsCache()
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  if (originalTestHome !== undefined) process.env.CODEV_TEST_HOME = originalTestHome
  rmSync(tempDir, { recursive: true, force: true })
  resetModelLimitsCache()
})

describe("normalizeGatewayBaseUrl", () => {
  test("appends /v1 when missing", () => {
    expect(normalizeGatewayBaseUrl("https://gw.test")).toBe("https://gw.test/v1")
  })

  test("keeps an existing /v1 and strips a trailing slash", () => {
    expect(normalizeGatewayBaseUrl("https://gw.test/v1")).toBe("https://gw.test/v1")
    expect(normalizeGatewayBaseUrl("https://gw.test/v1/")).toBe("https://gw.test/v1")
    expect(normalizeGatewayBaseUrl("https://gw.test/")).toBe("https://gw.test/v1")
  })
})

const PACKAGE = "@opencode/ai/providers/openai-compatible"
const imageCapabilities: { input: ("text" | "image")[]; output: ("text" | "image")[] } = {
  input: ["text", "image"],
  output: ["text"],
}

describe("buildGatewayConfig", () => {
  test("matches the v2 provider config shape", () => {
    const config = buildGatewayConfig({
      baseUrl: "https://gw.test",
      model: "MiniMax/MiniMax-M2.7",
      models: ["MiniMax/MiniMax-M2.7", "other/model"],
    })
    expect(config).toEqual({
      compaction: { auto: true, buffer: 40000 },
      providers: {
        aigw: {
          package: PACKAGE,
          name: "AIGW",
          settings: { baseURL: "https://gw.test/v1" },
          models: {
            "MiniMax/MiniMax-M2.7": {
              name: "MiniMax/MiniMax-M2.7",
              capabilities: imageCapabilities,
              // Unknown id => the safe 200K default; input = trigger + buffer
              // (180000 + 40000) clamped to the 200000 window.
              limit: { context: 200000, input: 200000, output: 65536 },
            },
            "other/model": {
              name: "other/model",
              capabilities: imageCapabilities,
              limit: { context: 200000, input: 200000, output: 65536 },
            },
          },
        },
      },
    })
  })

  // The per-model table: the 262144-token window (capped by the deployment,
  // not the model). Its 90% trigger + the 40000 buffer exceeds the window,
  // so declaredInput's clamp pins input at the window itself.
  test("writes the table window for the known models", () => {
    for (const id of ["MiniMax/MiniMax-M3", "zai-org/GLM-5.3-Flash"]) {
      const config = buildGatewayConfig({ baseUrl: "https://gw.test", model: id })
      expect(config.providers.aigw.models[id].limit).toEqual({
        context: 262144,
        input: 262144,
        output: 65536,
      })
    }
  })

  // Without the declaration a custom-provider model resolves to text-only and
  // the session replaces an attached image with an error note (hub PR #219).
  test("declares image input so attachments are not stripped", () => {
    const models = buildGatewayConfig({ baseUrl: "https://gw.test", model: "m", models: ["m", "n"] }).providers.aigw
      .models
    for (const id of ["m", "n"]) {
      expect(models[id].capabilities).toEqual(imageCapabilities)
    }
  })

  test("falls back to a single-model map and dedupes the default", () => {
    const config = buildGatewayConfig({ baseUrl: "https://gw.test/v1", model: "m" })
    expect(Object.keys(config.providers.aigw.models)).toEqual(["m"])
    const withDupe = buildGatewayConfig({ baseUrl: "https://gw.test", model: "m", models: ["m", "n"] })
    expect(Object.keys(withDupe.providers.aigw.models)).toEqual(["m", "n"])
  })

  // A pinned default outranks the TUI's persisted selection on every startup,
  // so the chosen model is seeded into the recents by the configure flow
  // instead of written here.
  test("pins no top-level default model", () => {
    expect(buildGatewayConfig({ baseUrl: "https://gw.test", model: "m" })).not.toHaveProperty("model")
  })

  // The credential lives in the auth store; an inline key would outrank it and
  // re-expose the credential in the config file.
  test("writes no apiKey unless one is passed", () => {
    expect(buildGatewayConfig({ baseUrl: "https://gw.test", model: "m" }).providers.aigw.settings).not.toHaveProperty(
      "apiKey",
    )
  })

  // The sandbox guest config still inlines a key: the per-start broker
  // placeholder, since the guest has no auth store of its own.
  test("keeps an explicitly passed apiKey for the sandbox placeholder", () => {
    const settings = buildGatewayConfig({ apiKey: "broker-secret", baseUrl: "https://gw.test", model: "m" }).providers
      .aigw.settings
    expect(settings.apiKey).toBe("broker-secret")
  })
})

describe("buildCustomProviderConfig", () => {
  test("writes a keyless provider block under the given id", () => {
    const config = buildCustomProviderConfig({
      providerID: "mygateway",
      name: "My Gateway",
      baseUrl: "https://gw.test",
      models: ["m1", "m2"],
    })
    expect(config).toEqual({
      providers: {
        mygateway: {
          package: PACKAGE,
          name: "My Gateway",
          settings: { baseURL: "https://gw.test/v1" },
          models: {
            m1: {
              name: "m1",
              capabilities: imageCapabilities,
              limit: { context: 200000, input: 200000, output: 65536 },
            },
            m2: {
              name: "m2",
              capabilities: imageCapabilities,
              limit: { context: 200000, input: 200000, output: 65536 },
            },
          },
        },
      },
    })
    // The credential stays in the auth store; the block must never carry it.
    expect(config.providers.mygateway.settings).not.toHaveProperty("apiKey")
  })
})
