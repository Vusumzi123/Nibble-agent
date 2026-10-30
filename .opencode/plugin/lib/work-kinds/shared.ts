// Shared producer/eligibility primitives for work-kind handlers.
//
// Kind modules own their own intent (produce) and eligibility (runnable /
// stillDue); the values that more than one kind needs live here. The heartbeat
// hook never imports a kind module directly — only `work-kinds/registry.ts`.
//
// Loaded via relative import only.
import type { CandidacyContext, DigestCandidate, HeartbeatSignals } from "../heartbeat.ts"
import type { Mission, MissionCandidacy } from "../missions.ts"
import { PRIMARY_TTL_MS, type WorkItem } from "../work-queue.ts"

export type ProducerCtx = {
  nowMs: number
  level: number
  quiet: boolean
  signals: HeartbeatSignals
  missions: Mission[]
  candidates: DigestCandidate[]
  /** Ids already in the pool; a producer never re-adds one. */
  queuedIds?: ReadonlySet<string>
  /** Injectable randomness for the weighted draw (tests). */
  random?: () => number
  /**
   * Drain due-check, injected by the heartbeat so the drain handler owns the
   * kind rule without importing I/O or config. Absent → no drain intent.
   */
  drainDue?: () => Promise<{ due: boolean }>
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

/** One weighted draw over a candidate list; null when the list is empty. */
export function weightedPick<T extends { weight: number }>(
  items: readonly T[],
  random: () => number = Math.random,
): T | null {
  if (items.length === 0) return null
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  if (total <= 0) return items[Math.min(items.length - 1, Math.floor(random() * items.length))] ?? null
  let roll = random() * total
  for (const item of items) {
    roll -= Math.max(0, item.weight)
    if (roll <= 0) return item
  }
  return items[items.length - 1] ?? null
}

/** The mission TTL a producer stamps on an item it emits. */
export function missionExpiry(nowMs: number): number {
  return nowMs + PRIMARY_TTL_MS
}
