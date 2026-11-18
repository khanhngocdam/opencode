import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket } from "node:net"
import { GUEST_FORWARD_SCRIPT, forwardTcpToUnix } from "./bridge"

function listen(server: Server, target: string | number) {
  return new Promise<void>((resolve) => {
    if (typeof target === "string") server.listen(target, () => resolve())
    else server.listen(target, "127.0.0.1", () => resolve())
  })
}

function roundtrip(socket: Socket, message: string) {
  return new Promise<string>((resolve, reject) => {
    socket.on("data", (data) => {
      socket.end()
      resolve(String(data))
    })
    socket.on("error", reject)
    socket.write(message)
  })
}

function upperEcho(socket: Socket) {
  socket.on("data", (data) => socket.write(String(data).toUpperCase()))
}

test("forwards host tcp connections into a unix socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bridge-"))
  const socketPath = join(dir, "server.sock")
  const guest = createServer(upperEcho)
  await listen(guest, socketPath)

  const forwarder = await forwardTcpToUnix(socketPath)
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect(forwarder.port, "127.0.0.1", () => {
      roundtrip(socket, "ping").then(resolve, reject)
    })
  })
  expect(reply).toBe("PING")

  await forwarder.close()
  guest.close()
  await rm(dir, { recursive: true, force: true })
})

test("guest forward script bridges unix-to-tcp so the full server path works end-to-end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bridge-"))
  const socketPath = join(dir, "server.sock")
  const script = join(dir, "forward.mjs")
  await writeFile(script, GUEST_FORWARD_SCRIPT)

  // "Guest server": a TCP echo the script dials on 127.0.0.1, as the codev
  // server would be inside the namespace.
  const guestServer = createServer(upperEcho)
  await listen(guestServer, 0)
  const guestPort = (guestServer.address() as { port: number }).port

  const bridge = Bun.spawn([process.execPath, script, "unix-to-tcp", socketPath, String(guestPort)])
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const ready = await new Promise<boolean>((resolve) => {
      const probe = connect(socketPath, () => {
        probe.end()
        resolve(true)
      })
      probe.on("error", () => resolve(false))
    })
    if (ready) break
    await Bun.sleep(25)
  }

  // Full chain: host tcp -> forwarder -> unix socket -> guest script -> guest tcp.
  const forwarder = await forwardTcpToUnix(socketPath)
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect(forwarder.port, "127.0.0.1", () => {
      roundtrip(socket, "hello").then(resolve, reject)
    })
  })
  expect(reply).toBe("HELLO")

  await forwarder.close()
  bridge.kill()
  guestServer.close()
  await rm(dir, { recursive: true, force: true })
})

test("guest forward script bridges tcp-to-unix so the broker path works end-to-end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codev-bridge-"))
  const socketPath = join(dir, "broker.sock")
  const script = join(dir, "forward.mjs")
  await writeFile(script, GUEST_FORWARD_SCRIPT)

  // "Host broker": listens on the unix socket the guest script dials.
  const broker = createServer(upperEcho)
  await listen(broker, socketPath)

  // Find a free port for the script's guest-side TCP listener.
  const placeholder = createServer()
  await listen(placeholder, 0)
  const guestPort = (placeholder.address() as { port: number }).port
  await new Promise<void>((resolve) => placeholder.close(() => resolve()))

  const bridge = Bun.spawn([process.execPath, script, "tcp-to-unix", String(guestPort), socketPath])
  const until = Date.now() + 5000
  let reply = ""
  while (Date.now() < until) {
    const attempt = await new Promise<string | null>((resolve) => {
      const socket = connect(guestPort, "127.0.0.1", () => {
        roundtrip(socket, "broker").then(resolve, () => resolve(null))
      })
      socket.on("error", () => resolve(null))
    })
    if (attempt !== null) {
      reply = attempt
      break
    }
    await Bun.sleep(25)
  }
  expect(reply).toBe("BROKER")

  bridge.kill()
  broker.close()
  await rm(dir, { recursive: true, force: true })
})
