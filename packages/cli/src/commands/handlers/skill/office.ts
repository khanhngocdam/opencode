import { Effect, Option } from "effect"
import { officeCrossFlagError, runSkillOffice } from "@codev/skillhub"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../../services/codev-flag"

export default Runtime.handler(
  Commands.commands.skill.commands.office,
  Effect.fn("cli.skill.office")(function* (input) {
    yield* requireCodevFlag("codev_skillhub")
    const args = {
      platform: Option.getOrUndefined(input.platform),
      arch: Option.getOrUndefined(input.arch),
      dir: Option.getOrUndefined(input.dir),
      targetUser: Option.getOrUndefined(input.targetUser),
      downloadOnly: input.downloadOnly,
      skipVerify: input.skipVerify,
      forceSkills: input.forceSkills,
      uninstall: input.uninstall,
      yes: input.yes,
      skillsOnly: input.skillsOnly,
      purgeDownloads: input.purgeDownloads,
    }
    const code = yield* Effect.tryPromise({
      try: () => runSkillOffice({ ...args, error: officeCrossFlagError(args) }),
      catch: (cause) => cause,
    })
    yield* exitWith(code)
  }),
)
