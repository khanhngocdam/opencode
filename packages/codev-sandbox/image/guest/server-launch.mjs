// Boots the codev server inside the sandbox guest by calling Server.listen on
// the host-mounted bundle — the same entry the desktop sidecar uses
// (packages/desktop/src/main/sidecar.ts). The bundle's node.js is a library
// module, not a CLI, so there is no `serve` subcommand to run.
import { Server } from "/opt/codev/node.js"

const hostname = process.env.CODEV_SERVER_HOSTNAME ?? "127.0.0.1"
const port = Number(process.env.CODEV_SERVER_PORT ?? "4096")

const listener = await Server.listen({
  port,
  hostname,
  username: process.env.CODEV_SERVER_USERNAME ?? "codev",
  password: process.env.CODEV_SERVER_PASSWORD ?? "",
  cors: ["oc://renderer"],
})

process.on("SIGTERM", () => void listener.stop(true).then(() => process.exit(0)))
process.on("SIGINT", () => void listener.stop(true).then(() => process.exit(0)))
