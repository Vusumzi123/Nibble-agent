// One ordered work queue (deconcurrency plan, Phase 1).
//
// Replaces the two-lane queue (`lanes/queue.ts`). There are no lanes: the
// heartbeat loop picks ONE due work unit per pass by kind priority, executes
// it, settles it, and schedules the next wake. Everything that used to be a
// second scheduler or a side lane is a work kind here:
//
//   mission > drain-pass > dream > staleness > profile-update > soul-update
//
// `not_before_ms` is how a kind that is not due yet stays in the queue without
// spinning: the picker skips it and the loop's wake math (computeWakeDelayMs)
// bounds the next look. Dedupe is by `id`, so a producer that re-collects the
// same mission keeps its original position and its resume payload.
//
// Pure except load/save; never throws.
import { atomicRead, atomicWrite } from "./fsx.ts"

export const WORK_QUEUE_FILE = "work-queue.json"

/** A mission that JEV keeps declining lives this long, then drops. */
export const PRIMARY_TTL_MS = 24 * 60 * 60_000

/** Timeout re-enqueues at the tail at most this many times, then drop. */
export const MAX_REQUEUES = 3

/** Total depth cap; overflow drops the OLDEST items (log it upstream). */
export const MAX_QUEUE_DEPTH = 50

export type WorkKind =
  | "mission"
  | "drain-pass"
  | "dream"
  | "staleness"
  | "profile-update"
  | "soul-update"

/** Lower runs first. The plan's Phase 1 order, verbatim. */
export const WORK_PRIORITY: Readonly<Record<WorkKind, number>> = {
  mission: 0,
  "drain-pass": 1,
  dream: 2,
  staleness: 3,
  "profile-update": 4,
  "soul-update": 5,
}

export type WorkItem = {
  /** Stable dedupe key: `mission:<id>`, `drain-pass`, `dream`, `<source>:<key>`. */
  id: string
  kind: WorkKind
  /** Which producer enqueued it (`tick`, `brain-stale`, `scheduler`, …). */
  producer: string
  /** Enqueue time; preserved across ticks — FIFO order within a kind. A
   *  timeout requeue refreshes it so the item lands at the tail. */
  enqueued_ms: number
  /** Earliest execution time. Absent = due immediately. */
  not_before_ms?: number
  /** Primary mission TTL deadline (set by the producer); absent = never expires. */
  expires_ms?: number
  /** How many times a timeout re-enqueued this item. */
  requeue_count: number
  /** Why the last requeue happened (e.g. "timeout"). */
  requeue_reason?: string
  /** Optional producer-specific payload (mission id, resume payload, …). */
  payload?: Record<string, unknown>
}

export function emptyQueue(): WorkItem[] {
  return []
}

export function isDue(item: WorkItem, nowMs: number): boolean {
  return item.not_before_ms === undefined || nowMs >= item.not_before_ms
}

export function priorityOf(kind: WorkKind): number {
  return WORK_PRIORITY[kind] ?? Number.MAX_SAFE_INTEGER
}

/** Parse persisted work; a missing/corrupt file yields an empty queue. A
 *  legacy `{primary, side}` lanes file is migrated in place. */
export async function loadWorkQueue(file: string): Promise<WorkItem[]> {
  const text = await atomicRead(file)
  if (!text) return emptyQueue()
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return sanitize(parsed)
    const legacy = parsed as { primary?: unknown; side?: unknown }
    return sanitize([
      ...(Array.isArray(legacy.primary) ? legacy.primary : []),
      ...(Array.isArray(legacy.side) ? legacy.side.map((i) => ({ ...(i as object), kind: "staleness" })) : []),
    ])
  } catch {
    return emptyQueue()
  }
}

function sanitize(raw: unknown[]): WorkItem[] {
  const out: WorkItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Partial<WorkItem> & { lane?: string }
    if (typeof item.id !== "string" || item.id === "") continue
    const kind = normalizeKind(item.kind, item.lane)
    if (!kind) continue
    out.push({
      id: item.id,
      kind,
      producer: typeof item.producer === "string" ? item.producer : "unknown",
      enqueued_ms: typeof item.enqueued_ms === "number" ? item.enqueued_ms : 0,
      ...(typeof item.not_before_ms === "number" ? { not_before_ms: item.not_before_ms } : {}),
      ...(typeof item.expires_ms === "number" ? { expires_ms: item.expires_ms } : {}),
      requeue_count: typeof item.requeue_count === "number" ? item.requeue_count : 0,
      ...(typeof item.requeue_reason === "string" ? { requeue_reason: item.requeue_reason } : {}),
      ...(item.payload && typeof item.payload === "object" ? { payload: item.payload } : {}),
    })
  }
  return out.sort((a, b) => a.enqueued_ms - b.enqueued_ms)
}

