// Wire protocol between the TS provider and the codev-vmm Swift helper
// (native/vzhelper): a VmConfig JSON file in, newline-delimited JSON events
// out on stdout.

export type VzShare = {
  tag: string
  path: string
  readOnly: boolean
}

export type VzForward = {
  direction: "host-to-guest" | "guest-to-host"
  vsockPort: number
  socketPath: string
}

export type VzVmConfig = {
  kernel: string
  initrd: string
  disk: string
  cmdline: string
  cpus: number
  memoryMiB: number
  shares: VzShare[]
  forwards: VzForward[]
}

export type VzHelperEvent =
  | { event: "state"; state: "starting" | "running" | "stopped" }
  | { event: "error"; message: string }

const HELPER_STATES = new Set(["starting", "running", "stopped"])

export function parseVzHelperEvent(line: string): VzHelperEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return null
  const parsed = parseJsonObject(trimmed)
  if (!parsed) return null
  if (parsed.event === "state" && typeof parsed.state === "string" && HELPER_STATES.has(parsed.state)) {
    return { event: "state", state: parsed.state as "starting" | "running" | "stopped" }
  }
  if (parsed.event === "error" && typeof parsed.message === "string") {
    return { event: "error", message: parsed.message }
  }
  return null
}

// Line-buffers helper stdout: chunks may split or batch events arbitrarily.
export function createVzHelperEventReader(onEvent: (event: VzHelperEvent) => void) {
  let buffer = ""
  return (chunk: string | Uint8Array) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const event = parseVzHelperEvent(line)
      if (event) onEvent(event)
    }
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}
