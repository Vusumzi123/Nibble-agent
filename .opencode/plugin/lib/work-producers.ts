// Work producers (deconcurrency plan, Phase 1): deterministic collectors that
// feed the single work pool. A producer never schedules and never executes; it
// only states intent. The producer side owns the decision — the consumer picks
// one pool item per tick and runs it, or skips when the pool is empty.
//
// Shipped producers:
//   - tick        -> `mission`: at most one candidate per tick (weighted draw).
//   - brain-stale -> `staleness`: at most one status mission per tick.
//
// `turns-pending` and the side lane are gone: drain is a `drain-pass` work
// kind, and status missions ride the same pool as everything else.
import {
  candidacyPasses,
  type CandidacyContext,
  type DigestCandidate,
  type HeartbeatSignals,
} from "./heartbeat.ts"
import type { Mission, MissionCandidacy } from "./missions.ts"
import { PRIMARY_TTL_MS, type WorkItem } from "./work-queue.ts"

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
}

const MISSION_ID_PREFIX = "mission:"

export function missionItemId(missionId: string): string {
  return MISSION_ID_PREFIX + missionId
}

export function missionIdOf(item: WorkItem): string | null {
  return item.id.startsWith(MISSION_ID_PREFIX) ? item.id.slice(MISSION_ID_PREFIX.length) : null
}

function missionEligible(mission: Mission, ctx: { level: number; quiet: boolean }): boolean {
  if (!mission.enabled) return false
  const window = ctx.quiet ? "night" : "day"
  if (!mission.menus.includes(window)) return false
  return ctx.level >= mission.min_level
}

/** Status-fed missions (staleness) are produced by their own collector. */
export function isStatusSide(c: MissionCandidacy): boolean {
  return c === "brain-stale" || c.startsWith("brain-stale:")
}

function statusCandidacy(ctx: ProducerCtx): CandidacyContext {
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

/** Mission work: at most one candidate per tick, chosen by frequency × mood. */
export function collectMissions(ctx: ProducerCtx): WorkItem[] {
  const eligible = ctx.candidates.filter(
    (c) => !isStatusSide(c.candidacy) && !ctx.queuedIds?.has(missionItemId(c.id)),
  )
  const picked = weightedPick(eligible, ctx.random ?? Math.random)
  if (!picked) return []
  return [
    {
      id: missionItemId(picked.id),
      kind: "mission",
      producer: "tick",
      enqueued_ms: ctx.nowMs,
      expires_ms: ctx.nowMs + PRIMARY_TTL_MS,
      requeue_count: 0,
    },
  ]
}

/** Staleness work: at most one status mission per tick. */
export function collectStaleness(ctx: ProducerCtx): WorkItem[] {
  const candidacy = statusCandidacy(ctx)
  for (const m of ctx.missions) {
    if (!isStatusSide(m.candidacy)) continue
    if (ctx.queuedIds?.has(missionItemId(m.id))) continue
    if (!missionEligible(m, ctx)) continue
    if (!candidacyPasses(m, candidacy)) continue
    return [
      {
        id: missionItemId(m.id),
        kind: "staleness",
        producer: "brain-stale",
        enqueued_ms: ctx.nowMs,
        requeue_count: 0,
      },
    ]
  }
  return []
}

/** Run every producer; one broken producer never blocks the others. */
export function collectWork(ctx: ProducerCtx): WorkItem[] {
  const out: WorkItem[] = []
  for (const collect of [collectMissions, collectStaleness]) {
    try {
      out.push(...collect(ctx))
    } catch {
      /* fail-open: a broken producer contributes nothing */
    }
  }
  return out
}

/** Dequeue-time re-check: structural eligibility only. A queued mission is a
 *  reservation and runs even when the per-tick roll no longer offers it. */
export function itemRunnable(ctx: ProducerCtx, item: WorkItem): boolean {
  if (item.kind === "mission") {
    if (item.payload?.resume === true) return true
    const id = missionIdOf(item)
    if (id === null) return false
    const mission = ctx.missions.find((m) => m.id === id)
    return mission ? missionEligible(mission, ctx) : false
  }
  if (item.kind === "staleness") {
    const id = missionIdOf(item)
    if (id === null) return false
    const mission = ctx.missions.find((m) => m.id === id)
    if (!mission) return false
    if (!missionEligible(mission, ctx)) return false
    return candidacyPasses(mission, statusCandidacy(ctx))
  }
  return true
}

/** Prune-time "is the work still needed". Missions are governed by expiry;
 *  staleness drops when the status predicate stops holding. */
export function itemStillDue(ctx: ProducerCtx, item: WorkItem): boolean {
  if (item.kind !== "staleness") return true
  const id = missionIdOf(item)
  if (id === null) return false
  const mission = ctx.missions.find((m) => m.id === id)
  if (!mission) return false
  return candidacyPasses(mission, statusCandidacy(ctx))
}
