import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { requireCodevFlag } from "../../services/codev-flag"

export default Runtime.handler(
  Commands.commands.configure,
  Effect.fn("cli.configure")(function* (input) {
    yield* requireCodevFlag("codev_gateway")
    // The TUI reads CODEV_CONFIGURE at startup and opens the gateway setup flow instead of the home screen.
    process.env.CODEV_CONFIGURE = "1"
    const { default: tui } = yield* Effect.promise(() => import("./default"))
    return yield* tui({
      ...input,
      directory: Option.none(),
      continue: false,
      session: Option.none(),
      prompt: Option.none(),
    })
  }),
)
