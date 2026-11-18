import { Effect, Option } from "effect"
import { runSkillSearch } from "@codev/skillhub"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"

export default Runtime.handler(
  Commands.commands.skill.commands.search,
  Effect.fn("cli.skill.search")(function* (input) {
    yield* requireCodevFlag("codev_skillhub")
    const code = yield* Effect.tryPromise({
      try: () => runSkillSearch({ query: input.query, limit: Option.getOrUndefined(input.limit), json: input.json }),
      catch: (cause) => cause,
    })
    yield* exitWith(code)
  }),
)
