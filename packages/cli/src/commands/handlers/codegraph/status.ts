import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"
import { codegraphStatus } from "./shared"

export default Runtime.handler(
  Commands.commands.codegraph.commands.status,
  Effect.fn("cli.codegraph.status")(function* () {
    yield* requireCodevFlag("codev_skillhub")
    const code = yield* Effect.try({ try: () => codegraphStatus(), catch: (cause) => cause })
    yield* exitWith(code)
  }),
)
