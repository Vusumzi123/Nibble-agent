// Read-only access to the opencode SQLite store (knowledge-pipeline-redesign
// §A.2/§A.3), plus the SDK fallback when the schema is not what we expect.
//
// The store is unsupported raw SQL, so every run is defensive:
//   - open with `{ readOnly: true }`, never write;
//   - check the tables/columns we depend on before querying;
//   - on any mismatch/failure, fall back to `client.session.*` and report a
//     degraded run.
//
// Discovery is project-scoped and parent-less. Fetch is text-only,
// non-synthetic, capped. Message ids are NOT time-ordered, so ordering is
// always `(time_created, id)`; the cursor is activity time.
//
// Loaded via relative import only.
import { homedir } from "node:os"
import { join } from "node:path"
import {
  AUTOMATION_SESSION_PREFIXES,
  AUTOMATION_SESSION_TITLES,
  isAutomationSessionTitle,
} from "./automation.ts"
import { openReadOnlyDb, type SqliteDatabase } from "./sqlite.ts"

export type DrainSession = {
  id: string
  directory: string
  /** Activity time (`session.time_updated`). */
  timeUpdated: number
}

export type DrainTurn = {
  id: string
  sessionID: string
  /** Activity time (`message.time_created`). */
  time: number
  role: string
  text: string
}

export type DrainDegraded = "schema-mismatch" | "sdk-fallback"

export type DrainSource = {
  kind: "sqlite" | "sdk"
  /** Root cause when the SQLite lane was not usable. */
  degraded?: DrainDegraded
  discover(lastTs: number, limit: number): Promise<DrainSession[]>
  fetch(sessionID: string, lastTs: number, limit: number): Promise<DrainTurn[]>
  unconsumedCount(lastTs: number): Promise<number>
  close(): Promise<void>
}

export type DrainSdkClient = {
  session: {
    list?(args: any): Promise<{ data?: any }>
    messages(args: any): Promise<{ data?: any }>
  }
}

export type DrainWarn = (message: string, err?: unknown) => void

export type MemoryHit = {
  session: string
  /** ISO timestamp of the turn. */
  time: string
  time_ms: number
  role: string
  excerpt: string
  score: number
}

export type MemorySearchOptions = {
  projectDir: string
  /** The drain cursor's activity time: only newer turns are searched. */
  cursorTs: number
  query: string
  topK: number
  since?: number
  session?: string
  tags?: string[]
  dbFile?: string
  onWarn?: DrainWarn
}

const MEMORY_TOP_K_CAP = 20
const MEMORY_EXCERPT_MAX = 320
const MEMORY_DISCOVER_LIMIT = 200
const MEMORY_TURNS_PER_SESSION = 400

export type OpenDrainSourceOptions = {
  projectDir: string
  /** Optional SDK client for the degraded fallback. */
  client?: DrainSdkClient
  /** Explicit DB path (tests); defaults to resolveDbFile(). */
  dbFile?: string
  home?: string
  env?: NodeJS.ProcessEnv
  onWarn?: DrainWarn
}

// The agent's own children are top-level sessions; excluding them by title is
// what keeps the drain from consuming its own transcripts and mission reports.
const AUTOMATION_TITLE_PARAMS = AUTOMATION_SESSION_TITLES.map(() => "?").join(", ")
const AUTOMATION_PREFIX_PARAMS = AUTOMATION_SESSION_PREFIXES.map(() => "title NOT LIKE ?").join(
  " AND ",
)
const AUTOMATION_PREFIX_PATTERNS = AUTOMATION_SESSION_PREFIXES.map((prefix) => `${prefix}%`)

const DISCOVER_SQL = `
  SELECT id, directory, time_updated
  FROM session
  WHERE parent_id IS NULL
    AND directory = ?
    AND time_updated > ?
    AND title NOT IN (${AUTOMATION_TITLE_PARAMS})
    AND ${AUTOMATION_PREFIX_PARAMS}
  ORDER BY time_updated ASC
  LIMIT ?`

