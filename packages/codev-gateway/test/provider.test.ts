import { describe, expect, test } from "bun:test"
import { CUSTOM_FALLBACK_PROVIDER, GATEWAY_PROVIDER, providerFromName, slugifyProviderName } from "../src/provider"

describe("identities", () => {
  test("match the hub's built-ins", () => {
    expect(GATEWAY_PROVIDER).toEqual({ id: "aigw", name: "AIGW" })
    expect(CUSTOM_FALLBACK_PROVIDER).toEqual({ id: "ai-gateway", name: "AI Gateway" })
  })
})

describe("slugifyProviderName", () => {
  test.each([
    ["Acme AI Gateway", "acme-ai-gateway"],
    ["My_Gateway 2.0", "my-gateway-2-0"],
    ["a//b", "a-b"],
    ["  spaced  out  ", "spaced-out"],
    ["!!!", ""],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(slugifyProviderName(input)).toBe(expected)
  })

  test("caps at 32 chars without a trailing dash", () => {
    // 32nd char of the raw slug lands on the dash after "aaaa...a" (31 a's).
    const slug = slugifyProviderName(`${"a".repeat(31)} ${"b".repeat(10)}`)
    expect(slug).toBe("a".repeat(31))
    expect(slug.length).toBeLessThanOrEqual(32)
    expect(slugifyProviderName("c".repeat(40))).toBe("c".repeat(32))
  })
})

describe("providerFromName", () => {
  test("slugs the id and keeps the trimmed name", () => {
    expect(providerFromName("  Acme AI Gateway ")).toEqual({ id: "acme-ai-gateway", name: "Acme AI Gateway" })
  })

  test("falls back when the name yields no usable id", () => {
    expect(providerFromName("")).toEqual(CUSTOM_FALLBACK_PROVIDER)
    expect(providerFromName("!!!")).toEqual(CUSTOM_FALLBACK_PROVIDER)
  })
})
