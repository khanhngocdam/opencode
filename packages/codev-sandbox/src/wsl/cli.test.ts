import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { runWsl } from "./cli"

// A child that produces no output and never exits — the wedged-wsl.exe shape
// the timeout exists for.
const hangingSpawn = ((command: string, args: string[], opts: unknown) =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], opts as never)) as unknown as typeof spawn

test("kills and rejects a hung wsl.exe after the timeout", async () => {
  expect(runWsl(["--list", "--quiet"], { spawnImpl: hangingSpawn, timeoutMs: 250 })).rejects.toThrow(
    "timed out after 250ms",
  )
})

test("a fast exit clears the timeout and resolves normally", async () => {
  const echoSpawn = ((command: string, args: string[], opts: unknown) =>
    spawn(
      process.execPath,
      ["-e", "process.stdout.write('done'); process.exit(3)"],
      opts as never,
    )) as unknown as typeof spawn
  const result = await runWsl(["--version"], { spawnImpl: echoSpawn, timeoutMs: 5_000 })
  expect(result.code).toBe(3)
  expect(result.stdout).toBe("done")
})
