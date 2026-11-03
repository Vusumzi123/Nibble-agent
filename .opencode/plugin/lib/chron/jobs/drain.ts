// Drain producer (docs/DRAIN-PRODUCER-PLAN.md).
//
// A fixed one-minute chron clock fires this scan. Every scan hot-reads
// `drain.producer_interval_minutes`, enforces it with a persisted cooldown, and
// asks the existing due-check whether a pass is warranted. It inserts at most
// one `drain-pass` row per interval; it never runs a pass itself. Detection
// stays deterministic — the consumer session does the LLM work.
//
// Loaded via relative import only.
import { join } from "node:path"
import { atomicRead, atomicWrite } from "../../fsx.ts"
import { drainDue } from "../../drain/step.ts"
import { DEFAULT_DRAIN, readDrainConfig, type DrainConfig } from "../../drain/config.ts"
import { readStorageConfig } from "../../storage-config.ts"
import { openWorkStore } from "../../work-store/sqlite.ts"
import type { EnqueueOutcome, WorkStore } from "../../work-store.ts"
import type { WorkItem } from "../../work-queue.ts"
import type { ChronLog } from "../types.ts"

export type DrainReason =
  | "emitted"
  | "disabled"
  | "config-error"
  | "cooldown"
  | "queued"
  | "pending-intent"
  | "unavailable"
  | "empty"
  | "below-trigger"
  | "write-failed"

/** Normalize the configured emission interval; invalid values use the default. */
export function normalizeIntervalMs(minutes: number): number {
  const n =
    Number.isFinite(minutes) && minutes >= 1
      ? Math.floor(minutes)
      : DEFAULT_DRAIN.producer_interval_minutes
  return n * 60_000
}

export type DrainDecisionInput = {
  now_ms: number
  interval_ms: number
  last_emitted_ms: number
  enabled: boolean
  queued: boolean
  intent_pending: boolean
  due: boolean
  pending: number | null
  oldest_age_ms: number | null
}

export type DrainDecision = {
  emit: boolean
  reason: DrainReason
}

/** Pure gate ordering (plan §4.2). The caller supplies the due-check result. */
export function decideDrainProduction(input: DrainDecisionInput): DrainDecision {
  if (!input.enabled) return { emit: false, reason: "disabled" }
  const cooling =
    input.last_emitted_ms > 0 && input.now_ms - input.last_emitted_ms < input.interval_ms
  if (cooling) return { emit: false, reason: "cooldown" }
  if (input.queued) return { emit: false, reason: "queued" }
  if (input.intent_pending) return { emit: false, reason: "pending-intent" }
  if (!input.due) {
    if (input.pending === null) return { emit: false, reason: "unavailable" }
    if (input.pending === 0) return { emit: false, reason: "empty" }
    return { emit: false, reason: "below-trigger" }
  }
  return { emit: true, reason: "emitted" }
}

export const DRAIN_PRODUCER_STATE_FILE = "drain-producer.json"

export type DrainProducerState = {
  version: 1
  last_emitted_ms: number
}

function emptyProducerState(): DrainProducerState {
  return { version: 1, last_emitted_ms: 0 }
}

/** Missing, corrupt, or unsupported state reads as empty; never throws. */
export async function readDrainProducerState(stateDir: string): Promise<DrainProducerState> {
  try {
    const raw = JSON.parse(
      await atomicRead(join(stateDir, DRAIN_PRODUCER_STATE_FILE)),
    ) as Partial<DrainProducerState> | null
    if (!raw || raw.version !== 1) return emptyProducerState()
    const time = raw.last_emitted_ms
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
      return emptyProducerState()
    }
    return { version: 1, last_emitted_ms: time }
  } catch {
    return emptyProducerState()
  }
}

/** Persist the producer state atomically; returns false on failure. */
export async function saveDrainProducerState(
  stateDir: string,
  state: DrainProducerState,
): Promise<boolean> {
  try {
    await atomicWrite(
      join(stateDir, DRAIN_PRODUCER_STATE_FILE),
      JSON.stringify(state, null, 2) + "\n",
    )
    return true
  } catch {
    return false
  }
}

/** A future timestamp is invalid (clock rollback or corruption); read it as 0. */
export function effectiveLastEmitted(
  last_emitted_ms: number,
  now_ms: number,
  _interval_ms: number,
): number {
  if (!Number.isFinite(last_emitted_ms) || last_emitted_ms < 0) return 0
  return last_emitted_ms > now_ms ? 0 : last_emitted_ms
}

export type DrainScanDeps = {
  directory: string
  stateDir: string
  log: ChronLog
  /** Explicit opencode DB path (tests/E2E); defaults to the data dir. */
  dbFile?: string
  /** Legacy intent spool leaf under `<state>`; the importer reads it once. */
  inboxDir?: string
  now?: () => number
  /** Test seam: replace the due check. */
  due?: () => Promise<{ due: boolean; pending: number | null; oldestAgeMs: number | null }>
  /** Test seams; production opens the configured store. */
  store?: WorkStore
  storeHas?: () => boolean
  enqueue?: (item: WorkItem) => EnqueueOutcome
  readConfig?: () => Promise<DrainConfig>
  readState?: () => Promise<DrainProducerState>
  saveState?: (state: DrainProducerState) => Promise<boolean>
}

export type DrainScanReport = {
  emitted: boolean
  reason: DrainReason
  pending: number | null
  oldest_age_ms: number | null
}

