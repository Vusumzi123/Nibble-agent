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
import { readDrainConfig } from "../../drain/config.ts"
import { writeIntent } from "../../production/intents.ts"
import type { ChronLog } from "../types.ts"

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