function normalizeKind(kind: unknown, lane: unknown): WorkKind | null {
  if (
    kind === "mission" ||
    kind === "drain-pass" ||
    kind === "dream" ||
    kind === "staleness" ||
    kind === "profile-update" ||
    kind === "soul-update"
  ) {
    return kind
  }
  // Legacy lane file: every bare mission item was a mission; side items were
  // staleness-driven missions.
  if (kind === "mission" || kind === undefined) return lane === "side" ? "staleness" : "mission"
  return null
}

/** Persist the queue (atomic rename); never throws. */
export async function saveWorkQueue(file: string, queue: WorkItem[]): Promise<void> {
  try {
    await atomicWrite(file, JSON.stringify(queue))
  } catch {
    // best-effort — a queue write must never fail a tick
  }
}

/** Merge collected items. Dedupe by id: an item already queued keeps its
 *  ORIGINAL enqueued_ms (re-enqueueing every tick would destroy FIFO). */
export function enqueueWork(queue: WorkItem[], items: readonly WorkItem[]): WorkItem[] {
  const out = [...queue]
  for (const item of items) {
    if (out.some((existing) => existing.id === item.id)) continue
    out.push({ ...item })
  }
  return cap(out).sort((a, b) => a.enqueued_ms - b.enqueued_ms)
}

function cap(items: WorkItem[]): WorkItem[] {
  return items.length > MAX_QUEUE_DEPTH ? items.slice(items.length - MAX_QUEUE_DEPTH) : items
}

/**
 * The runOne picker: the highest-priority due item, FIFO within a kind.
 * `isRunnable` may veto an item (menu window, level, status no longer true);
 * a vetoed item stays queued so a day-window item can wait through the night.
 */
export function pickNext(
  queue: WorkItem[],
  nowMs: number,
  isRunnable: (item: WorkItem) => boolean = () => true,
): WorkItem | null {
  const due = queue.filter((item) => isDue(item, nowMs) && isRunnable(item))
  if (due.length === 0) return null
  let best = due[0]
  for (const item of due.slice(1)) {
    const dp = priorityOf(item.kind) - priorityOf(best.kind)
    if (dp < 0 || (dp === 0 && item.enqueued_ms < best.enqueued_ms)) best = item
  }
  return best
}

/** Remove a dispatched item by id. */
export function dequeueById(queue: WorkItem[], id: string): { item: WorkItem; rest: WorkItem[] } | null {
  const idx = queue.findIndex((i) => i.id === id)
  if (idx < 0) return null
  return { item: queue[idx], rest: queue.filter((_, i) => i !== idx) }
}

/** Timeout path: put the item back at the TAIL with the reason recorded. */
export function requeueTail(item: WorkItem, reason: string, nowMs: number): WorkItem | null {
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

/** Stall path: same id, carrying what the next attempt needs to continue. */
export function stallResumeItem(
  item: WorkItem,
  resume: Record<string, unknown>,
  nowMs: number,
): WorkItem | null {
  if (item.requeue_count >= MAX_REQUEUES) return null
  return {
    ...item,
    enqueued_ms: nowMs,
    producer: "timeout",
    requeue_count: item.requeue_count + 1,
    requeue_reason: "timeout",
    payload: {
      ...item.payload,
      ...(item.payload?.original_enqueued_ms === undefined
        ? { original_enqueued_ms: item.enqueued_ms }
        : {}),
      ...resume,
      resume: true,
      timeout_count: item.requeue_count + 1,
    },
  }
}

/** Drop items that must not run again: past expiry, or whose work is gone. */
export function pruneWork(
  queue: WorkItem[],
  nowMs: number,
  stillDue: (item: WorkItem) => boolean = () => true,
): { queue: WorkItem[]; dropped: WorkItem[] } {
  const dropped: WorkItem[] = []
  const kept = queue.filter((item) => {
    const expired = item.expires_ms !== undefined && nowMs >= item.expires_ms
    const gone = !stillDue(item)
    if (expired || gone) {
      dropped.push(item)
      return false
    }
    return true
  })
  return { queue: kept, dropped }
}

export function queueDepth(queue: WorkItem[]): number {
  return queue.length
}

export function queueEmpty(queue: WorkItem[]): boolean {
  return queue.length === 0
}
