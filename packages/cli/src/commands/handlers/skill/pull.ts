import { Effect, Option } from "effect"
import { parseAgentList, runSkillInstall } from "@codev/skillhub"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"

export default Runtime.handler(
  Commands.commands.skill.commands.pull,
  Effect.fn("cli.skill.pull")(function* (input) {
    yield* requireCodevFlag("codev_skillhub")
    const agents = Option.getOrUndefined(Option.map(input.agent, parseAgentList))
    if (typeof agents === "string") return yield* Effect.fail(new Error(agents))
    const code = yield* Effect.tryPromise({
      try: () =>
        runSkillInstall({
          target: input.target,
          dir: Option.getOrUndefined(input.dir),
          location: input.global ? "global" : "current",
          agents,
          force: input.force,
          json: input.json,
        }),
      catch: (cause) => cause,
    })
    yield* exitWith(code)
  }),
)
