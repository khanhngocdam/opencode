import { describe, expect, test } from "bun:test"
import { codevFlagEnabled } from "../src/services/codev-flag"

describe("codevFlagEnabled", () => {
  test("is on by default in local builds", () => {
    expect(codevFlagEnabled("codev_skillhub", undefined)).toBe(true)
  })

  test("released Codev commands are on in release builds; unfinished ones stay off", () => {
    expect(codevFlagEnabled("codev_gateway", undefined, "latest")).toBe(true)
    expect(codevFlagEnabled("codev_skillhub", undefined, "latest")).toBe(true)
    expect(codevFlagEnabled("codev_upload", undefined, "latest")).toBe(true)
    expect(codevFlagEnabled("codev_sandbox", undefined, "latest")).toBe(false)
    expect(codevFlagEnabled("codev_migrate_v1", undefined, "latest")).toBe(false)
    expect(codevFlagEnabled("codev_upload", "-codev_upload", "latest")).toBe(false)
  })

  test("a leading dash turns the flag off", () => {
    expect(codevFlagEnabled("codev_skillhub", "-codev_skillhub")).toBe(false)
    expect(codevFlagEnabled("codev_upload", "-codev_skillhub")).toBe(true)
  })

  test("all enables flags but a specific entry wins", () => {
    expect(codevFlagEnabled("codev_gateway", "all")).toBe(true)
    expect(codevFlagEnabled("codev_gateway", "all,-codev_gateway")).toBe(false)
  })
})
