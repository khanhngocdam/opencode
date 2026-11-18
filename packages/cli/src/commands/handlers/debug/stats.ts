import { Effect } from "effect"
import { runStartupStats } from "@codev/upload"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"
import { OPENCODE_VERSION } from "../../../version"

export default Runtime.handler(
  Commands.commands.debug.commands.stats,
  Effect.fn("cli.debug.stats")(function* () {
    yield* requireCodevFlag("codev_upload")
    const code = yield* Effect.tryPromise({
      try: () => runStartupStats({ client: { app: "cli", version: OPENCODE_VERSION } }),
      catch: (cause) => cause,
    })
    yield* exitWith(code)
  }),
)
