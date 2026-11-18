import { spawn } from "node:child_process"
import { createServer } from "node:net"

export type WslResult = {
  code: number | null
  stdout: string
  stderr: string
}

// wsl.exe writes its informational output (--version, --status, --list) as
// UTF-16LE with no BOM on most builds, while command output piped from inside a
// distro is plain UTF-8. Sniffing NUL bytes distinguishes them: a UTF-16LE run
// of ASCII always interleaves NULs, which valid UTF-8 text never contains.
export function decodeWslOutput(buffer: Buffer) {
  if (!buffer.includes(0)) return buffer.toString("utf8")
  return buffer.toString("utf16le").replace(/\0/g, "")
}

// wsl.exe produces no output and never exits when the LXSS service or a distro
// is wedged (a pending first-run prompt, a Windows update mid-flight), so every
// invocation is bounded. 20s covers slow cold starts; long jobs like --import
// pass their own ceiling.
const DEFAULT_WSL_TIMEOUT_MS = 20_000

export function runWsl(
  args: string[],
  opts?: { wslCommand?: string; env?: Record<string, string>; spawnImpl?: typeof spawn; timeoutMs?: number },
): Promise<WslResult> {
  const spawnImpl = opts?.spawnImpl ?? spawn
  const child = spawnImpl(opts?.wslCommand ?? "wsl.exe", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
  return new Promise((resolve, reject) => {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`wsl ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolve({
        code,
        stdout: decodeWslOutput(Buffer.concat(stdout)),
        stderr: decodeWslOutput(Buffer.concat(stderr)),
      })
    })
  })
}

// wsl.exe reports failures on stdout, not stderr — localized text, usually
// UTF-16LE, which decodeWslOutput has already normalized by the time a result
// reaches this. An error message built from stderr alone therefore reduces a
// real diagnostic ("Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/…")
// to a bare "exited 4294967295".
export function wslFailureDetail(result: WslResult) {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")
  return detail.length ? detail : `exited ${result.code}`
}

// `wsl --list --quiet` prints one distro per line; entries can carry a trailing
// CR and the default distro is not marked in --quiet mode.
export function parseDistroList(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// WSLENV is the only way to hand a variable to the distro without putting it on
// the command line, where another user on the host could read it out of the
// process table. The /u suffix means "host to WSL only".
export function wslEnvSpec(names: string[]) {
  return names.map((name) => `${name}/u`).join(":")
}

// The server binds inside the distro and WSL2's localhost forwarding republishes
// the same port on the Windows loopback, so host and guest must agree on one
// number. Reserving it on the host first is the only way to avoid collisions
// between concurrent sandboxes.
export function reserveLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not reserve a loopback port")))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}
