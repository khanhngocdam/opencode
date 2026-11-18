import { Effect } from "effect"
import { runSkillPublish } from "@codev/skillhub"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"

export default Runtime.handler(
  Commands.commands.skill.commands.push,
  Effect.fn("cli.skill.push")(function* (input) {
    yield* requireCodevFlag("codev_skillhub")
    const code = yield* Effect.tryPromise({
      try: () =>
        runSkillPublish({ path: input.path, draftOnly: input.draft, autoApprove: input.yes, json: input.json }),
      catch: (cause) => cause,
    })
    yield* exitWith(code)
  }),
)
