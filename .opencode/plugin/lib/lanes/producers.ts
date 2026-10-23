// Lane producers (docs/heartbeat-lanes.md): pluggable work sources that feed
// the lane queues at tick time. The registry is the extension seam — a future
// source (notifications, telegram, email, calendar) adds ONE producer file and
// one registry entry; the queue and the dispatcher do not change.
//
// Shipped producers:
//   - tick           -> primary lane: every eligible primary mission the
//                       digest already computed (candidates are filtered by
//                       enabled/menus/min_level/candidacy inside
//                       computeDigest — the producer just enqueues them).
//   - turns-pending  -> side lane: side missions gated on `turns-pending`
//                       (drain) when unconsumed turns are waiting.
//   - brain-stale    -> side lane: side missions gated on `brain-stale[:h]`
//                       (staleness) when the oldest reference note is old.
//
// Side lane rules: strictly status-fed. A side mission should declare one of
// the two status predicates above; other predicates on a side mission are not
// collected by any producer. Collection is deterministic and fail-open — a
// broken producer contributes nothing, never a throw.
import {
  candidacyPasses,
  type CandidacyContext,
  type DigestCandidate,
  type HeartbeatSignals,
} from "../heartbeat.ts"
import type { Mission, MissionCandidacy, MissionLane } from "../missions.ts"
import { PRIMARY_TTL_MS, type QueueItem } from "./queue.ts"

export type ProducerCtx = {
  nowMs: number
  /** Effective autonomy.level for this tick. */
  level: number
  /** True inside the quiet window (selects the "night" menu). */
  quiet: boolean
  signals: HeartbeatSignals
  /** All missions (post-overlay), for lane/status lookups. */
  missions: Mission[]
  /** Eligible primary-lane missions as computed by the digest. */
  candidates: DigestCandidate[]
  /** Last dispatched mission id (heartbeat.json) — no-repeat suppression. */
  lastMission: string | null
  /** drain.consumer — true means the drain loop owns drain; the
   *  turns-pending producer stops collecting (staleness is untouched). */
  drainConsumer?: boolean
}

export type Producer = {
  /** Stable id, journaled on every item it enqueues. */
  id: string
  /** Which lane this producer feeds. */
  lane: MissionLane
  /** Items to (re)ensure queued this tick. Pure intent: dedupe is the
   *  queue's job. Never throws at the call site — guard your own IO. */
  collect(ctx: ProducerCtx): QueueItem[]
}

const MISSION_ID_PREFIX = "mission:"

export function missionItemId(missionId: string): string {
  return MISSION_ID_PREFIX + missionId
}

export function missionIdOf(item: QueueItem): string | null {
  return item.id.startsWith(MISSION_ID_PREFIX) ? item.id.slice(MISSION_ID_PREFIX.length) : null
}

function missionItem(mission: Mission, producer: string, nowMs: number, lane: MissionLane, expires?: number): QueueItem {
  return {
    id: missionItemId(mission.id),
    kind: "mission",
    lane,
    producer,
    enqueued_ms: nowMs,
    requeue_count: 0,
    ...(expires !== undefined ? { expires_ms: expires } : {}),
  }
}

/** Structural filters shared by collection and the dequeue-time re-check:
 *  enabled, current menu window, autonomy level. */
function missionEligible(mission: Mission, ctx: { level: number; quiet: boolean }): boolean {
  if (!mission.enabled) return false
  const window = ctx.quiet ? "night" : "day"
  if (!mission.menus.includes(window)) return false
  return ctx.level >= mission.min_level
}

/** Candidacy context for STATUS predicates (side lane): the signals carry
 *  everything turns-pending / brain-stale need. Other predicates evaluate
 *  fail-closed or minimal (min-gap with no store reads as never-ran). */
function statusCandidacy(ctx: ProducerCtx): CandidacyContext {
  return {
    backlogPending: ctx.signals.backlog_pending,
    unconsumedTurns: ctx.signals.unconsumed_turns,
    brainOldest: ctx.signals.brain_oldest,
    nowMs: ctx.nowMs,
  }
}

function isStatusCandidacy(c: MissionCandidacy, kind: "turns-pending" | "brain-stale"): boolean {
  return kind === "turns-pending"
    ? c === "turns-pending"
    : c === "brain-stale" || c.startsWith("brain-stale:")
}

