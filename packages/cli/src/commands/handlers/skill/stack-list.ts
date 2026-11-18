import { Effect, Option } from "effect"
import { runStackList } from "@codev/skillhub"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"

export default Runtime.handler(
  Commands.commands.skill.commands.stack.commands.list,
  Effect.fn("cli.skill.stack.list")(function* (input) {
    yield* requireCodevFlag("codev_skillhub")
    const code = yield* Effect.tryPromise({
      try: () =>
        runStackList({
          query: Option.getOrUndefined(input.query),
          limit: Option.getOrUndefined(input.limit),
          json: input.json,
        }),
      catch: (cause) => cause,
    })
    yield* exitWith(code)
  }),
)
