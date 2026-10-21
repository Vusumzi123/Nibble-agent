// Lane queues (docs/heartbeat-lanes.md): one queue per dispatch lane.
//
// The tick stops being a "do one thing" event and becomes a drain event:
// producers enqueue work items, the dispatcher dequeues at most one item per
// lane per tick, and an empty tick is a silent tick. Missed ticks still
// coalesce (computeWakeDelayMs) — work piles up in the queue, never as a
// replayed tick backlog.
//
// Lanes:
//   - primary: tick-fed eligible missions; JEV picks one; items survive a
//     no_reply until their expiry (PRIMARY_TTL_MS), then drop.
//   - side:    status-fed work (drain when turns are pending, staleness when a
//     reference note is old). Strict FIFO among runnable items, exactly one
//     dequeue per tick, no expiry — a side item waits indefinitely.
//
// Failure policy:
//   - timeout  -> re-enqueue at the queue TAIL with the reason recorded
//                 (requeue_count + 1, fresh enqueued_ms so FIFO puts it last),
//                 at most MAX_REQUEUES times, then drop.
//   - error    -> drop (the producers re-collect if the work is still due).
//   - declined -> drop (nothing to do).
//
// Everything here is pure except loadQueues/saveQueues; never throws.
import { atomicRead, atomicWrite } from "../fsx.ts"
import type { MissionLane } from "../missions.ts"

export const LANES_FILE = "lanes.json"

/** A primary item that JEV keeps declining lives this long, then drops. */
export const PRIMARY_TTL_MS = 24 * 60 * 60_000

/** Timeout re-enqueues at the tail at most this many times, then drop. */
export const MAX_REQUEUES = 3

/** Per-lane depth cap; over the cap the OLDEST items drop (log it upstream). */
export const MAX_LANE_DEPTH = 50

export type QueueItem = {
  /** Stable dedupe key: `mission:<id>` for missions, `<source>:<key>` otherwise. */
  id: string
  /** How to execute the item; only "mission" is dispatched today. */
  kind: "mission"
  lane: MissionLane
  /** Which producer enqueued it (`tick`, `turns-pending`, `brain-stale`, …). */
  producer: string
  /** Enqueue time; preserved across ticks — FIFO order depends on it. A
   *  timeout requeue refreshes it so the item lands at the tail. */
  enqueued_ms: number
  /** Primary TTL deadline (set by the producer); absent = never expires. */
  expires_ms?: number
  /** How many times a timeout re-enqueued this item. */
  requeue_count: number
  /** Why the last requeue happened (e.g. "timeout"). */
  requeue_reason?: string
  /** Optional producer-specific payload for future non-mission kinds. */
  payload?: Record<string, unknown>
}

export type LaneQueues = {
  primary: QueueItem[]
  side: QueueItem[]
}

export function emptyQueues(): LaneQueues {
  return { primary: [], side: [] }
}

export function laneOf(q: LaneQueues, lane: MissionLane): QueueItem[] {
  return lane === "side" ? q.side : q.primary
}

/** Parse persisted queues; a missing/corrupt file yields an empty set. */
export async function loadQueues(file: string): Promise<LaneQueues> {
  const text = await atomicRead(file)
  if (!text) return emptyQueues()
  try {
    const parsed = JSON.parse(text) as Partial<LaneQueues>
    return {
      primary: sanitizeItems(parsed.primary, "primary"),
      side: sanitizeItems(parsed.side, "side"),
    }
  } catch {
    return emptyQueues()
  }
}

function sanitizeItems(raw: unknown, lane: MissionLane): QueueItem[] {
  if (!Array.isArray(raw)) return []
  const out: QueueItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Partial<QueueItem>
    if (typeof item.id !== "string" || item.id === "") continue
    if (item.kind !== "mission") continue // unknown kinds: future runners
    out.push({
      id: item.id,
      kind: "mission",
      lane,
      producer: typeof item.producer === "string" ? item.producer : "unknown",
      enqueued_ms: typeof item.enqueued_ms === "number" ? item.enqueued_ms : 0,
      ...(typeof item.expires_ms === "number" ? { expires_ms: item.expires_ms } : {}),
      requeue_count: typeof item.requeue_count === "number" ? item.requeue_count : 0,
      ...(typeof item.requeue_reason === "string" ? { requeue_reason: item.requeue_reason } : {}),
      ...(item.payload && typeof item.payload === "object" ? { payload: item.payload } : {}),
    })
  }
  return out.sort((a, b) => a.enqueued_ms - b.enqueued_ms)
}

