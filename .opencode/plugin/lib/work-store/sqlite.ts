// SQLite implementation of the work store (docs/SQLITE-WORK-STORE-PLAN.md).
//
// WAL, short `BEGIN IMMEDIATE` transactions, and an owner-fenced lease. The
// store is synchronous once open; only opening (lazy binding load and the
// one-time legacy import) is async.
//
// Loaded via relative import only.
import { copyFile, mkdir, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { atomicRead } from "../fsx.ts"
import { holderDead, procStart } from "../file-lock.ts"
import { readIntents } from "../production/intents.ts"
import {
  MAX_QUEUE_DEPTH,
  KIND_ORDER,
  emptyScheduler,
  normalizeWeights,
  parseWorkQueueState,
  type SchedulerState,
  type WorkItem,
  type WorkKind,
  type WorkQueueState,
} from "../work-queue.ts"
import {
  LEASE_TTL_MS,
  STORE_ATTEMPT_CAP,
  STORE_VERSION,
  WORK_DB_FILE,
  StoreError,
  type EnqueueOutcome,
  type LeaseRecord,
  type RecoverOutcome,
  type StoredWorkItem,
  type WorkStore,
  type WorkStoreOptions,
  type WorkState,
} from "../work-store.ts"
import { openReadWriteDb, type SqliteDatabase } from "../sqlite/open.ts"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_items (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('mission','user-task','drain-pass','staleness','profile-update','soul-update')),
  producer       TEXT NOT NULL,
  enqueued_ms    INTEGER NOT NULL,
  priority       INTEGER CHECK (priority BETWEEN 0 AND 9),
  not_before_ms  INTEGER,
  expires_ms     INTEGER,
  requeue_count  INTEGER NOT NULL DEFAULT 0,
  requeue_reason TEXT,
  payload        TEXT,
  state          TEXT NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued','running','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  claimed_by     TEXT,
  claimed_ms     INTEGER,
  failed_ms      INTEGER,
  last_error     TEXT
);
CREATE INDEX IF NOT EXISTS work_due ON work_items(state, kind, not_before_ms, enqueued_ms);
CREATE INDEX IF NOT EXISTS work_expiry ON work_items(state, expires_ms);
CREATE TABLE IF NOT EXISTS scheduler_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  fair       INTEGER NOT NULL DEFAULT 1,
  weights    TEXT NOT NULL,
  credits    TEXT NOT NULL,
  served     TEXT NOT NULL,
  last_kind  TEXT,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lease (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  owner        TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  pid_start    TEXT,
  acquired_ms  INTEGER NOT NULL,
  heartbeat_ms INTEGER NOT NULL
);
`

const IMPORTER_MARKER = "legacy_import_v1"

const WORK_KINDS = new Set<string>(KIND_ORDER)

type Row = Record<string, unknown>

type InsertValues = {
  id: string
  kind: WorkKind
  producer: string
  enqueued_ms: number
  priority: number | null
  not_before_ms: number | null
  expires_ms: number | null
  requeue_count: number
  requeue_reason: string | null
  payload: string | null
  state: WorkState
  attempts: number
  claimed_by: string | null
  claimed_ms: number | null
  failed_ms: number | null
  last_error: string | null
}

function mapError(err: unknown): Error {
  if (err instanceof StoreError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (/database is locked|database table is locked|\bbusy\b/i.test(message)) {
    return new StoreError("busy", message)
  }
  return new StoreError("unavailable", message)
}

function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const out = fn()
    db.exec("COMMIT")
    return out
  } catch (err) {
    try {
      db.exec("ROLLBACK")
    } catch {
      /* the transaction may already be closed */
    }
    throw mapError(err)
  }
}

function changesOf(result: { changes: number | bigint }): number {
  return Number(result.changes)
}

function userVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as Row | undefined
  return Number(row?.user_version) || 0
}

function rowValue(row: Row | undefined, key: string): unknown {
  return row ? row[key] : undefined
}

function payloadOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value === "") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function normalizeItem(item: WorkItem): InsertValues {
  const priority =
    typeof item.priority === "number" &&
    Number.isInteger(item.priority) &&
    item.priority >= 0 &&
    item.priority <= 9
      ? item.priority
      : null
  return {
    id: item.id,
    kind: item.kind,
    producer: typeof item.producer === "string" && item.producer !== "" ? item.producer : "unknown",
    enqueued_ms:
      typeof item.enqueued_ms === "number" && Number.isFinite(item.enqueued_ms)
        ? item.enqueued_ms
        : Date.now(),
    priority,
    not_before_ms:
      typeof item.not_before_ms === "number" && Number.isFinite(item.not_before_ms)
        ? item.not_before_ms
        : null,
    expires_ms:
      typeof item.expires_ms === "number" && Number.isFinite(item.expires_ms)
        ? item.expires_ms
        : null,
    requeue_count:
      typeof item.requeue_count === "number" && Number.isFinite(item.requeue_count)
        ? Math.max(0, Math.floor(item.requeue_count))
        : 0,
    requeue_reason: typeof item.requeue_reason === "string" ? item.requeue_reason : null,
    payload:
      item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
        ? JSON.stringify(item.payload)
        : null,
    state: "queued",
    attempts: 0,
    claimed_by: null,
    claimed_ms: null,
    failed_ms: null,
    last_error: null,
  }
}

function insertValuesOf(
  values: InsertValues,
  overrides: Partial<InsertValues> = {},
): unknown[] {
  const v = { ...values, ...overrides }
  return [
    v.id,
    v.kind,
    v.producer,
    v.enqueued_ms,
    v.priority,
    v.not_before_ms,
    v.expires_ms,
    v.requeue_count,
    v.requeue_reason,
    v.payload,
    v.state,
    v.attempts,
    v.claimed_by,
    v.claimed_ms,
    v.failed_ms,
    v.last_error,
  ]
}

const INSERT_SQL = `
INSERT INTO work_items (
  id, kind, producer, enqueued_ms, priority, not_before_ms, expires_ms,
  requeue_count, requeue_reason, payload, state, attempts, claimed_by,
  claimed_ms, failed_ms, last_error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

function toStored(row: Row): StoredWorkItem {
  const payload = payloadOf(row.payload)
  const item: StoredWorkItem = {
    id: String(row.id),
    kind: row.kind as WorkKind,
    producer: String(row.producer),
    enqueued_ms: Number(row.enqueued_ms) || 0,
    requeue_count: Number(row.requeue_count) || 0,
    state: row.state as WorkState,
    attempts: Number(row.attempts) || 0,
    claimed_by: typeof row.claimed_by === "string" ? row.claimed_by : null,
    claimed_ms: typeof row.claimed_ms === "number" ? row.claimed_ms : null,
    failed_ms: typeof row.failed_ms === "number" ? row.failed_ms : null,
    last_error: typeof row.last_error === "string" ? row.last_error : null,
  }
  if (typeof row.priority === "number") item.priority = row.priority
  if (typeof row.not_before_ms === "number") item.not_before_ms = row.not_before_ms
  if (typeof row.expires_ms === "number") item.expires_ms = row.expires_ms
  if (typeof row.requeue_reason === "string") item.requeue_reason = row.requeue_reason
  if (payload !== undefined) item.payload = payload
  return item
}

function toWorkItem(row: Row): WorkItem {
  const stored = toStored(row)
  return {
    id: stored.id,
    kind: stored.kind,
    producer: stored.producer,
    enqueued_ms: stored.enqueued_ms,
    requeue_count: stored.requeue_count,
    ...(stored.priority === undefined ? {} : { priority: stored.priority }),
    ...(stored.not_before_ms === undefined ? {} : { not_before_ms: stored.not_before_ms }),
    ...(stored.expires_ms === undefined ? {} : { expires_ms: stored.expires_ms }),
    ...(stored.requeue_reason === undefined ? {} : { requeue_reason: stored.requeue_reason }),
    ...(stored.payload === undefined ? {} : { payload: stored.payload }),
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export type ResolvedStoreOptions = Required<
  Pick<
    WorkStoreOptions,
    | "stateDir"
    | "path"
    | "busyTimeoutMs"
    | "synchronous"
    | "failedRetryMs"
    | "failedRetentionDays"
    | "legacyQueueFile"
    | "legacyInboxDir"
    | "backupRoot"
  >
> & { now: () => number }

export function resolveStoreOptions(opts: WorkStoreOptions): ResolvedStoreOptions {
  const stateDir = opts.stateDir
  return {
    stateDir,
    path: opts.path ?? WORK_DB_FILE,
    busyTimeoutMs: opts.busyTimeoutMs ?? 5_000,
    synchronous: opts.synchronous === "FULL" ? "FULL" : "NORMAL",
    failedRetryMs: opts.failedRetryMs ?? 3_600_000,
    failedRetentionDays: opts.failedRetentionDays ?? 30,
    legacyQueueFile: opts.legacyQueueFile ?? join(stateDir, "work-queue.json"),
    legacyInboxDir: opts.legacyInboxDir ?? "inbox",
    backupRoot: opts.backupRoot ?? join(stateDir, "backup"),
    now: opts.now ?? Date.now,
  }
}

type LegacySnapshot = {
  queue: WorkQueueState
  intents: ReturnType<typeof toWorkItemFromIntent>[]
}

type IntentRecordLike = Awaited<ReturnType<typeof readIntents>>["intents"][number]

function toWorkItemFromIntent(record: IntentRecordLike): WorkItem {
  const intent = record.intent
  return {
    id: intent.id,
    kind: intent.kind,
    producer: intent.producer,
    enqueued_ms: intent.enqueued_ms,
    requeue_count: 0,
    ...(intent.priority === undefined ? {} : { priority: intent.priority }),
    ...(intent.expires_ms === undefined ? {} : { expires_ms: intent.expires_ms }),
    ...(intent.payload === undefined ? {} : { payload: intent.payload }),
  }
}

async function readLegacy(opts: ResolvedStoreOptions): Promise<LegacySnapshot> {
  const queue = parseWorkQueueState(await atomicRead(opts.legacyQueueFile))
  let records: IntentRecordLike[] = []
  const inboxDir = join(opts.stateDir, opts.legacyInboxDir)
  if (existsSync(inboxDir)) {
    try {
      records = (await readIntents(opts.stateDir, opts.legacyInboxDir)).intents
    } catch {
      records = []
    }
  }
  const seen = new Set(queue.items.map((item) => item.id))
  const intents: WorkItem[] = []
  const nowMs = opts.now()
  for (const record of records) {
    const intent = record.intent
    if (intent.expires_ms !== undefined && intent.expires_ms <= nowMs) continue
    if (seen.has(intent.id)) continue
    seen.add(intent.id)
    intents.push(toWorkItemFromIntent(record))
  }
  return { queue, intents }
}

async function backupLegacy(opts: ResolvedStoreOptions): Promise<void> {
  const queueExists = existsSync(opts.legacyQueueFile)
  const inboxDir = join(opts.stateDir, opts.legacyInboxDir)
  const inboxExists = existsSync(inboxDir)
  if (!queueExists && !inboxExists) return
  const stamp = new Date(opts.now()).toISOString().replace(/[:.]/g, "-")
  const backupDir = join(opts.backupRoot, `pre-sqlite-${stamp}`)
  try {
    await mkdir(backupDir, { recursive: true })
    if (queueExists) {
      await copyFile(opts.legacyQueueFile, join(backupDir, basename(opts.legacyQueueFile)))
    }
    if (inboxExists) {
      await rename(inboxDir, join(backupDir, basename(opts.legacyInboxDir)))
    }
  } catch {
    // The import already committed; an incomplete backup must not disable the
    // store. The originals stay in place when the move fails.
  }
}

export async function openWorkStore(opts: WorkStoreOptions): Promise<WorkStore> {
  const resolved = resolveStoreOptions(opts)
  const file = isAbsolute(resolved.path) ? resolved.path : join(resolved.stateDir, resolved.path)
  await mkdir(dirname(file), { recursive: true }).catch(() => {})

  let db: SqliteDatabase
  try {
    db = await openReadWriteDb(file)
  } catch (err) {
    throw mapError(err)
  }

  let closed = false
  const requireDb = (): SqliteDatabase => {
    if (closed) throw new StoreError("closed", "work store is closed")
    return db
  }

  const readScheduler = (): SchedulerState => {
    const row = requireDb().prepare("SELECT * FROM scheduler_state WHERE id = 1").get() as
      | Row
      | undefined
    if (!row) return emptyScheduler()
    const scheduler = emptyScheduler(normalizeWeights(parseRecord(row.weights)))
    const credits = parseRecord(row.credits)
    const served = parseRecord(row.served)
    for (const kind of KIND_ORDER) {
      const credit = credits[kind]
      if (typeof credit === "number" && Number.isFinite(credit)) scheduler.credits[kind] = credit
      const count = served[kind]
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        scheduler.served[kind] = Math.floor(count)
      }
    }
    if (typeof row.last_kind === "string" && WORK_KINDS.has(row.last_kind)) {
      scheduler.last_kind = row.last_kind as WorkKind
    }
    if (typeof row.updated_ms === "number" && Number.isFinite(row.updated_ms)) {
      scheduler.updated_ms = row.updated_ms
    }
    return scheduler
  }

  const writeScheduler = (scheduler: SchedulerState): void => {
    requireDb()
      .prepare(
        `INSERT INTO scheduler_state (id, fair, weights, credits, served, last_kind, updated_ms)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fair = excluded.fair,
           weights = excluded.weights,
           credits = excluded.credits,
           served = excluded.served,
           last_kind = excluded.last_kind,
           updated_ms = excluded.updated_ms`,
      )
      .run(
        scheduler.fair ? 1 : 0,
        JSON.stringify(scheduler.weights),
        JSON.stringify(scheduler.credits),
        JSON.stringify(scheduler.served),
        scheduler.last_kind,
        scheduler.updated_ms,
      )
  }

  const readLease = (): LeaseRecord | null => {
    const row = requireDb().prepare("SELECT * FROM lease WHERE id = 1").get() as Row | undefined
    if (!row) return null
    return {
      owner: String(row.owner),
      pid: Number(row.pid) || 0,
      pid_start: typeof row.pid_start === "string" ? row.pid_start : null,
      acquired_ms: Number(row.acquired_ms) || 0,
      heartbeat_ms: Number(row.heartbeat_ms) || 0,
    }
  }

  const leaseHeld = (owner: string, nowMs: number, ttlMs: number): boolean => {
    const lease = readLease()
    if (!lease || lease.owner !== owner) return false
    return nowMs - lease.heartbeat_ms < ttlMs
  }

  const store: WorkStore = {
    file,
    snapshot(): WorkQueueState {
      const rows = requireDb()
        .prepare("SELECT * FROM work_items WHERE state = 'queued' ORDER BY enqueued_ms ASC, id ASC")
        .all() as Row[]
      return { items: rows.map(toStored), scheduler: readScheduler() }
    },

    enqueue(items: readonly WorkItem[], nowMs?: number): EnqueueOutcome {
      const now = nowMs ?? resolved.now()
      return transaction(requireDb(), () => {
        const accepted: string[] = []
        const rejected: string[] = []
        const duplicates: string[] = []
        const countRow = requireDb()
          .prepare("SELECT COUNT(*) AS n FROM work_items WHERE state = 'queued'")
          .get() as Row | undefined
        let depth = Number(countRow?.n) || 0

        for (const item of items) {
          const values = normalizeItem(item)
          if (values.expires_ms !== null && values.expires_ms <= now) {
            rejected.push(values.id)
            continue
          }
          const existing = requireDb()
            .prepare("SELECT * FROM work_items WHERE id = ?")
            .get(values.id) as Row | undefined
          if (existing) {
            const failed = existing.state === "failed"
            const failedMs = typeof existing.failed_ms === "number" ? existing.failed_ms : null
            const retryable =
              failed &&
              failedMs !== null &&
              now - failedMs >= resolved.failedRetryMs &&
              values.enqueued_ms > (Number(existing.enqueued_ms) || 0)
            if (!retryable) {
              duplicates.push(values.id)
              continue
            }
            requireDb()
              .prepare(
                `UPDATE work_items SET
                   kind = ?, producer = ?, enqueued_ms = ?, priority = ?,
                   not_before_ms = ?, expires_ms = ?, requeue_count = 0,
                   requeue_reason = NULL, payload = ?, state = 'queued', attempts = 0,
                   claimed_by = NULL, claimed_ms = NULL, failed_ms = NULL, last_error = NULL
                 WHERE id = ? AND state = 'failed'`,
              )
              .run(
                values.kind,
                values.producer,
                values.enqueued_ms,
                values.priority,
                values.not_before_ms,
                values.expires_ms,
                values.payload,
                values.id,
              )
            accepted.push(values.id)
            continue
          }
          if (depth >= MAX_QUEUE_DEPTH) {
            rejected.push(values.id)
            continue
          }
          requireDb().prepare(INSERT_SQL).run(...insertValuesOf(values))
          depth += 1
          accepted.push(values.id)
        }
        return { accepted, rejected, duplicates }
      })
    },

    claim(
      id: string,
      scheduler: SchedulerState,
      owner: string,
      nowMs?: number,
    ): StoredWorkItem | null {
      const now = nowMs ?? resolved.now()
      return transaction(requireDb(), () => {
        if (!leaseHeld(owner, now, LEASE_TTL_MS)) {
          throw new StoreError("lease-lost", "work-store lease is not held by this owner")
        }
        const row = requireDb().prepare("SELECT * FROM work_items WHERE id = ?").get(id) as
          | Row
          | undefined
        if (!row || row.state !== "queued") return null
        const attempts = Number(row.attempts) || 0
        if (attempts >= STORE_ATTEMPT_CAP) {
          requireDb()
            .prepare(
              `UPDATE work_items SET state = 'failed', failed_ms = ?, last_error = ?
               WHERE id = ? AND state = 'queued'`,
            )
            .run(now, "attempt cap reached", id)
          return null
        }
        const updated = requireDb()
          .prepare(
            `UPDATE work_items SET state = 'running', attempts = attempts + 1,
               claimed_by = ?, claimed_ms = ?
             WHERE id = ? AND state = 'queued'`,
          )
          .run(owner, now, id)
        if (changesOf(updated) === 0) return null
        writeScheduler(scheduler)
        return toStored({ ...row, state: "running", attempts: attempts + 1, claimed_by: owner, claimed_ms: now })
      })
    },

    settle(id: string, owner: string, requeue: WorkItem | null, nowMs?: number): boolean {
      const now = nowMs ?? resolved.now()
      return transaction(requireDb(), () => {
        // A stale owner must see zero rows, not mutate the new owner's row.
        if (!leaseHeld(owner, now, LEASE_TTL_MS)) return false
        if (requeue) {
          const values = normalizeItem(requeue)
          const updated = requireDb()
            .prepare(
              `UPDATE work_items SET
                 producer = ?, enqueued_ms = ?, priority = ?, not_before_ms = ?,
                 expires_ms = ?, requeue_count = ?, requeue_reason = ?, payload = ?,
                 state = 'queued', claimed_by = NULL, claimed_ms = NULL
               WHERE id = ? AND state = 'running' AND claimed_by = ?`,
            )
            .run(
              values.producer,
              values.enqueued_ms,
              values.priority,
              values.not_before_ms,
              values.expires_ms,
              values.requeue_count,
              values.requeue_reason,
              values.payload,
              id,
              owner,
            )
          return changesOf(updated) > 0
        }
        const deleted = requireDb()
          .prepare("DELETE FROM work_items WHERE id = ? AND state = 'running' AND claimed_by = ?")
          .run(id, owner)
        return changesOf(deleted) > 0
      })
    },

    recover(owner: string, nowMs?: number): RecoverOutcome {
      const now = nowMs ?? resolved.now()
      return transaction(requireDb(), () => {
        if (!leaseHeld(owner, now, LEASE_TTL_MS)) {
          throw new StoreError("lease-lost", "work-store lease is not held by this owner")
        }
        const rows = requireDb()
          .prepare(
            `SELECT * FROM work_items
             WHERE state = 'running' AND (claimed_by IS NULL OR claimed_by <> ?)`,
          )
          .all(owner) as Row[]
        const reset: string[] = []
        const failed: string[] = []
        for (const row of rows) {
          const id = String(row.id)
          if ((Number(row.attempts) || 0) >= STORE_ATTEMPT_CAP) {
            requireDb()
              .prepare(
                `UPDATE work_items SET state = 'failed', failed_ms = ?, last_error = ?,
                   claimed_by = NULL, claimed_ms = NULL WHERE id = ?`,
              )
              .run(now, "attempt cap reached after recovery", id)
            failed.push(id)
          } else {
            requireDb()
              .prepare(
                `UPDATE work_items SET state = 'queued', claimed_by = NULL, claimed_ms = NULL
                 WHERE id = ?`,
              )
              .run(id)
            reset.push(id)
          }
        }
        return { reset, failed }
      })
    },

    prune(nowMs?: number): number {
      const now = nowMs ?? resolved.now()
      return transaction(requireDb(), () => {
        const result = requireDb()
          .prepare(
            "DELETE FROM work_items WHERE state = 'queued' AND expires_ms IS NOT NULL AND expires_ms <= ?",
          )
          .run(now)
        return changesOf(result)
      })
    },

    dropStale(ids: readonly string[]): number {
      if (ids.length === 0) return 0
      return transaction(requireDb(), () => {
        const placeholders = ids.map(() => "?").join(", ")
        const result = requireDb()
          .prepare(`DELETE FROM work_items WHERE state = 'queued' AND id IN (${placeholders})`)
          .run(...ids)
        return changesOf(result)
      })
    },

    pruneFailed(olderThanMs?: number, nowMs?: number): number {
      const now = nowMs ?? resolved.now()
      const retentionMs =
        olderThanMs ?? resolved.failedRetentionDays * 24 * 60 * 60_000
      return transaction(requireDb(), () => {
        const result = requireDb()
          .prepare(
            "DELETE FROM work_items WHERE state = 'failed' AND failed_ms IS NOT NULL AND failed_ms <= ?",
          )
          .run(now - retentionMs)
        return changesOf(result)
      })
    },

    has(id: string): boolean {
      const row = requireDb()
        .prepare(
          "SELECT 1 AS present FROM work_items WHERE id = ? AND state IN ('queued','running')",
        )
        .get(id) as Row | null | undefined
      return row != null
    },

    dump(): WorkQueueState {
      const rows = requireDb()
        .prepare(
          "SELECT * FROM work_items WHERE state IN ('queued','running') ORDER BY enqueued_ms ASC, id ASC",
        )
        .all() as Row[]
      return { items: rows.map(toWorkItem), scheduler: readScheduler() }
    },

    restore(state: WorkQueueState, nowMs?: number): EnqueueOutcome {
      const now = nowMs ?? resolved.now()
      return transaction(requireDb(), () => {
        const accepted: string[] = []
        const duplicates: string[] = []
        const insert = requireDb().prepare(INSERT_SQL)
        for (const item of state.items) {
          const values = normalizeItem(item)
          const existing = requireDb()
            .prepare("SELECT state FROM work_items WHERE id = ?")
            .get(values.id) as Row | undefined
          if (existing) {
            duplicates.push(values.id)
            continue
          }
          insert.run(...insertValuesOf(values))
          accepted.push(values.id)
        }
        writeScheduler(state.scheduler)
        return { accepted, rejected: [], duplicates }
      })
    },

    leaseAcquire(owner: string, nowMs?: number, ttlMs?: number): LeaseRecord | null {
      const now = nowMs ?? resolved.now()
      const ttl = Math.max(1_000, ttlMs ?? LEASE_TTL_MS)
      const pid = process.pid
      const start = procStart(pid)
      return transaction(requireDb(), () => {
        const current = readLease()
        if (current) {
          if (current.owner !== owner) {
            const expired = now - current.heartbeat_ms >= ttl
            if (!expired && !holderDead(current.pid, current.pid_start ?? undefined)) return null
          }
          requireDb()
            .prepare(
              `UPDATE lease SET owner = ?, pid = ?, pid_start = ?, acquired_ms = ?,
                 heartbeat_ms = ? WHERE id = 1`,
            )
            .run(owner, pid, start, current.owner === owner ? current.acquired_ms : now, now)
          return {
            owner,
            pid,
            pid_start: start,
            acquired_ms: current.owner === owner ? current.acquired_ms : now,
            heartbeat_ms: now,
          }
        }
        requireDb()
          .prepare(
            "INSERT INTO lease (id, owner, pid, pid_start, acquired_ms, heartbeat_ms) VALUES (1, ?, ?, ?, ?, ?)",
          )
          .run(owner, pid, start, now, now)
        return { owner, pid, pid_start: start, acquired_ms: now, heartbeat_ms: now }
      })
    },

    leaseRefresh(owner: string, nowMs?: number): boolean {
      const now = nowMs ?? resolved.now()
      return transaction(requireDb(), () => {
        const result = requireDb()
          .prepare("UPDATE lease SET heartbeat_ms = ? WHERE id = 1 AND owner = ?")
          .run(now, owner)
        return changesOf(result) > 0
      })
    },

    leaseRelease(owner: string): void {
      transaction(requireDb(), () => {
        requireDb().prepare("DELETE FROM lease WHERE id = 1 AND owner = ?").run(owner)
      })
    },

    leaseHolder(): LeaseRecord | null {
      return readLease()
    },

    integrityCheck(): boolean {
      const row = requireDb().prepare("PRAGMA integrity_check").get() as Row | undefined
      const value = row ? Object.values(row)[0] : undefined
      return String(value).toLowerCase() === "ok"
    },

    close(): void {
      if (closed) return
      closed = true
      db.close()
    },
  }

  try {
    db.exec(`PRAGMA journal_mode = WAL`)
    db.exec(`PRAGMA synchronous = ${resolved.synchronous}`)
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(resolved.busyTimeoutMs))}`)

    transaction(db, () => {
      const version = userVersion(db)
      if (version > STORE_VERSION) {
        throw new StoreError("schema", `unsupported work-store schema version ${version}`)
      }
      if (version === 0) {
        db.exec(SCHEMA)
        db.exec(`PRAGMA user_version = ${STORE_VERSION}`)
      }
    })

    const markerBefore = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(IMPORTER_MARKER) as Row | undefined
    const legacy = markerBefore ? null : await readLegacy(resolved)
    const imported = transaction(db, () => {
      const marker = db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(IMPORTER_MARKER) as Row | undefined
      if (marker || !legacy) return false
      const insert = db.prepare(INSERT_SQL)
      for (const item of [...legacy.queue.items, ...legacy.intents]) {
        insert.run(...insertValuesOf(normalizeItem(item)))
      }
      writeScheduler(legacy.queue.scheduler)
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        IMPORTER_MARKER,
        String(resolved.now()),
      )
      return true
    })
    if (imported) await backupLegacy(resolved)

    if (!store.integrityCheck()) {
      throw new StoreError("integrity", "work-store integrity_check failed")
    }
    return store
  } catch (err) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    throw mapError(err)
  }
}
