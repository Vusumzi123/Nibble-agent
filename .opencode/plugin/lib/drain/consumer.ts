// The demand-driven drain consumer (drain-consumer-plan §2.1–§2.7).
//
// Two loops, two notions of time: the heartbeat tick is frequency-driven and
// owns primary judgment; this loop is demand-driven — it starts because work
// exists (pending >= trigger_pending OR oldest age >= trigger_max_age_hours)
// and stops because the backlog is below the trigger, a ceiling tripped, or a
// stop condition fired. It shares no lock with the tick; each pass serializes
// through `drain.lock` inside the pipe (§2.4), so tool, dream, and consumer
// can never write concurrently.
//
// Stop conditions (§2.2, all observable):
//   backlog-below-trigger | token-budget | wake-token-budget | wake-wall |
//   max-passes | lock-held | no-progress | config-changed | crash | disabled
//
// Error isolation (§2.7): the consumer body copies runTick's boundary —
// try/catch/finally, an unref'd timer, `void loop().catch()`, so an exception
// releases the lock, resets the marker, logs `stopped: "crash"`, and backs
// off poll_seconds × 4 without ever reaching the tick loop.
//
// Live marker: `state/drain.current.json` (§5.2) — separate from
// heartbeat.current.json so the two loops never race on one marker file.
//
// Loaded via relative import only.
import { join } from "node:path"
import { readAutonomyConfig } from "../autonomy.ts"
import { readHeartbeatConfig } from "../heartbeat.ts"
import { atomicWrite } from "../fsx.ts"
import { nowIso } from "../util.ts"
import { readDrainConfig, type DrainConfig } from "./config.ts"
import { blockedBackoffActive, loadCursor, resolveCursorFile } from "./cursor.ts"
import { countUnconsumed, oldestPendingAge } from "./db.ts"
import type { DrainLedger } from "./ledger.ts"
import { runDrainPipe, type DrainPipeClient, type DrainPipeResult } from "./pipe.ts"
import { effectiveCursorLastTs } from "./status.ts"
import type { MemoryProvider } from "../memory/types.ts"

export const DRAIN_CURRENT_FILE = "drain.current.json"

export type DrainConsumerState = "idle" | "running"

export type DrainCurrent = {
  state: DrainConsumerState
  trigger: string | null
  pass: number
  pending: number | null
  oldest_pending_age_ms: number | null
  started_at: string | null
  updated_at: string
  /** Next scheduled wake (epoch ms) while idle; null while running. */
  next_due: number | null
}

export function idleDrainCurrent(now: number = Date.now()): DrainCurrent {
  return {
    state: "idle",
    trigger: null,
    pass: 0,
    pending: null,
    oldest_pending_age_ms: null,
    started_at: null,
    updated_at: new Date(now).toISOString(),
    next_due: null,
  }
}

/** Why a wake stopped (§2.2/§2.6). `lock-held` never reaches a pass (§5.1). */
export type WakeStopReason =
  | "backlog-below-trigger"
  | "token-budget"
  | "wake-token-budget"
  | "wake-wall"
  | "max-passes"
  | "lock-held"
  | "no-progress"
  | "config-changed"
  | "crash"

export type WakeSummary = {
  trigger: "consumer"
  passes: number
  wall_ms: number
  tokens: number
  wake_tokens: number
  pending_before: number | null
  pending_after: number | null
  stopped: WakeStopReason
}

export type DrainConsumerDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  client: DrainPipeClient
  waitForIdle: (sessionID: string) => Promise<boolean>
  registerChild?: (sessionID: string) => void
  dbFile?: string
  ledger?: DrainLedger
  onWarn?: (message: string, err?: unknown) => void
  /** Fresh provider every wake — a provider flip applies without a restart. */
  resolveProvider: () => Promise<MemoryProvider | undefined>
  /** Test seams. Production never carries them. */
  readConfig?: () => Promise<DrainConfig>
  now?: () => number
  /** Test seam: skip the initial timer wake; call `wake()` manually. */
  autostart?: boolean
}

