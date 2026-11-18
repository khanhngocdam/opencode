import { connect, createServer } from "node:net"

// Host side of the server path: the desktop connects to 127.0.0.1:<port> and
// each connection is piped into the guest over a unix socket in the shared
// runtime dir. Unix sockets are filesystem objects, so they cross the guest's
// network namespace where TCP cannot.
export async function forwardTcpToUnix(socketPath: string) {
  const server = createServer((connection) => {
    const upstream = connect(socketPath)
    const drop = () => {
      connection.destroy()
      upstream.destroy()
    }
    connection.on("error", drop)
    upstream.on("error", drop)
    connection.pipe(upstream)
    upstream.pipe(connection)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("sandbox forwarder failed to bind")
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// Runs inside the guest with the image's node. `unix-to-tcp <socket> <port>`
// listens on a unix socket and dials guest-local TCP (server path);
// `tcp-to-unix <port> <socket>` listens on guest-local TCP and dials a unix
// socket (broker path).
export const GUEST_FORWARD_SCRIPT = `import { connect, createServer } from "node:net"
const [mode, from, to] = process.argv.slice(2)
const dial = mode === "unix-to-tcp" ? () => connect(Number(to), "127.0.0.1") : () => connect(to)
const server = createServer((connection) => {
  const upstream = dial()
  const drop = () => {
    connection.destroy()
    upstream.destroy()
  }
  connection.on("error", drop)
  upstream.on("error", drop)
  connection.pipe(upstream)
  upstream.pipe(connection)
})
if (mode === "unix-to-tcp") server.listen(from)
else server.listen(Number(from), "127.0.0.1")
`
