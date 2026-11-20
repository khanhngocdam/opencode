import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"
import { disableCodegraph } from "./shared"

export default Runtime.handler(
  Commands.commands.codegraph.commands.disable,
  Effect.fn("cli.codegraph.disable")(function* () {
    yield* requireCodevFlag("codev_skillhub")
    const code = yield* Effect.try({ try: () => disableCodegraph(), catch: (cause) => cause })
    yield* exitWith(code)
  }),
)