export type DrainConsumerHandle = {
  /** Cancel the timer; an in-flight pass still finishes and releases. */
  stop(): void
  /** Run one wake now (used by tests; production uses the timer). */
  wake(): Promise<WakeSummary | null>
  currentFile: string
}

type TriggerState = {
  pending: number | null
  oldestAgeMs: number | null
  error?: string
}

function configFingerprint(cfg: DrainConfig): string {
  return JSON.stringify(cfg)
}

/**
 * Start the consumer loop. The first wake is deferred so plugin init returns
 * first (startup-catch-up pattern); the loop is demand-driven and recomputes
 * `poll_seconds` from disk after every wake — a config flip applies without a
 * restart.
 */
export function startDrainConsumer(deps: DrainConsumerDeps): DrainConsumerHandle {
  const now = deps.now ?? Date.now
  const readConfig = deps.readConfig ?? (() => readDrainConfig(deps.directory))
  const currentFile = join(deps.stateDir, DRAIN_CURRENT_FILE)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const writeCurrent = async (patch: Partial<DrainCurrent>): Promise<void> => {
    try {
      const next: DrainCurrent = { ...idleDrainCurrent(now()), ...patch, updated_at: nowIso() }
      await atomicWrite(currentFile, JSON.stringify(next, null, 2) + "\n")
    } catch (err) {
      deps.onWarn?.("drain consumer: current marker write failed", err)
    }
  }

  /** Pending + oldest age against the effective watermark (§2.5). */
  const readTrigger = async (cfg: DrainConfig): Promise<TriggerState> => {
    try {
      const { lastTs, marks } = await effectiveCursorLastTs(deps.stateDir, cfg, now())
      const common = {
        projectDir: deps.directory,
        lastTs,
        // Count against each session's own mark too: turns consolidated above
        // the watermark are not pending and must not trigger a wake.
        marks,
        ...(deps.dbFile === undefined ? {} : { dbFile: deps.dbFile }),
        excludeMissions: cfg.exclude_missions,
      }
      const pending = await countUnconsumed(common)
      if (pending === 0) return { pending, oldestAgeMs: null }
      const { ageMs } = await oldestPendingAge({ ...common, now: now() })
      return { pending, oldestAgeMs: ageMs }
    } catch (err) {
      return { pending: null, oldestAgeMs: null, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const triggered = (state: TriggerState, cfg: DrainConfig): boolean => {
    if (state.pending === null) return false
    if (state.pending >= cfg.trigger_pending) return true
    return state.oldestAgeMs !== null && state.oldestAgeMs >= cfg.trigger_max_age_hours * 3_600_000
  }

  /** One bounded wake: passes while the trigger holds and ceilings allow. */
  const wakeOnce = async (): Promise<WakeSummary | null> => {
    let cfg: DrainConfig
    try {
      cfg = await readConfig()
    } catch (err) {
      deps.onWarn?.("drain consumer: config read failed", err)
      return null
    }

    // Disabled / rollback path (§3): the consumer idles; the legacy lane
    // behaviour (consumer: false) is the producers' job, not ours.
    if (!cfg.enabled || !cfg.consumer) {
      await writeCurrent({ ...idleDrainCurrent(now()), next_due: now() + cfg.poll_seconds * 1000 })
      return null
    }

    // A recorded failure backs the consumer off instead of hot-looping (§2.3).
    try {
      const cursor = await loadCursor(resolveCursorFile(deps.stateDir, cfg.cursor_file))
      if (blockedBackoffActive(cursor, now())) {
        const until = cursor.blocked.blocked_until
        await writeCurrent({
          ...idleDrainCurrent(now()),
          next_due: Math.max(until, now() + cfg.poll_seconds * 1000),
        })
        return null
      }
    } catch {
      /* cursor is total; proceed */
    }

    const triggerState = await readTrigger(cfg)
    if (!triggered(triggerState, cfg)) {
      await writeCurrent({
        ...idleDrainCurrent(now()),
        pending: triggerState.pending,
        oldest_pending_age_ms: triggerState.oldestAgeMs,
        next_due: now() + cfg.poll_seconds * 1000,
      })
      return null
    }

    // ---- wake (§2.6 ceilings) ------------------------------------------
    const wakeStart = now()
    const fingerprint = configFingerprint(cfg)
    let passes = 0
    let wakeTokens = 0
    let pendingBefore = triggerState.pending
    let pendingAfter = triggerState.pending
    let stopped: WakeStopReason | null = null
    let lastResult: DrainPipeResult | null = null
    let lastCursorAfter: number | null = null

    const provider = await deps.resolveProvider().catch((err) => {
      deps.onWarn?.("drain consumer: provider resolve failed", err)
      return undefined
    })
    if (!provider?.consolidate) {
      await writeCurrent({
        ...idleDrainCurrent(now()),
        pending: triggerState.pending,
        oldest_pending_age_ms: triggerState.oldestAgeMs,
        next_due: now() + cfg.poll_seconds * 1000,
      })
      return null
    }

    await writeCurrent({
      state: "running",
      trigger: "consumer",
      pass: 0,
      pending: triggerState.pending,
      oldest_pending_age_ms: triggerState.oldestAgeMs,
      started_at: new Date(wakeStart).toISOString(),
      next_due: null,
    })

    while (passes < cfg.max_passes_per_wake) {
      const wall = now() - wakeStart
      if (cfg.max_wall_minutes > 0 && wall >= cfg.max_wall_minutes * 60_000) {
        stopped = "wake-wall"
        break
      }
      if (cfg.wake_token_budget > 0 && wakeTokens >= cfg.wake_token_budget) {
        stopped = "wake-token-budget"
        break
      }

      // Hot-read config between passes (§2.2): a flip stops the wake.
      let passCfg: DrainConfig
      try {
        passCfg = await readConfig()
      } catch (err) {
        deps.onWarn?.("drain consumer: config re-read failed", err)
        stopped = "config-changed"
        break
      }
      if (!passCfg.enabled || !passCfg.consumer || configFingerprint(passCfg) !== fingerprint) {
        stopped = "config-changed"
        break
      }

      // §5.1: per-child mission.lock settings, hot-read so a dial flip applies
      // on the next pass. A read failure fails open (no lock), never a crash.
      let missionLock: { file: string; refreshMs: number; staleMs: number } | null = null
      try {
        const [autonomyCfg, hbCfg] = await Promise.all([
          readAutonomyConfig(deps.directory),
          readHeartbeatConfig(deps.directory),
        ])
        if (autonomyCfg.heartbeat.in_progress_lock) {
          missionLock = {
            file: join(deps.stateDir, "mission.lock"),
            refreshMs: hbCfg.mission_lock_refresh_ms,
            staleMs: hbCfg.mission_lock_stale_ms,
          }
        }
      } catch (err) {
        deps.onWarn?.("drain consumer: mission lock config read failed", err)
      }

      const result = await runDrainPipe({
        directory: deps.directory,
        stateDir: deps.stateDir,
        vaultDir: deps.vaultDir,
        config: passCfg,
        client: deps.client,
        provider,
        waitForIdle: deps.waitForIdle,
        registerChild: deps.registerChild,
        ...(deps.dbFile === undefined ? {} : { dbFile: deps.dbFile }),
        ...(deps.ledger ? { ledger: deps.ledger } : {}),
        missionLock,
        trigger: "consumer",
        pass: passes,
        onWarn: deps.onWarn,
      })

      if (result.lockHeld) {
        // §2.4/§5.1: a lock-held wake never reaches a pass.
        stopped = "lock-held"
        break
      }

      if (result.stopped === "mission-lock-held") {
        // §5.1: another agent is working; stop the wake, back off normally.
        stopped = "lock-held"
        break
      }

      passes += 1
      wakeTokens += result.tokens ?? 0
      lastResult = result
      if (result.pendingAfter !== null && result.pendingAfter !== undefined) {
        pendingAfter = result.pendingAfter
      } else if (pendingBefore === null) {
        pendingAfter = null
      }

      await writeCurrent({
        state: "running",
        trigger: "consumer",
        pass: passes,
        pending: pendingAfter,
        oldest_pending_age_ms: result.oldestPendingAgeMs ?? null,
        started_at: new Date(wakeStart).toISOString(),
        next_due: null,
      })

      // No progress (§2.2): nothing consumed and nothing written.
      if (
        lastCursorAfter !== null &&
        result.cursorAfter === result.cursorBefore &&
        result.items === 0 &&
        result.cursorAfter === lastCursorAfter
      ) {
        stopped = "no-progress"
        break
      }
      if (result.cursorAfter === result.cursorBefore && result.items === 0 && passes === 1) {
        // First pass consumed nothing — the backlog is unsettled or blocked.
        stopped = "no-progress"
        break
      }
      lastCursorAfter = result.cursorAfter

      // Per-pass budget stop yields to the next wake (§2.2).
      if (result.stopped === "token-budget") {
        stopped = "token-budget"
        break
      }

      // Re-evaluate the trigger between passes (§2.2).
      const nextTrigger = await readTrigger(passCfg)
      pendingBefore = pendingBefore ?? nextTrigger.pending
      pendingAfter = nextTrigger.pending
      if (!triggered(nextTrigger, passCfg)) {
        stopped = "backlog-below-trigger"
        break
      }
    }

    // Falling out of the loop with the trigger still held means a wake
    // ceiling tripped — the observable one is the pass cap (§2.6 backstop).
    if (stopped === null) stopped = "max-passes"

    const summary: WakeSummary = {
      trigger: "consumer",
      passes,
      wall_ms: now() - wakeStart,
      tokens: wakeTokens,
      wake_tokens: wakeTokens,
      pending_before: pendingBefore,
      pending_after: pendingAfter,
      stopped,
    }

    // One consumer ledger line per wake (§5.1).
    try {
      await deps.ledger?.write({
        source: "consumer",
        outcome: stopped === "crash" ? "error" : "ok",
        trigger: "consumer",
        passes: summary.passes,
        wall_ms: summary.wall_ms,
        tokens: summary.tokens,
        wake_tokens: summary.wake_tokens,
        pending_before: summary.pending_before,
        pending_after: summary.pending_after,
        stopped: summary.stopped,
        ...(lastResult?.error ? { error: lastResult.error } : {}),
      })
    } catch {
      /* fail-open */
    }

    // Back off harder after a stall (poll × 4), normal cadence otherwise.
    const backoff =
      stopped === "no-progress" || stopped === "crash" ? cfg.poll_seconds * 4 : cfg.poll_seconds
    await writeCurrent({
      ...idleDrainCurrent(now()),
      pending: summary.pending_after,
      oldest_pending_age_ms: lastResult?.oldestPendingAgeMs ?? null,
      next_due: now() + backoff * 1000,
    })
    return summary
  }

  const wake = async (): Promise<WakeSummary | null> => {
    try {
      return await wakeOnce()
    } catch (err) {
      // §2.7: an exception inside the consumer never reaches the tick loop.
      deps.onWarn?.("drain consumer: wake failed", err)
      try {
        const cfg = await readConfig()
        await deps.ledger?.write({
          source: "consumer",
          outcome: "error",
          trigger: "consumer",
          passes: 0,
          wall_ms: 0,
          tokens: 0,
          wake_tokens: 0,
          pending_before: null,
          pending_after: null,
          stopped: "crash",
          error: err instanceof Error ? err.message : String(err),
        })
        await writeCurrent({
          ...idleDrainCurrent(now()),
          next_due: now() + cfg.poll_seconds * 4 * 1000,
        })
      } catch {
        /* last-ditch fail-open */
      }
      return null
    }
  }

  const schedule = (ms: number): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void loop()
    }, Math.max(0, ms))
    timer.unref?.()
  }

  const loop = async (): Promise<void> => {
    if (stopped) return
    await wake()
    if (stopped) return
    let delay = 60_000
    try {
      const cfg = await readConfig()
      delay = cfg.poll_seconds * 1000
    } catch {
      /* fall back to the cap */
    }
    schedule(delay)
  }

  // First wake deferred so plugin init returns first (heartbeat pattern).
  // Tests disable autostart and call `wake()` directly.
  if (deps.autostart !== false) schedule(0)

  return {
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    wake,
    currentFile,
  }
}