const FETCH_SQL = `
  SELECT m.id, m.session_id, m.time_created,
         json_extract(m.data, '$.role') AS role,
         json_extract(p.data, '$.text') AS text
  FROM message m
  JOIN part p ON p.message_id = m.id
  WHERE m.session_id = ?
    AND m.time_created > ?
    AND json_extract(p.data, '$.type') = 'text'
    AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
    AND COALESCE(trim(json_extract(p.data, '$.text')), '') <> ''
  ORDER BY m.time_created, m.id
  LIMIT ?`

const COUNT_SQL = `
  SELECT count(*) AS n
  FROM message m
  JOIN part p ON p.message_id = m.id
  JOIN session s ON s.id = m.session_id
  WHERE s.parent_id IS NULL
    AND s.directory = ?
    AND m.time_created > ?
    AND s.title NOT IN (${AUTOMATION_TITLE_PARAMS})
    AND ${AUTOMATION_PREFIX_PARAMS.replaceAll("title NOT LIKE", "s.title NOT LIKE")}
    AND json_extract(p.data, '$.type') = 'text'
    AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
    AND COALESCE(trim(json_extract(p.data, '$.text')), '') <> ''`

export const FETCH_QUERY_PLAN_SQL = `EXPLAIN QUERY PLAN ${FETCH_SQL}`

/** Rows of the fetch query plan (tests assert the index is used). */
export function explainFetch(
  db: SqliteDatabase,
  sessionID: string,
  lastTs: number,
  limit: number,
): Array<Record<string, unknown>> {
  return db.prepare(FETCH_QUERY_PLAN_SQL).all(sessionID, lastTs, limit) as Array<
    Record<string, unknown>
  >
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  session: ["id", "parent_id", "directory", "time_updated", "title"],
  message: ["id", "session_id", "time_created", "data"],
  part: ["message_id", "data"],
}

/**
 * Resolve the opencode DB path.
 *   OPENCODE_DB          exact file
 *   OPENCODE_DATA_DIR    directory containing opencode.db
 *   XDG_DATA_HOME        <xdg>/opencode/opencode.db
 *   default              ~/.local/share/opencode/opencode.db
 */
export function resolveDbFile(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env
  if (env.OPENCODE_DB) return env.OPENCODE_DB
  if (env.OPENCODE_DATA_DIR) return join(env.OPENCODE_DATA_DIR, "opencode.db")
  const home = opts.home ?? homedir()
  const dataDir = env.XDG_DATA_HOME || join(home, ".local", "share")
  return join(dataDir, "opencode", "opencode.db")
}

/** Verify the tables/columns the fixed queries depend on. */
export function checkSchema(db: SqliteDatabase): { ok: true } | { ok: false; reason: string } {
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")

  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!hasTable.get(table)) return { ok: false, reason: `missing table ${table}` }
    // PRAGMA arguments cannot be bound; the table names are our own constants.
    const cols = db.prepare(`PRAGMA table_info(${table})`)
    const names = new Set(
      (cols.all() as Array<{ name?: unknown }>).map((row) => String(row.name ?? "")),
    )
    for (const column of required) {
      if (!names.has(column)) return { ok: false, reason: `missing column ${table}.${column}` }
    }
  }
  return { ok: true }
}

function turnFromRow(row: Record<string, unknown>): DrainTurn {
  return {
    id: String(row.id ?? ""),
    sessionID: String(row.session_id ?? ""),
    time: Number(row.time_created ?? 0),
    role: String(row.role ?? ""),
    text: typeof row.text === "string" ? row.text : "",
  }
}

