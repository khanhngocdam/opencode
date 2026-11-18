import { EOL } from "node:os"
import { Effect } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { requireCodevFlag } from "../../services/codev-flag"

// CodeGraph is an external MCP server, so enabling it is configuration rather than code. A later step can
// install the binary and write this entry; for now print the wiring so it is a one-line `mcp add`.
const message = [
  "CodeGraph is provided by an MCP server. To enable it in Codev2, run:",
  "",
  "  codev2 mcp add codegraph --global -- codegraph serve --mcp",
  "",
  "or add it to your codev2 config (see `codev2 debug paths config`):",
  "",
  '  { "mcp": { "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"] } } }',
  "",
  "Then run `codev2 reload`. Install the codegraph binary first and make sure it is on PATH.",
].join(EOL)

export default Runtime.handler(
  Commands.commands.codegraph,
  Effect.fn("cli.codegraph")(function* () {
    yield* requireCodevFlag("codev_skillhub")
    process.stdout.write(message + EOL)
  }),
)
