// One drain step, executed by the single heartbeat loop (deconcurrency plan,
// Phase 1). There is no consumer loop and no `drain.lock`: the loop runs one
// work unit at a time, so the drain pass is already serialized against every
// mission and dream by construction.
//
// The step keeps the consumer's *decision* half — config rollback, cursor
// backoff, the pending/age trigger, and a per-step ceiling — and drops the
// *scheduling* half (timer, wake loop, drain.current marker, ledger rows for
// lock-held/crash wakes). Scheduling belongs to the loop; this module never
// schedules, never locks, and never sleeps.
//
// Loaded via relative import only.
import { readDrainConfig, type DrainConfig } from "./config.ts"
import { blockedBackoffActive, loadCursor, resolveCursorFile } from "./cursor.ts"
import { countUnconsumed, oldestPendingAge } from "./db.ts"
import type { DrainLedger } from "./ledger.ts"
import { runDrainPipe, type DrainPipeClient, type DrainPipeResult } from "./pipe.ts"
import { effectiveCursorLastTs } from "./status.ts"
import type { MemoryProvider } from "../memory/types.ts"

export type DrainStepDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  client: DrainPipeClient
  waitForIdle: (sessionID: string) => Promise<boolean>
  registerChild?: (sessionID: string) => void
  dbFile?: string
  ledger?: DrainLedger
  onWarn?: (message: string, err?: unknown) => void
  /** Fresh provider every step — a provider flip applies without a restart. */
  resolveProvider: () => Promise<MemoryProvider | undefined>
  /** Test seams. Production never carries them. */
  readConfig?: () => Promise<DrainConfig>
  now?: () => number
}

export type DrainStepResult =
  | { ran: false; reason: "disabled" | "backoff" | "below-trigger" | "no-provider" | "config-error" }
  | { ran: true; result: DrainPipeResult; pendingBefore: number | null; pendingAfter: number | null }

type TriggerState = { pending: number | null; oldestAgeMs: number | null }

function triggered(state: TriggerState, cfg: DrainConfig): boolean {
  if (state.pending === null) return false
  if (state.pending >= cfg.trigger_pending) return true
  return state.oldestAgeMs !== null && state.oldestAgeMs >= cfg.trigger_max_age_hours * 3_600_000
}

/**
 * Decide whether drain is due. Cheap: two indexed counts on the local store,
 * no LLM, no session. The loop calls this every wake so a config flip or a
 * growing backlog applies without a restart.
 */
export async function drainDue(deps: {
  directory: string
  stateDir: string
  dbFile?: string
  readConfig?: () => Promise<DrainConfig>
  now?: () => number
}): Promise<{ due: boolean; pending: number | null; oldestAgeMs: number | null }> {
  const now = deps.now ?? Date.now
  const readConfig = deps.readConfig ?? (() => readDrainConfig(deps.directory))
  let cfg: DrainConfig
  try {
    cfg = await readConfig()
  } catch {
    return { due: false, pending: null, oldestAgeMs: null }
  }
  if (!cfg.enabled) return { due: false, pending: null, oldestAgeMs: null }

  try {
    const cursor = await loadCursor(resolveCursorFile(deps.stateDir, cfg.cursor_file))
    if (blockedBackoffActive(cursor, now())) return { due: false, pending: null, oldestAgeMs: null }
  } catch {
    /* cursor is total; proceed */
  }

  try {
    const { lastTs, marks } = await effectiveCursorLastTs(deps.stateDir, cfg, now())
    const common = {
      projectDir: deps.directory,
      lastTs,
      marks,
      ...(deps.dbFile === undefined ? {} : { dbFile: deps.dbFile }),
      excludeMissions: cfg.exclude_missions,
    }
    const pending = await countUnconsumed(common)
    if (pending === 0) return { due: false, pending, oldestAgeMs: null }
    const { ageMs } = await oldestPendingAge({ ...common, now: now() })
    const state = { pending, oldestAgeMs: ageMs }
    return { due: triggered(state, cfg), pending, oldestAgeMs: ageMs }
  } catch {
    return { due: false, pending: null, oldestAgeMs: null }
  }
}

/**
 * Run exactly one drain pass. Returns `ran: false` with a reason when the
 * preconditions no longer hold (the loop re-checks them anyway). Never
 * schedules, never locks, never throws.
 */
export async function runDrainStep(deps: DrainStepDeps): Promise<DrainStepResult> {
  const now = deps.now ?? Date.now
  const readConfig = deps.readConfig ?? (() => readDrainConfig(deps.directory))

  let cfg: DrainConfig
  try {
    cfg = await readConfig()
  } catch (err) {
    deps.onWarn?.("drain step: config read failed", err)
    return { ran: false, reason: "config-error" }
  }
  if (!cfg.enabled) return { ran: false, reason: "disabled" }

  try {
    const cursor = await loadCursor(resolveCursorFile(deps.stateDir, cfg.cursor_file))
    if (blockedBackoffActive(cursor, now())) return { ran: false, reason: "backoff" }
  } catch {
    /* cursor is total; proceed */
  }

  const due = await drainDue({ ...deps, readConfig: async () => cfg, now })
  if (!due.due) return { ran: false, reason: "below-trigger" }

  const provider = await deps.resolveProvider().catch((err) => {
    deps.onWarn?.("drain step: provider resolve failed", err)
    return undefined
  })
  if (!provider?.consolidate) return { ran: false, reason: "no-provider" }

  const startedAt = now()
  const result = await runDrainPipe({
    directory: deps.directory,
    stateDir: deps.stateDir,
    vaultDir: deps.vaultDir,
    config: cfg,
    client: deps.client,
    provider,
    waitForIdle: deps.waitForIdle,
    registerChild: deps.registerChild,
    ...(deps.dbFile === undefined ? {} : { dbFile: deps.dbFile }),
    ...(deps.ledger ? { ledger: deps.ledger } : {}),
    trigger: "tick",
    pass: 0,
    onWarn: deps.onWarn,
  })

  // One ledger line per step: the tick's ledger is the only scheduling record.
  try {
    await deps.ledger?.write({
      source: "tick",
      outcome: result.outcome === "error" ? "error" : "ok",
      trigger: "tick",
      passes: 1,
      wall_ms: now() - startedAt,
      tokens: result.tokens ?? 0,
      wake_tokens: result.tokens ?? 0,
      pending_before: null,
      pending_after: result.pendingAfter ?? null,
      stopped: result.stopped ?? "max-passes",
      ...(result.error ? { error: result.error } : {}),
    })
  } catch {
    /* fail-open */
  }

  return {
    ran: true,
    result,
    pendingBefore: null,
    pendingAfter: result.pendingAfter ?? null,
  }
}