function collectSideByStatus(ctx: ProducerCtx, kind: "turns-pending" | "brain-stale", producerId: string): QueueItem[] {
  const out: QueueItem[] = []
  const candidacy = statusCandidacy(ctx)
  for (const m of ctx.missions) {
    if (m.lane !== "side") continue
    if (!isStatusCandidacy(m.candidacy, kind)) continue
    if (!missionEligible(m, ctx)) continue
    if (!candidacyPasses(m, candidacy)) continue
    out.push(missionItem(m, producerId, ctx.nowMs, "side"))
  }
  return out
}

/** Primary lane: the tick is the producer. The digest's candidate list is
 *  already the eligibility-filtered set, so collection is a projection. */
export const tickProducer: Producer = {
  id: "tick",
  lane: "primary",
  collect(ctx) {
    return ctx.candidates.map((c) => {
      const expires = ctx.nowMs + PRIMARY_TTL_MS
      return {
        id: missionItemId(c.id),
        kind: "mission" as const,
        lane: "primary" as MissionLane,
        producer: "tick",
        enqueued_ms: ctx.nowMs,
        expires_ms: expires,
        requeue_count: 0,
      }
    })
  },
}

/** Side lane status trigger: unconsumed turns waiting to be drained.
 *  Drain-consumer-plan §4: when `drain.consumer` owns drain, the producer
 *  stops collecting so the side lane carries staleness only. */
export const turnsPendingProducer: Producer = {
  id: "turns-pending",
  lane: "side",
  collect(ctx) {
    if (ctx.drainConsumer) return []
    return collectSideByStatus(ctx, "turns-pending", "turns-pending")
  },
}

/** Side lane status trigger: the oldest reference note is past its threshold. */
export const brainStaleProducer: Producer = {
  id: "brain-stale",
  lane: "side",
  collect(ctx) {
    return collectSideByStatus(ctx, "brain-stale", "brain-stale")
  },
}

/** The active registry. New sources (telegram, email, calendar, …) append
 *  here — the dispatcher and the queue only see QueueItems. */
export const PRODUCERS: readonly Producer[] = [tickProducer, turnsPendingProducer, brainStaleProducer]

/** Run every producer; one broken producer never blocks the others. */
export function collectItems(ctx: ProducerCtx): QueueItem[] {
  const out: QueueItem[] = []
  for (const producer of PRODUCERS) {
    try {
      out.push(...producer.collect(ctx))
    } catch {
      /* fail-open: a broken producer contributes nothing */
    }
  }
  return out
}

/**
 * Dequeue-time runnability re-check. Primary items are runnable while the
 * digest still offers their mission; side items are runnable while their
 * status predicate AND structural filters hold. A menu-blocked item (day-only
 * mission at night) is NOT runnable but stays queued. A turns-pending item is
 * never runnable while the drain consumer owns drain (plan §4).
 */
export function itemRunnable(ctx: ProducerCtx, item: QueueItem): boolean {
  const id = missionIdOf(item)
  if (id === null) return false
  if (item.lane === "primary") {
    // A stalled attempt resumes even when the digest no longer re-offers it.
    if (item.payload?.resume === true) return true
    return ctx.candidates.some((c) => c.id === id)
  }
  const mission = ctx.missions.find((m) => m.id === id)
  if (!mission) return false
  if (ctx.drainConsumer && mission.candidacy === "turns-pending") return false
  if (!missionEligible(mission, ctx)) return false
  return candidacyPasses(mission, statusCandidacy(ctx))
}

/**
 * Prune-time "is the work still needed". Side items drop when their status
 * is gone (turns consumed elsewhere, note refreshed) or the drain consumer
 * took over; primary items are governed purely by their expiry, so they are
 * always "due" here.
 */
export function itemStillDue(ctx: ProducerCtx, item: QueueItem): boolean {
  if (item.lane === "primary") return true
  const id = missionIdOf(item)
  if (id === null) return false
  const mission = ctx.missions.find((m) => m.id === id)
  if (!mission) return false
  if (ctx.drainConsumer && mission.candidacy === "turns-pending") return false
  return candidacyPasses(mission, statusCandidacy(ctx))
}
