// Work producers (deconcurrency plan, Phase 1): deterministic collectors that
// feed the single work queue. A producer never schedules and never executes;
// it only states intent. Dedupe and ordering belong to the queue.
//
// Shipped producers:
//   - tick        -> `mission`: every eligible primary mission the digest
//                    already computed (candidacy is filtered upstream).
//   - brain-stale -> `staleness`: a side mission gated on `brain-stale[:h]`
//                    when the oldest reference note is old.
//
// `turns-pending` is intentionally absent: drain is a `drain-pass` work kind
// now, not a mission someone has to dispatch.
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
  lastMission: string | null
  /** True when the drain step owns drain (it always does in Phase 1 unless
   *  `drain.consumer` is off): turns-pending side missions are then obsolete. */
  drainConsumer?: boolean
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

function statusCandidacy(ctx: ProducerCtx): CandidacyContext {
  return {
    backlogPending: ctx.signals.backlog_pending,
    unconsumedTurns: ctx.signals.unconsumed_turns,
    brainOldest: ctx.signals.brain_oldest,
    nowMs: ctx.nowMs,
  }
}

function isStatusSide(c: MissionCandidacy): boolean {
  return c === "turns-pending" || c === "brain-stale" || c.startsWith("brain-stale:")
}

/** Mission work: the digest's candidate list is already filtered. */
export function collectMissions(ctx: ProducerCtx): WorkItem[] {
  return ctx.candidates.map((c) => ({
    id: missionItemId(c.id),
    kind: "mission" as const,
    producer: "tick",
    enqueued_ms: ctx.nowMs,
    expires_ms: ctx.nowMs + PRIMARY_TTL_MS,
    requeue_count: 0,
  }))
}

/** Staleness work: side missions whose status predicate is satisfied. */
export function collectStaleness(ctx: ProducerCtx): WorkItem[] {
  const out: WorkItem[] = []
  const candidacy = statusCandidacy(ctx)
  for (const m of ctx.missions) {
    if (m.lane !== "side") continue
    if (!isStatusSide(m.candidacy)) continue
    if (ctx.drainConsumer && m.candidacy === "turns-pending") continue
    if (!missionEligible(m, ctx)) continue
    if (!candidacyPasses(m, candidacy)) continue
    out.push({
      id: missionItemId(m.id),
      kind: "staleness",
      producer: "brain-stale",
      enqueued_ms: ctx.nowMs,
      requeue_count: 0,
    })
  }
  return out
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

/** Dequeue-time re-check: a mission is runnable while the digest still offers
 *  it (or it carries a resume payload); staleness while its status holds. */
export function itemRunnable(ctx: ProducerCtx, item: WorkItem): boolean {
  if (item.kind === "mission") {
    if (item.payload?.resume === true) return true
    const id = missionIdOf(item)
    return id !== null && ctx.candidates.some((c) => c.id === id)
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

/** Prune-time "is the work still needed". Missions are governed by expiry. */
export function itemStillDue(ctx: ProducerCtx, item: WorkItem): boolean {
  if (item.kind !== "staleness") return true
  const id = missionIdOf(item)
  if (id === null) return false
  const mission = ctx.missions.find((m) => m.id === id)
  if (!mission) return false
  return candidacyPasses(mission, statusCandidacy(ctx))
}
