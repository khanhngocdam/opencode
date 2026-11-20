import { NodeServices } from "@effect/platform-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { afterEach, expect, spyOn, test } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CodevUpdater } from "../src/services/codev-updater"
import { Updater } from "../src/services/updater"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

// Builds the Codev updater against a fixture filesystem layout. `installed` places the running binary inside an npm
// global `codev2-code` package; otherwise it is the test runner itself, like a source checkout.
async function fixture(input: { installed: boolean; installName?: string }) {
  const root = mkdtempSync(path.join(tmpdir(), "codev2-updater-"))
  roots.push(root)
  const packageDirectory = path.join(root, "prefix", "node_modules", input.installName ?? "codev2-code")
  const executable = path.join(packageDirectory, "bin", "codev2.exe")
  const manifest = path.join(packageDirectory, "package.json")
  mkdirSync(path.dirname(executable), { recursive: true })
  writeFileSync(executable, "binary")
  writeFileSync(
    manifest,
    JSON.stringify({
      name: input.installName ?? "codev2-code",
      version: "2.3.0-2",
      bin: { codev2: "./bin/codev2.exe" },
    }),
  )
  const global = Global.make({
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    tmp: path.join(root, "tmp"),
    bin: path.join(root, "bin"),
    log: path.join(root, "log"),
    repos: path.join(root, "repos"),
  })
  const commands: string[][] = []
  const updater = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* Updater.Service.pipe(
        Effect.provide(CodevUpdater.layer),
        Effect.provide(
          LayerNode.compile(EffectFlock.node, {
            replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
          }),
        ),
        Effect.provideService(Global.Service, global),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          realPath: (target) =>
            input.installed && target === process.execPath ? Effect.succeed(executable) : fs.realPath(target),
        }),
        Effect.provideService(
          AppProcess.Service,
          AppProcess.Service.of({
            run: (command: Parameters<AppProcess.Interface["run"]>[0]) =>
              Effect.sync(() => {
                if (command._tag !== "StandardCommand") throw new Error("unexpected piped command")
                const args = command.args.map(String)
                commands.push([command.command, ...args])
                // A successful install replaces the package the running binary belongs to.
                const target = args.find((arg) => arg.startsWith("codev2-code@"))
                if (target)
                  writeFileSync(
                    manifest,
                    JSON.stringify({
                      name: "codev2-code",
                      version: target.slice("codev2-code@".length),
                      bin: { codev2: "./bin/codev2.exe" },
                    }),
                  )
                const stdout =
                  command.command === "npm" && args[0] === "config" ? "https://registry.example.test/\n" : ""
                return {
                  command: command.command,
                  exitCode: 0,
                  stdout: Buffer.from(stdout),
                  stderr: Buffer.alloc(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              }),
          } as unknown as AppProcess.Interface),
        ),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  return { updater, commands, root }
}

test("a source checkout or another package is never detected, updated, or removed", async () => {
  for (const setup of [
    await fixture({ installed: false }),
    await fixture({ installed: true, installName: "opencode-ai" }),
  ]) {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          method: yield* setup.updater.method(),
          check: yield* setup.updater.check(),
          run: yield* setup.updater.run(),
          apply: yield* setup.updater.apply("2.3.0-3").pipe(Effect.flip),
          removal: Updater.methods.map((method) => setup.updater.removal(method)),
        }
      }),
    )
    expect(result.method).toBeUndefined()
    expect(result.check).toEqual({ type: "unavailable", message: "Update with: npm i -g codev2-code@latest" })
    expect(result.run).toBeUndefined()
    expect(result.apply.message).toContain("npm i -g codev2-code@latest")
    expect(result.removal.every((item) => item === undefined)).toBe(true)
    expect(setup.commands.filter((command) => command.includes("install"))).toEqual([])
  }
})

test("an npm install of codev2-code upgrades only that package and verifies the new version", async () => {
  const setup = await fixture({ installed: true })
  const method = await Effect.runPromise(setup.updater.method())
  expect(method).toBe("npm")
  await Effect.runPromise(setup.updater.upgrade("npm", "2.3.0-3"))
  const install = setup.commands.find((command) => command.includes("install"))
  expect(install).toBeDefined()
  expect(install!.slice(-2)).toEqual(["--allow-scripts=codev2-code", "codev2-code@2.3.0-3"])
  expect(install!.join(" ")).not.toMatch(/opencode|codev-code@/)
})

test("upstream install methods cannot update codev2-code", async () => {
  const setup = await fixture({ installed: true })
  const error = await Effect.runPromise(setup.updater.upgrade("brew", "2.3.0-3").pipe(Effect.flip))
  expect(error.message).toContain("npm i -g codev2-code@latest")
})

test("latest reads the channel dist-tag of codev2-code from npm's own registry", async () => {
  const setup = await fixture({ installed: true })
  const requests: string[] = []
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        requests.push(input instanceof Request ? input.url : input.toString())
        return Response.json({ version: "2.3.0-7" })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    expect(await Effect.runPromise(setup.updater.latest())).toBe("2.3.0-7")
  } finally {
    request.mockRestore()
  }
  expect(requests).toEqual(["https://registry.example.test/codev2-code/local"])
})
