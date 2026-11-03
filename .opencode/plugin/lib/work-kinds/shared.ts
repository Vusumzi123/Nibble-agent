// Shared producer/eligibility primitives for work-kind handlers.
//
// Kind modules own their eligibility (runnable / stillDue) and execution; the
// values that more than one kind needs live here. The heartbeat
// hook never imports a kind module directly — only `work-kinds/registry.ts`.
//
// Loaded via relative import only.
import type { CandidacyContext, HeartbeatSignals } from "../heartbeat.ts"
import type { Mission, MissionCandidacy } from "../missions.ts"
import { PRIMARY_TTL_MS, type WorkItem } from "../work-queue.ts"

export type ProducerCtx = {
  nowMs: number
  /** `<project>/.opencode/state`; absent in pure producer tests. */
  stateDir?: string
  level: number
  quiet: boolean
  signals: HeartbeatSignals
  missions: Mission[]
  /** Store-backed dedupe; a producer never re-adds a queued or running id. */
  has?: (id: string) => boolean
  /** In-memory fallback for pure producer tests. */
  queuedIds?: ReadonlySet<string>
  /** Injectable randomness for stochastic candidacy (tests). */
  random?: () => number
  /**
   * Retention window for settled user-task files (`heartbeat.
   * user_task_retention_days`); absent → the store default (30 days).
   */
  userTaskRetentionDays?: number
}

const MISSION_ID_PREFIX = "mission:"

export function missionItemId(missionId: string): string {
  return MISSION_ID_PREFIX + missionId
}

export function missionIdOf(item: WorkItem): string | null {
  return item.id.startsWith(MISSION_ID_PREFIX) ? item.id.slice(MISSION_ID_PREFIX.length) : null
}

export function missionEligible(
  mission: Mission,
  ctx: { level: number; quiet: boolean },
): boolean {
  if (!mission.enabled) return false
  const window = ctx.quiet ? "night" : "day"
  if (!mission.menus.includes(window)) return false
  return ctx.level >= mission.min_level
}

/** Status-fed missions (staleness) are produced by their own collector. */
export function isStatusSide(c: MissionCandidacy): boolean {
  return c === "brain-stale" || c.startsWith("brain-stale:")
}

export function statusCandidacy(ctx: ProducerCtx): CandidacyContext {
  return {
    backlogPending: ctx.signals.backlog_pending,
    brainOldest: ctx.signals.brain_oldest,
    nowMs: ctx.nowMs,
  }
}

/** The mission TTL a producer stamps on an item it emits. */
export function missionExpiry(nowMs: number): number {
  return nowMs + PRIMARY_TTL_MS
}