export async function runDrainScan(deps: DrainScanDeps): Promise<DrainScanReport> {
  const nowMs = deps.now?.() ?? Date.now()

  let cfg: DrainConfig
  try {
    cfg = await (deps.readConfig ?? (() => readDrainConfig(deps.directory)))()
  } catch (err) {
    deps.log.warn("[drain] config read failed", err)
    return { emitted: false, reason: "config-error", pending: null, oldest_age_ms: null }
  }
  if (!cfg.enabled) {
    return { emitted: false, reason: "disabled", pending: null, oldest_age_ms: null }
  }

  const readState = deps.readState ?? (() => readDrainProducerState(deps.stateDir))
  let state: DrainProducerState
  try {
    state = await readState()
  } catch (err) {
    deps.log.warn("[drain] producer state read failed", err)
    return { emitted: false, reason: "unavailable", pending: null, oldest_age_ms: null }
  }

  const intervalMs = normalizeIntervalMs(cfg.producer_interval_minutes)
  const lastEmitted = effectiveLastEmitted(state.last_emitted_ms, nowMs, intervalMs)
  if (lastEmitted === 0 && state.last_emitted_ms > nowMs) {
    deps.log.warn("[drain] producer state last_emitted_ms is in the future; resetting to 0")
    const saveState = deps.saveState ?? ((next) => saveDrainProducerState(deps.stateDir, next))
    const reset = await saveState({ version: 1, last_emitted_ms: 0 }).catch(() => false)
    if (!reset) deps.log.warn("[drain] producer state reset failed")
  }
  const cooling = lastEmitted > 0 && nowMs - lastEmitted < intervalMs

  let store = deps.store
  let ownStore = false
  if (!store) {
    const storage = await readStorageConfig(deps.directory)
    try {
      store = await openWorkStore({
        stateDir: deps.stateDir,
        path: storage.path,
        busyTimeoutMs: storage.busy_timeout_ms,
        synchronous: storage.synchronous,
        failedRetryMs: storage.failed_retry_ms,
        failedRetentionDays: storage.failed_retention_days,
        legacyInboxDir: deps.inboxDir ?? "inbox",
        now: deps.now,
      })
      ownStore = true
    } catch (err) {
      deps.log.warn("[drain] work store unavailable", err)
      return { emitted: false, reason: "unavailable", pending: null, oldest_age_ms: null }
    }
  }

  const present = (): boolean => (deps.storeHas ? deps.storeHas() : store!.has("drain-pass"))

  try {
    let queued = false
    if (!cooling) {
      try {
        queued = present()
      } catch (err) {
        deps.log.warn("[drain] queue read failed", err)
        return { emitted: false, reason: "unavailable", pending: null, oldest_age_ms: null }
      }
    }

    let intentPending = false
    if (!cooling && !queued) {
      try {
        intentPending = present()
      } catch (err) {
        deps.log.warn("[drain] intent check failed", err)
        return { emitted: false, reason: "unavailable", pending: null, oldest_age_ms: null }
      }
    }

    let due = false
    let pending: number | null = null
    let oldestAgeMs: number | null = null
    if (!cooling && !queued && !intentPending) {
      try {
        const check = deps.due
          ? await deps.due()
          : await drainDue({
              directory: deps.directory,
              stateDir: deps.stateDir,
              ...(deps.dbFile === undefined ? {} : { dbFile: deps.dbFile }),
              readConfig: async () => cfg,
              now: () => nowMs,
            })
        due = check.due
        pending = check.pending
        oldestAgeMs = check.oldestAgeMs
      } catch (err) {
        deps.log.warn("[drain] due check failed", err)
        return { emitted: false, reason: "unavailable", pending: null, oldest_age_ms: null }
      }
    }

    const decision = decideDrainProduction({
      now_ms: nowMs,
      interval_ms: intervalMs,
      last_emitted_ms: lastEmitted,
      enabled: cfg.enabled,
      queued,
      intent_pending: intentPending,
      due,
      pending,
      oldest_age_ms: oldestAgeMs,
    })
    if (!decision.emit) {
      return { emitted: false, reason: decision.reason, pending, oldest_age_ms: oldestAgeMs }
    }

    const item: WorkItem = {
      id: "drain-pass",
      kind: "drain-pass",
      producer: "chron:drain",
      priority: 3,
      enqueued_ms: nowMs,
      requeue_count: 0,
    }
    let outcome: EnqueueOutcome
    try {
      outcome = deps.enqueue ? deps.enqueue(item) : store!.enqueue([item], nowMs)
    } catch (err) {
      deps.log.warn("[drain] intent write failed", err)
      return { emitted: false, reason: "write-failed", pending, oldest_age_ms: oldestAgeMs }
    }
    if (outcome.duplicates.length > 0) {
      return { emitted: false, reason: "pending-intent", pending, oldest_age_ms: oldestAgeMs }
    }
    if (!outcome.accepted.includes("drain-pass")) {
      deps.log.warn("[drain] drain-pass was rejected (queue full)")
      return { emitted: false, reason: "write-failed", pending, oldest_age_ms: oldestAgeMs }
    }

    const saveState = deps.saveState ?? ((next) => saveDrainProducerState(deps.stateDir, next))
    const saved = await saveState({ version: 1, last_emitted_ms: nowMs }).catch(() => false)
    if (!saved) deps.log.warn("[drain] producer state save failed")
    return { emitted: true, reason: "emitted", pending, oldest_age_ms: oldestAgeMs }
  } finally {
    if (ownStore) store?.close()
  }
}

/** Build a scan handler with the process-lifetime deps baked in. */
export function createDrainScan(deps: DrainScanDeps): () => Promise<DrainScanReport> {
  return () => runDrainScan(deps)
}
