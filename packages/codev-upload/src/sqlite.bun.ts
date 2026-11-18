import { Database } from "bun:sqlite"
import type { SessionDb, SessionStatement } from "./sqlite"

// Bun driver for the session reader — see sqlite.ts for the split.
export function openSessionDb(path: string): SessionDb {
  const db = openReadable(path)
  return {
    prepare<R>(sql: string): SessionStatement<R> {
      const stmt = db.prepare(sql)
      return { all: (...args) => stmt.all(...args) as R[] }
    },
    close: () => db.close(),
  }
}

// A WAL store whose -shm file the reader cannot map read-only (the live
// agent holds it) fails the first statement with SQLITE_CANTOPEN. Fall back
// to a non-creating read-write handle — this module only ever reads.
function openReadable(path: string): Database {
  const db = new Database(path, { readonly: true })
  try {
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").all()
    return db
  } catch (err) {
    db.close()
    if ((err as { code?: string }).code !== "SQLITE_CANTOPEN") throw err
    return new Database(path, { readwrite: true, create: false })
  }
}

export type { SessionDb, SessionStatement } from "./sqlite"