function sqliteSource(db: SqliteDatabase, projectDir: string): DrainSource {
  const discover = db.prepare(DISCOVER_SQL)
  const fetch = db.prepare(FETCH_SQL)
  const count = db.prepare(COUNT_SQL)

  return {
    kind: "sqlite",
    async discover(lastTs, limit) {
      const rows = discover.all(
        projectDir,
        lastTs,
        ...AUTOMATION_SESSION_TITLES,
        ...AUTOMATION_PREFIX_PATTERNS,
        limit,
      ) as Array<Record<string, unknown>>
      return rows.map((row) => ({
        id: String(row.id ?? ""),
        directory: String(row.directory ?? ""),
        timeUpdated: Number(row.time_updated ?? 0),
      }))
    },
    async fetch(sessionID, lastTs, limit) {
      const rows = fetch.all(sessionID, lastTs, limit) as Array<Record<string, unknown>>
      return rows.map(turnFromRow)
    },
    async unconsumedCount(lastTs) {
      const row = count.get(
        projectDir,
        lastTs,
        ...AUTOMATION_SESSION_TITLES,
        ...AUTOMATION_PREFIX_PATTERNS,
      ) as
        | { n?: unknown }
        | undefined
      return Number(row?.n ?? 0)
    },
    async close() {
      db.close()
    },
  }
}

type SdkSession = {
  id?: unknown
  parentID?: unknown
  title?: unknown
  directory?: unknown
  time?: { updated?: unknown; created?: unknown }
}

type SdkMessageRow = {
  info?: {
    id?: unknown
    sessionID?: unknown
    role?: unknown
    time?: { created?: unknown }
  }
  parts?: Array<{ type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown }>
}

function sdkSource(
  client: DrainSdkClient,
  projectDir: string,
  degraded: DrainDegraded,
): DrainSource {
  const listSessions = async (): Promise<SdkSession[]> => {
    if (typeof client.session.list !== "function") {
      throw new Error("drain db: SDK client has no session.list")
    }
    const res = await client.session.list({ query: { directory: projectDir } })
    return Array.isArray(res?.data) ? (res.data as SdkSession[]) : []
  }

  const messages = async (sessionID: string): Promise<SdkMessageRow[]> => {
    const res = await client.session.messages({
      path: { id: sessionID },
      query: { directory: projectDir },
    })
    return Array.isArray(res?.data) ? (res.data as SdkMessageRow[]) : []
  }

  const discover = async (lastTs: number, limit: number): Promise<DrainSession[]> => {
    const rows = await listSessions()
    return rows
      .filter((s) => !s.parentID)
      .filter((s) => !isAutomationSessionTitle(s.title))
      .filter((s) => typeof s.directory !== "string" || s.directory === projectDir)
      .map((s) => ({
        id: String(s.id ?? ""),
        directory: typeof s.directory === "string" ? s.directory : projectDir,
        timeUpdated: Number(s.time?.updated ?? 0),
      }))
      .filter((s) => s.id !== "" && s.timeUpdated > lastTs)
      .sort((a, b) => a.timeUpdated - b.timeUpdated)
      .slice(0, limit)
  }

  const fetchTurns = async (
    sessionID: string,
    lastTs: number,
    limit: number,
  ): Promise<DrainTurn[]> => {
    const rows = await messages(sessionID)
    const turns: DrainTurn[] = []
    for (const row of rows) {
      const info = row.info ?? {}
      const time = Number(info.time?.created ?? 0)
      if (!(time > lastTs)) continue
      for (const part of row.parts ?? []) {
        if (part?.type !== "text" || part.synthetic || part.ignored) continue
        if (typeof part.text !== "string" || part.text.trim() === "") continue
        turns.push({
          id: String(info.id ?? ""),
          sessionID: String(info.sessionID ?? sessionID),
          time,
          role: String(info.role ?? ""),
          text: typeof part.text === "string" ? part.text : "",
        })
      }
    }
    return turns.sort((a, b) => a.time - b.time).slice(0, limit)
  }

  return {
    kind: "sdk",
    degraded,
    discover,
    fetch: fetchTurns,
    async unconsumedCount(lastTs) {
      const sessions = await discover(lastTs, 1000)
      let total = 0
      for (const session of sessions) {
        total += (await fetchTurns(session.id, lastTs, Number.MAX_SAFE_INTEGER)).length
      }
      return total
    },
    async close() {},
  }
}

/**
 * One-shot count for the heartbeat candidacy gate. Opens and closes the read
 * source; throws when the DB is unavailable and no SDK client was supplied.
 */
