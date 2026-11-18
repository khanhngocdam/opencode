import { connect, type Socket } from "node:net"

// Reverse bridge for guests whose direct TCP dial to the host broker is
// severed — a managed Windows host firewall (GPO, endpoint agents) can drop
// guest-to-host traffic on the WSL vEthernet interface, and users on those
// machines cannot allow it. The opposite direction is the one WSL always
// provides: a guest loopback bind is republished on the Windows loopback,
// the same mechanism the sandbox's health check and UI traffic already ride,
// and Windows does not firewall loopback. So the host dials INTO the guest
// and keeps a pool of idle connections; the guest pairs each server
// connection with one, marks it live with a single claim byte, and bytes
// splice both ways from there. Each pooled connection carries exactly one
// stream — connection pairing, not multiplexing — so there is no framing
// protocol to get wrong.
const WSL_BRIDGE_CLAIM = 1

// Source of the guest-side pairing daemon, kept as text: the boot script
// writes it into the guest over the same stdin delivery the script itself
// uses, so no image change and no extra mount is needed — the image's node,
// which already runs the server launcher, runs this too.
// argv: <stub port> <rendezvous port>; both listeners bind the guest
// loopback. The stub port is where the guest config points the model
// provider, identical to what socat serves in direct mode.
export const WSL_GUEST_BRIDGE_SOURCE = `import { createServer } from "node:net"
const stubPort = Number(process.argv[2])
const rendezvousPort = Number(process.argv[3])
const idle = []
const waiting = []
const unlist = (list, socket) => {
  const index = list.indexOf(socket)
  if (index >= 0) list.splice(index, 1)
}
const pair = () => {
  while (idle.length && waiting.length) {
    const host = idle.shift()
    const server = waiting.shift()
    host.write(Buffer.from([${WSL_BRIDGE_CLAIM}]))
    server.pipe(host)
    host.pipe(server)
    const drop = () => {
      host.destroy()
      server.destroy()
    }
    host.on("close", drop)
    server.on("close", drop)
  }
}
// Explicitly paused until pair() pipes them: bytes that arrive between accept
// and pairing must wait in the kernel buffer, not race the pipe attachment.
createServer((socket) => {
  socket.pause()
  socket.on("error", () => {})
  socket.on("close", () => unlist(idle, socket))
  idle.push(socket)
  pair()
}).listen(rendezvousPort, "127.0.0.1")
createServer((socket) => {
  socket.pause()
  socket.on("error", () => {})
  socket.on("close", () => unlist(waiting, socket))
  waiting.push(socket)
  pair()
}).listen(stubPort, "127.0.0.1")
`

// Host half: keep poolSize idle connections dialed into the guest's
// rendezvous listener (via the Windows-loopback republish of the guest bind).
// A claim byte from the guest promotes a pooled connection into a live
// stream: everything after that byte is request data, spliced to a fresh
// local connection to the broker. Unclaimed drops (guest not up yet, listener
// gone) re-dial on a timer — a refused loopback dial is nearly free.
export function startWslReverseTunnel(options: {
  rendezvousPort: number
  brokerPort: number
  poolSize?: number
  retryMs?: number
}) {
  const poolSize = options.poolSize ?? 4
  const retryMs = options.retryMs ?? 1_000
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false
  let idle = 0

  const dial = () => {
    if (stopped || idle >= poolSize) return
    idle += 1
    const pooled = connect({ host: "127.0.0.1", port: options.rendezvousPort })
    sockets.add(pooled)
    // Idle pool members can sit for hours between model calls; keepalive is
    // what notices a silently vanished peer.
    pooled.setKeepAlive(true, 30_000)
    pooled.on("error", () => {})
    let claimed = false
    pooled.once("data", (chunk) => {
      claimed = true
      idle -= 1
      dial()
      const upstream = connect({ host: "127.0.0.1", port: options.brokerPort })
      sockets.add(upstream)
      upstream.on("error", () => {})
      // The claim byte is pairing control, not payload — and the guest may
      // have coalesced the first request bytes behind it.
      const payload = chunk.subarray(1)
      if (payload.length) upstream.write(payload)
      pooled.pipe(upstream)
      upstream.pipe(pooled)
      const drop = () => {
        pooled.destroy()
        upstream.destroy()
        sockets.delete(pooled)
        sockets.delete(upstream)
      }
      pooled.on("close", drop)
      upstream.on("close", drop)
    })
    pooled.on("close", () => {
      sockets.delete(pooled)
      if (claimed) return
      idle -= 1
      if (stopped) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        dial()
      }, retryMs)
      timers.add(timer)
    })
  }

  for (let index = 0; index < poolSize; index += 1) dial()
  return {
    stop() {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
    },
  }
}
