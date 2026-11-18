import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Updater } from "../src/services/updater"
import { CodevUpdater } from "../src/services/codev-updater"

test("preview cannot update or remove an upstream package", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const updater = yield* Updater.Service
      return {
        check: yield* updater.check(),
        run: yield* updater.run(),
        method: yield* updater.method(),
        removal: Updater.methods.map((method) => updater.removal(method)),
        apply: yield* updater.apply("2.3.1").pipe(Effect.flip),
        upgrade: yield* updater.upgrade("npm", "2.3.1").pipe(Effect.flip),
      }
    }).pipe(Effect.provide(CodevUpdater.layer)),
  )
  expect(result.check?.type).toBe("unavailable")
  expect(result.run).toBeUndefined()
  expect(result.method).toBeUndefined()
  expect(result.removal.every((item) => item === undefined)).toBe(true)
  expect(result.apply.message).toContain("manual")
  expect(result.upgrade.message).toContain("manual")
})