export async function countUnconsumed(opts: {
  projectDir: string
  lastTs: number
  dbFile?: string
  client?: DrainSdkClient
  home?: string
  env?: NodeJS.ProcessEnv
  onWarn?: DrainWarn
}): Promise<number> {
  const source = await openDrainSource({
    projectDir: opts.projectDir,
    client: opts.client,
    dbFile: opts.dbFile,
    home: opts.home,
    env: opts.env,
    onWarn: opts.onWarn,
  })
  try {
    return await source.unconsumedCount(opts.lastTs)
  } finally {
    await source.close().catch(() => {})
  }
}

function queryTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}/g) ?? []
  return [...new Set(tokens)]
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++
    index += needle.length
  }
  return count
}

/**
 * Read-only keyword search over the un-consolidated lane (the memory
 * explorer's `memory_search`). Only turns newer than the cursor are eligible,
 * so results disappear as the drain advances. Deterministic: no embeddings, no
 * model, no writes.
 */
export async function searchUnconsumed(opts: MemorySearchOptions): Promise<MemoryHit[]> {
  const lastTs = Math.max(opts.cursorTs, opts.since ?? 0)
  const topK = Math.max(0, Math.min(Math.floor(opts.topK), MEMORY_TOP_K_CAP))
  if (topK === 0) return []

  const terms = queryTerms(opts.query)
  const requiredTags = (opts.tags ?? []).map((tag) => tag.toLowerCase()).filter(Boolean)

  const source = await openDrainSource({
    projectDir: opts.projectDir,
    dbFile: opts.dbFile,
    onWarn: opts.onWarn,
  })
  try {
    const sessions = await source.discover(lastTs, MEMORY_DISCOVER_LIMIT)
    const selected = opts.session
      ? sessions.filter((session) => session.id === opts.session)
      : sessions

    const hits: MemoryHit[] = []
    const seen = new Set<string>()

    for (const session of selected) {
      const turns = await source.fetch(session.id, lastTs, MEMORY_TURNS_PER_SESSION)
      for (const turn of turns) {
        const text = turn.text.trim()
        if (!text) continue

        const lower = text.toLowerCase()
        if (requiredTags.some((tag) => !lower.includes(tag))) continue

        const score =
          terms.length === 0
            ? 0
            : terms.reduce((total, term) => total + countOccurrences(lower, term), 0)
        if (terms.length > 0 && score === 0) continue

        const excerpt = text.replace(/\s+/g, " ").slice(0, MEMORY_EXCERPT_MAX)
        const key = `${turn.sessionID}|${turn.time}|${excerpt}`
        if (seen.has(key)) continue
        seen.add(key)

        hits.push({
          session: turn.sessionID,
          time: new Date(turn.time).toISOString(),
          time_ms: turn.time,
          role: turn.role,
          excerpt,
          score,
        })
      }
    }

    return hits
      .sort((a, b) => b.score - a.score || b.time_ms - a.time_ms)
      .slice(0, topK)
  } finally {
    await source.close().catch(() => {})
  }
}

/**
 * Open the read source. Prefers SQLite; degrades to the SDK when the DB is
 * missing/unreadable or the schema does not match. Throws only when neither
 * lane is available.
 */
export async function openDrainSource(opts: OpenDrainSourceOptions): Promise<DrainSource> {
  const warn = opts.onWarn ?? (() => {})
  const dbFile = opts.dbFile ?? resolveDbFile({ home: opts.home, env: opts.env })

  let db: SqliteDatabase | null = null
  try {
    db = await openReadOnlyDb(dbFile)
  } catch (err) {
    warn(`drain db: cannot open ${dbFile}; falling back to the SDK`, err)
    if (!opts.client) throw new Error(`drain db unavailable at ${dbFile}`, { cause: err })
    return sdkSource(opts.client, opts.projectDir, "sdk-fallback")
  }

  const schema = checkSchema(db)
  if (!schema.ok) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    warn(`drain db: schema mismatch (${schema.reason}); falling back to the SDK`)
    if (!opts.client) throw new Error(`drain db schema mismatch: ${schema.reason}`)
    return sdkSource(opts.client, opts.projectDir, "schema-mismatch")
  }

  return sqliteSource(db, opts.projectDir)
}
