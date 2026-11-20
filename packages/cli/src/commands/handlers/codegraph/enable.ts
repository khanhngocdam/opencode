import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"
import { enableCodegraph } from "./shared"

export default Runtime.handler(
  Commands.commands.codegraph.commands.enable,
  Effect.fn("cli.codegraph.enable")(function* (input) {
    yield* requireCodevFlag("codev_skillhub")
    const code = yield* Effect.tryPromise({ try: () => enableCodegraph({ yes: input.yes }), catch: (cause) => cause })
    yield* exitWith(code)
  }),
)
