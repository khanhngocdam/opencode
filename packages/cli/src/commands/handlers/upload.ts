import { EOL } from "node:os"
import { Effect } from "effect"
import { login, silentSso } from "@codev/gateway"
import { renderLastRun, runUpload } from "@codev/upload"
import { openUrl } from "@opencode/util/open"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { exitWith, requireCodevFlag } from "../../services/codev-flag"

export default Runtime.handler(
  Commands.commands.upload,
  Effect.fn("cli.upload")(function* (input) {
    yield* requireCodevFlag("codev_upload")
    if (input.logs) {
      process.stdout.write((renderLastRun("upload") ?? "No upload runs recorded yet.") + EOL)
      return
    }
    // Progress goes to stderr so --json keeps stdout machine-readable.
    const summary = yield* Effect.tryPromise({
      try: () =>
        runUpload({
          force: input.force,
          onStatus: (message) => process.stderr.write(message + EOL),
          getAuth: async () =>
            (await silentSso()) ??
            login({
              onLog: (message) => process.stderr.write(message + EOL),
              onReady: (openBrowser, authUrl) => {
                process.stderr.write(`Sign in to continue: ${authUrl}${EOL}`)
                openBrowser()
              },
              openUrl,
            }),
        }),
      catch: (cause) => cause,
    })
    process.stdout.write(
      (input.json
        ? JSON.stringify(summary)
        : `Uploaded ${summary.uploaded}/${summary.found} (skipped ${summary.skipped}, failed ${summary.failed})`) + EOL,
    )
    yield* exitWith(summary.failed > 0 ? 1 : 0)
  }),
)
