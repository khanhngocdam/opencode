import { DatabaseSync } from "node:sqlite"
import type { SessionDb, SessionStatement } from "./sqlite"

// Node driver for the session reader (the desktop's Electron sidecar) — see
// sqlite.ts for the split. node:sqlite is what the server core's own node
// driver uses (packages/core sqlite.node.ts), so every runtime that can hold
// the session store can also read it here.
export function openSessionDb(path: string): SessionDb {
  const db = new DatabaseSync(path, { readOnly: true })
  return {
    prepare<R>(sql: string): SessionStatement<R> {
      const stmt = db.prepare(sql)
      return { all: (...args) => stmt.all(...args) as R[] }
    },
    close: () => db.close(),
  }
}

export type { SessionDb, SessionStatement } from "./sqlite"
