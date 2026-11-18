// Minimal driver surface the session reader needs — implemented twice, picked
// by the package.json `imports` conditions (`#sqlite`): sqlite.bun.ts under
// Bun (the CLI binary), sqlite.node.ts everywhere else (the desktop's Electron
// sidecar). Same pattern as the server core's `#db` bun/node split, and the
// reason `bun:sqlite` must never be imported statically from shared code —
// bundlers targeting node cannot resolve it.
export interface SessionStatement<R> {
  all(...args: (string | number)[]): R[]
}

export interface SessionDb {
  prepare<R>(sql: string): SessionStatement<R>
  close(): void
}
