// Session model shared by the reader (db.ts) and renderer (render.ts). Ported
// from the hub's src/providers/types.ts, narrowed to the one agent this
// package exports — the render output must stay byte-identical to what the
// hub's codev-code provider produces for the same session.
export interface Message {
  role: "user" | "assistant"
  content: string
  timestamp?: string
  model?: string
}

export interface Session {
  id: string
  createdAt: Date
  updatedAt?: Date
  title?: string
  firstUserMessage?: string
  messages: Message[]
  /** Gateway base URL read from the CoDev-managed codev.json at export time. */
  baseUrl?: string
  /**
   * Aggregated character counts from descendant subagent sessions (normal
   * mode, where subagents carry parent_id and are folded into their parent).
   */
  subagentCharsIn?: number
  subagentCharsOut?: number
  /** Directory the session belongs to — decides its per-project export folder. */
  projectDir: string
}
