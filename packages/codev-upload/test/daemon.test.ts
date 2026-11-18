import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { releaseLock, runStartupStats, tryAcquireLock } from "../src/daemon"
import { metricsDisabled, readLastStatsStatus } from "../src/nudge"
import { statsLockPath } from "../src/paths"
import { spawner, spawnStatsDaemon } from "../src/spawn"

let tempDir: string
let originalTestHome: string | undefined
let originalXdgData: string | undefined
let originalDisable: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codev-upload-daemon-"))
  originalTestHome = process.env.CODEV_TEST_HOME
  originalXdgData = process.env.XDG_DATA_HOME
  originalDisable = process.env.CODEV_DISABLE_METRICS
  process.env.CODEV_TEST_HOME = tempDir
  process.env.XDG_DATA_HOME = join(tempDir, "share")
  delete process.env.CODEV_DISABLE_METRICS
})

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.CODEV_TEST_HOME
  else process.env.CODEV_TEST_HOME = originalTestHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalDisable === undefined) delete process.env.CODEV_DISABLE_METRICS
  else process.env.CODEV_DISABLE_METRICS = originalDisable
  rmSync(tempDir, { recursive: true, force: true })
})

describe("metricsDisabled", () => {
  test("recognizes 1 and true, nothing else", () => {
    expect(metricsDisabled({ CODEV_DISABLE_METRICS: "1" })).toBe(true)
    expect(metricsDisabled({ CODEV_DISABLE_METRICS: "true" })).toBe(true)
    expect(metricsDisabled({ CODEV_DISABLE_METRICS: "0" })).toBe(false)
    expect(metricsDisabled({})).toBe(false)
  })
})

describe("stats lock", () => {
  test("second acquire fails while the first is held by a live process", () => {
    expect(tryAcquireLock()).toBe(true)
    expect(tryAcquireLock()).toBe(false)
    releaseLock()
    expect(tryAcquireLock()).toBe(true)
    releaseLock()
  })

  test("a stale lock (dead pid) is reclaimed", () => {
    mkdirSync(join(tempDir, "share", "codev"), { recursive: true })
    // A pid that cannot be alive plus an ancient start time — both staleness
    // conditions the reclaim path checks.
    writeFileSync(
      statsLockPath(),
      JSON.stringify({ pid: 999999999, startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
    )
    expect(tryAcquireLock()).toBe(true)
    releaseLock()
  })

  test("a fresh lock held by this (live) process is respected", () => {
    mkdirSync(join(tempDir, "share", "codev"), { recursive: true })
    writeFileSync(statsLockPath(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    expect(tryAcquireLock()).toBe(false)
    releaseLock()
  })
})

describe("runStartupStats gates", () => {
  test("opt-out env short-circuits to success", async () => {
    process.env.CODEV_DISABLE_METRICS = "1"
    expect(await runStartupStats({ client: { app: "cli", version: "test" } })).toBe(0)
  })

  test("signed out (no auth file) skips, recording the stall for the nudge", async () => {
    expect(await runStartupStats({ client: { app: "cli", version: "test" } })).toBe(0)
    // The skip is durable — this is what the TUI's sign-in toast keys off.
    expect(readLastStatsStatus()).toMatchObject({ ok: false, skipped: "not-logged-in" })
    // No lock left behind.
    expect(tryAcquireLock()).toBe(true)
    releaseLock()
  })
})

describe("spawnStatsDaemon", () => {
  const realSpawn = spawner.spawn

  afterEach(() => {
    spawner.spawn = realSpawn
  })

  test("does not spawn without an auth file, or when disabled", () => {
    const calls: unknown[][] = []
    spawner.spawn = ((...args: unknown[]) => {
      calls.push(args)
      return { unref() {}, pid: 1 } as never
    }) as typeof spawner.spawn

    spawnStatsDaemon()
    expect(calls).toHaveLength(0)

    mkdirSync(join(tempDir, ".codev"), { recursive: true })
    writeFileSync(join(tempDir, ".codev", "auth.json"), "{}")
    process.env.CODEV_DISABLE_METRICS = "1"
    spawnStatsDaemon()
    expect(calls).toHaveLength(0)
  })

  test("spawns a detached `debug stats` child with a trace parent", () => {
    mkdirSync(join(tempDir, ".codev"), { recursive: true })
    writeFileSync(join(tempDir, ".codev", "auth.json"), "{}")
    const calls: { args: string[]; options: Record<string, unknown> }[] = []
    let unrefed = false
    spawner.spawn = ((cmd: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ args: [cmd, ...args], options })
      return {
        unref() {
          unrefed = true
        },
        pid: 42,
      } as never
    }) as unknown as typeof spawner.spawn

    spawnStatsDaemon()
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0]).toBe(process.execPath)
    expect(calls[0].args.slice(-2)).toEqual(["debug", "stats"])
    expect(calls[0].options.detached).toBe(true)
    expect(calls[0].options.stdio).toEqual(["ignore", "ignore", "ignore"])
    expect((calls[0].options.env as Record<string, string>).CODEV_TRACE_PARENT).toMatch(/^[0-9a-f]{16}$/)
    expect(unrefed).toBe(true)
  })
})