/** Persist queues (atomic rename); never throws. */
export async function saveQueues(file: string, queues: LaneQueues): Promise<void> {
  try {
    await atomicWrite(file, JSON.stringify(queues))
  } catch {
    // best-effort — a queue write must never fail a tick
  }
}

/**
 * Merge collected items into the queues. Dedupe by id: an item already queued
 * keeps its ORIGINAL enqueued_ms (re-enqueueing every tick with a fresh
 * timestamp would destroy FIFO fairness). New items append. Depth-capped:
 * overflow drops the oldest items of the lane.
 */
export function enqueueItems(queues: LaneQueues, items: readonly QueueItem[]): LaneQueues {
  const out: LaneQueues = { primary: [...queues.primary], side: [...queues.side] }
  for (const item of items) {
    const lane = laneOf(out, item.lane)
    if (lane.some((existing) => existing.id === item.id)) continue
    lane.push({ ...item })
  }
  out.primary = capLane(out.primary)
  out.side = capLane(out.side)
  return out
}

function capLane(items: QueueItem[]): QueueItem[] {
  return items.length > MAX_LANE_DEPTH ? items.slice(items.length - MAX_LANE_DEPTH) : items
}

/**
 * Dequeue the first RUNNABLE item of the side lane (FIFO among runnable
 * items). `isRunnable` receives the head and may reject it (menu window,
 * level, or status no longer true) — rejected items stay queued so a
 * day-window item can wait through the night. The remaining items never
 * jump an earlier runnable item: iteration order is enqueue order.
 */
export function dequeueSide(
  queues: LaneQueues,
  isRunnable: (item: QueueItem) => boolean = () => true,
): { item: QueueItem; rest: LaneQueues } | null {
  const idx = queues.side.findIndex(isRunnable)
  if (idx < 0) return null
  const item = queues.side[idx]
  return {
    item,
    rest: {
      primary: [...queues.primary],
      side: queues.side.filter((_, i) => i !== idx),
    },
  }
}

/** Remove the dispatched primary item by id (JEV's choice). */
export function dequeuePrimary(
  queues: LaneQueues,
  id: string,
): { item: QueueItem; rest: LaneQueues } | null {
  const idx = queues.primary.findIndex((i) => i.id === id)
  if (idx < 0) return null
  const item = queues.primary[idx]
  return {
    item,
    rest: {
      primary: queues.primary.filter((_, i) => i !== idx),
      side: [...queues.side],
    },
  }
}

/**
 * Timeout path: put the item back at the TAIL with the reason recorded.
 * enqueued_ms is refreshed (that is what makes it the tail); the original
 * wait time is kept in payload.original_enqueued_ms for diagnosis. Returns
 * null past MAX_REQUEUES — the caller drops the item.
 */
export function requeueTail(
  item: QueueItem,
  reason: string,
  nowMs: number,
): QueueItem | null {
  if (item.requeue_count >= MAX_REQUEUES) return null
  return {
    ...item,
    enqueued_ms: nowMs,
    requeue_count: item.requeue_count + 1,
    requeue_reason: reason,
    payload: {
      ...item.payload,
      ...(item.payload?.original_enqueued_ms === undefined
        ? { original_enqueued_ms: item.enqueued_ms }
        : {}),
    },
  }
}

/**
 * Drop items that must not run again: primary items past their expiry, and
 * any item whose work is gone (`stillDue` false — e.g. turns were consumed by
 * someone else). Side items never expire by age; `stillDue` is their only
 * exit besides execution.
 */
export function pruneQueues(
  queues: LaneQueues,
  nowMs: number,
  stillDue: (item: QueueItem) => boolean = () => true,
): { queues: LaneQueues; dropped: QueueItem[] } {
  const dropped: QueueItem[] = []
  const keep = (items: QueueItem[]): QueueItem[] =>
    items.filter((item) => {
      const expired = item.expires_ms !== undefined && nowMs >= item.expires_ms
      const gone = !stillDue(item)
      if (expired || gone) {
        dropped.push(item)
        return false
      }
      return true
    })
  return {
    queues: { primary: keep(queues.primary), side: keep(queues.side) },
    dropped,
  }
}

export function queueDepth(queues: LaneQueues): { primary: number; side: number } {
  return { primary: queues.primary.length, side: queues.side.length }
}

export function queuesEmpty(queues: LaneQueues): boolean {
  return queues.primary.length === 0 && queues.side.length === 0
}
