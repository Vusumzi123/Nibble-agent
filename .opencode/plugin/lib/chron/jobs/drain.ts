// Drain producer (docs/CHRON-SCHEDULER-PLAN.md §6.4).
//
// A chron code job fires on `drain.producer_interval_minutes` and asks the
// existing due-check whether a pass is warranted. It writes at most one
// `drain-pass` intent per due window; it never runs a pass itself. Detection
// stays deterministic — the consumer session does the LLM work.
//
// Loaded via relative import only.
import { join } from "node:path"
import { loadWorkQueueState, WORK_QUEUE_FILE } from "../../work-queue.ts"
import { drainDue } from "../../drain/step.ts"
import { DEFAULT_DRAIN, readDrainConfig } from "../../drain/config.ts"
import { writeIntent } from "../../production/intents.ts"
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

export type DrainScanDeps = {
  directory: string
  stateDir: string
  log: ChronLog
  /** Explicit opencode DB path (tests/E2E); defaults to the data dir. */
  dbFile?: string
  /** Intent spool leaf under `<state>` (`chron.inbox_dir`). */
  inboxDir?: string
  now?: () => number
  /** Test seam: replace the due check. */
  due?: () => Promise<{ due: boolean }>
}

export type DrainScanReport = {
  emitted: boolean
  reason: string
}

export async function runDrainScan(deps: DrainScanDeps): Promise<DrainScanReport> {
  const nowMs = deps.now?.() ?? Date.now()
  let enabled = true
  try {
    enabled = (await readDrainConfig(deps.directory)).enabled
  } catch {
    enabled = true
  }
  if (!enabled) return { emitted: false, reason: "disabled" }

  let due: boolean
  try {
    const check = deps.due
      ? await deps.due()
      : await drainDue({
          directory: deps.directory,
          stateDir: deps.stateDir,
          ...(deps.dbFile === undefined ? {} : { dbFile: deps.dbFile }),
          now: () => nowMs,
        })
    due = check.due
  } catch (err) {
    deps.log.warn("[drain] due check failed", err)
    return { emitted: false, reason: "due-check-failed" }
  }
  if (!due) return { emitted: false, reason: "not-due" }

  const queue = await loadWorkQueueState(join(deps.stateDir, WORK_QUEUE_FILE))
  if (queue.items.some((item) => item.id === "drain-pass")) {
    return { emitted: false, reason: "queued" }
  }

  const written = await writeIntent(
    deps.stateDir,
    "chron:drain",
    {
      id: "drain-pass",
      kind: "drain-pass",
      priority: 3,
      enqueued_ms: nowMs,
    },
    { inboxDir: deps.inboxDir },
  )
  if (!written.ok) {
    deps.log.warn(`[drain] intent write failed: ${written.reason}`)
    return { emitted: false, reason: "write-failed" }
  }
  return written.deduped
    ? { emitted: false, reason: "pending-intent" }
    : { emitted: true, reason: "emitted" }
}

/** Build a scan handler with the process-lifetime deps baked in. */
export function createDrainScan(deps: DrainScanDeps): () => Promise<DrainScanReport> {
  return () => runDrainScan(deps)
}
