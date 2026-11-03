// SQLite work store contract (docs/SQLITE-WORK-STORE-PLAN.md).
//
// One runtime driver: `state/work.db`. Files stay the declarative input layer
// (missions, config, user-task briefs); producers insert `queued` rows through
// this API and the consumer owns every state transition.
//
// Loaded via relative import only.
import type { SchedulerState, WorkItem, WorkQueueState } from "./work-queue.ts"

export const WORK_DB_FILE = "work.db"
export const STORE_VERSION = 1
export const STORE_ATTEMPT_CAP = 3
export const LEASE_TTL_MS = 90_000
export const LEASE_REFRESH_MS = 30_000
export const DEFAULT_FAILED_RETRY_MS = 3_600_000
export const DEFAULT_FAILED_RETENTION_DAYS = 30

export type WorkState = "queued" | "running" | "failed"

export type StoredWorkItem = WorkItem & {
  state: WorkState
  attempts: number
  claimed_by: string | null
  claimed_ms: number | null
  failed_ms: number | null
  last_error: string | null
}

export type EnqueueOutcome = {
  accepted: string[]
  rejected: string[]
  duplicates: string[]
}

export type RecoverOutcome = {
  reset: string[]
  failed: string[]
}

export type LeaseRecord = {
  owner: string
  pid: number
  pid_start: string | null
  acquired_ms: number
  heartbeat_ms: number
}

export type LeaseHandle = {
  owner: string
  record: LeaseRecord
  held(): boolean
  refresh(nowMs?: number): boolean
  release(): void
}

export type WorkStore = {
  readonly file: string
  snapshot(): WorkQueueState
  enqueue(items: readonly WorkItem[], nowMs?: number): EnqueueOutcome
  claim(
    id: string,
    scheduler: SchedulerState,
    owner: string,
    nowMs?: number,
  ): StoredWorkItem | null
  settle(id: string, owner: string, requeue: WorkItem | null, nowMs?: number): boolean
  recover(owner: string, nowMs?: number): RecoverOutcome
  prune(nowMs?: number): number
  dropStale(ids: readonly string[]): number
  pruneFailed(olderThanMs?: number, nowMs?: number): number
  has(id: string): boolean
  dump(): WorkQueueState
  /** CLI rollback path: import a dumped queue without touching the marker. */
  restore(state: WorkQueueState, nowMs?: number): EnqueueOutcome
  leaseAcquire(owner: string, nowMs?: number, ttlMs?: number): LeaseRecord | null
  leaseRefresh(owner: string, nowMs?: number): boolean
  leaseRelease(owner: string): void
  leaseHolder(): LeaseRecord | null
  integrityCheck(): boolean
  close(): void
}

export type WorkStoreOptions = {
  stateDir: string
  /** DB leaf under `stateDir` (absolute paths are used as-is). */
  path?: string
  busyTimeoutMs?: number
  synchronous?: "NORMAL" | "FULL"
  failedRetryMs?: number
  failedRetentionDays?: number
  legacyQueueFile?: string
  legacyInboxDir?: string
  backupRoot?: string
  now?: () => number
}

export type StoreErrorCode =
  | "unavailable"
  | "lease-lost"
  | "busy"
  | "schema"
  | "integrity"
  | "closed"

export class StoreError extends Error {
  code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.name = "StoreError"
    this.code = code
  }
}
