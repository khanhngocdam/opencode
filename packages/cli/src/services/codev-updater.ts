import { Effect, Layer } from "effect"
import { Updater } from "./updater"

const message = "Codev Code 2.0 preview updates are manual. Install a verified Codev2 artifact; upstream installers are not used."

// The upstream updater remains intact for future adaptation. The preview must
// never detect, upgrade or remove an existing OpenCode installation.
export const layer = Layer.succeed(Updater.Service, {
  run: () => Effect.succeed(undefined),
  check: () => Effect.succeed({ type: "unavailable" as const, message }),
  apply: () => Effect.fail(new Error(message)),
  method: () => Effect.succeed(undefined),
  managed: () => Effect.fail(new Error(message)),
  latest: () => Effect.fail(new Error(message)),
  upgrade: () => Effect.fail(new Error(message)),
  removal: () => undefined,
})

export * as CodevUpdater from "./codev-updater"
