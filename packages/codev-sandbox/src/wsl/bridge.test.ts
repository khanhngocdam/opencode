import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { connect } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrokerServer } from "../broker"
import { startWslReverseTunnel, WSL_GUEST_BRIDGE_SOURCE } from "./bridge"
import { reserveLoopbackPort } from "./cli"

// The boot script ships the daemon inside a <<'CODEV_BRIDGE_EOF' heredoc; the
// source containing that delimiter would truncate itself in transit.
test("the guest bridge source cannot collide with its heredoc delivery", () => {
  expect(WSL_GUEST_BRIDGE_SOURCE).not.toContain("CODEV_BRIDGE_EOF")
})

// The whole reverse path, with real sockets in every role: the guest daemon
// as a child process, the host pool dialing into its rendezvous listener, and
// requests entering the stub as raw bytes the way the guest server's HTTP
// client would send them. Concurrent requests exercise pairing and pool
// replenishment. Raw sockets rather than fetch: bun's fetch pool has its own
// concurrency behavior, and this test is about the bridge carrying bytes.
test("the reverse bridge carries brokered requests end to end", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: async (request) =>
      Response.json({ echo: await request.text(), authorization: request.headers.get("authorization") }),
  })
  const broker = createBrokerServer({
    routes: [
      { prefix: "/llm", upstream: `http://127.0.0.1:${upstream.port}`, headers: { authorization: "Bearer real" } },
    ],
  })
  const brokerPort = await broker.listen()

  const dir = await mkdtemp(join(tmpdir(), "wsl-bridge-"))
  const daemon = join(dir, "bridge.mjs")
  await writeFile(daemon, WSL_GUEST_BRIDGE_SOURCE)
  const stubPort = await reserveLoopbackPort()
  const rendezvousPort = await reserveLoopbackPort()
  const guest = spawn(process.execPath, [daemon, String(stubPort), String(rendezvousPort)], {
    stdio: ["ignore", "ignore", "inherit"],
  })
  const tunnel = startWslReverseTunnel({ rendezvousPort, brokerPort, retryMs: 50 })

  const viaStub = async (marker: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const reply = await new Promise<string | null>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port: stubPort })
        let data = ""
        socket.on("data", (chunk) => {
          data = `${data}${chunk}`
        })
        // write, never end: a FIN would read as connection close to the
        // daemon's paired sockets and tear the chain down before the response.
        // connection: close makes the broker close the chain after answering,
        // which surfaces here as 'close' with the response buffered.
        socket.write(
          `POST /llm/${marker} HTTP/1.1\r\nhost: stub\r\nauthorization: Bearer sandbox-broker\r\ncontent-length: ${marker.length}\r\nconnection: close\r\n\r\n${marker}`,
        )
        socket.setTimeout(2_000, () => socket.destroy())
        socket.on("error", () => {})
        socket.on("close", () => resolve(data.length ? data : null))
      })
      if (reply) return reply
      await Bun.sleep(50)
    }
    throw new Error("the stub listener never answered")
  }
  const replies = await Promise.all(["a", "b", "c"].map(viaStub))
  for (const [index, marker] of ["a", "b", "c"].entries()) {
    expect(replies[index]).toStartWith("HTTP/1.1 200")
    expect(replies[index]).toContain(`"echo":"${marker}"`)
    // The broker swapped the guest's placeholder credential for the real one.
    expect(replies[index]).toContain(`"authorization":"Bearer real"`)
  }

  tunnel.stop()
  guest.kill()
  await broker.close()
  upstream.stop(true)
  await rm(dir, { recursive: true, force: true })
}, 15_000)
