// Runtime-adaptive read-only SQLite opener (drain pipe + memory providers).
//
// opencode hosts plugins on Bun, where `node:sqlite` is not implemented; the
// `node --test` suite runs on Node 24, where it is. The backend is loaded
// lazily so a missing binding can never break a plugin's static imports
// (which would silently drop the whole hook — heartbeat, dream, memory).
//
// Only the read-only surface the drain queries need is exposed:
// `prepare(...).all()/.get()` and `close()`. Both backends provide it.
//
// Loaded via relative import only.

export type SqliteStatement = {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement
  close(): void
  /** Optional raw exec (PRAGMA statements cannot be bound). */
  exec?(sql: string): void
}

type BunDatabaseCtor = new (
  path: string,
  opts?: { readonly?: boolean },
) => SqliteDatabase

type NodeDatabaseCtor = new (
  path: string,
  opts?: { readOnly?: boolean },
) => SqliteDatabase

function isBun(): boolean {
  return typeof (process.versions as { bun?: string }).bun === "string"
}

/**
 * Open an existing SQLite file read-only. Throws (like both native openers)
 * when the file is missing or unreadable; callers degrade to the SDK lane.
 */
export async function openReadOnlyDb(file: string): Promise<SqliteDatabase> {
  let db: SqliteDatabase
  if (isBun()) {
    // Non-literal specifier: keeps `bun:sqlite` out of the Node type graph.
    const spec = "bun:sqlite"
    const mod = (await import(spec)) as { Database: BunDatabaseCtor }
    db = new mod.Database(file, { readonly: true })
  } else {
    const mod = (await import("node:sqlite")) as { DatabaseSync: NodeDatabaseCtor }
    db = new mod.DatabaseSync(file, { readOnly: true })
  }
  // A wedged writer must not hang the drain read indefinitely
  // (drain-consumer-plan §2.7): bounded wait on every statement.
  try {
    db.exec?.("PRAGMA busy_timeout=5000")
  } catch {
    /* pragma is best-effort — the backend may not expose exec */
  }
  return db
}
