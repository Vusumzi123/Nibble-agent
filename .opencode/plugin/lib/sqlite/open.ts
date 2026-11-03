// Runtime-adaptive read-write SQLite opener for the work store.
//
// opencode hosts plugins on Bun (`bun:sqlite`); `node --test` runs on Node 24
// (`node:sqlite`). The binding is imported lazily so a missing module cannot
// break a plugin's static imports.
//
// Loaded via relative import only.
export type SqliteRunResult = {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export type SqliteStatement = {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): SqliteRunResult
}

export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  close(): void
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

export async function openReadWriteDb(file: string): Promise<SqliteDatabase> {
  if (isBun()) {
    const spec = "bun:sqlite"
    const mod = (await import(spec)) as { Database: BunDatabaseCtor }
    return new mod.Database(file)
  }
  const mod = (await import("node:sqlite")) as { DatabaseSync: NodeDatabaseCtor }
  return new mod.DatabaseSync(file)
}

export type SqliteProbe =
  | { ok: true; backend: "bun" | "node" }
  | { ok: false; backend: "bun" | "node"; error: string }

/** Read-write startup probe: create, insert, read, and drop in a memory DB. */
export async function probeReadWriteSqlite(): Promise<SqliteProbe> {
  const backend = isBun() ? "bun" : "node"
  let db: SqliteDatabase | null = null
  try {
    db = await openReadWriteDb(":memory:")
    db.exec("CREATE TABLE probe (value INTEGER)")
    db.prepare("INSERT INTO probe (value) VALUES (?)").run(1)
    const row = db.prepare("SELECT value FROM probe").get() as { value?: number } | undefined
    if (row?.value !== 1) throw new Error("probe read returned no value")
    db.exec("DROP TABLE probe")
    return { ok: true, backend }
  } catch (err) {
    return {
      ok: false,
      backend,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}
