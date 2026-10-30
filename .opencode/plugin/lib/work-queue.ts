// One ordered work queue (deconcurrency plan, Phase 1).
//
// Replaces the two-lane queue (`lanes/queue.ts`). There are no lanes: the
// heartbeat loop picks ONE due work unit per pass, executes it, settles it,
// and schedules the next wake. Everything that used to be a second scheduler
// or a side lane is a work kind here:
//
//   mission, user-task, drain-pass, quiet-hours, staleness, profile-update,
//   soul-update
//
// The picker is smooth weighted round-robin (`pickFair`).
//
// The dream *mission* is an ordinary `mission` item, night-gated by its
// `menus: [night]` frontmatter; `quiet-hours` is the sleep/dream orchestration
// step, not the mission itself.
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
  | "user-task"
  | "drain-pass"
  | "quiet-hours"
  | "staleness"
  | "profile-update"
  | "soul-update"

/** Deterministic kind order for ties and queue display. */
export const KIND_ORDER: readonly WorkKind[] = [
  "mission",
  "user-task",
  "drain-pass",
  "quiet-hours",
  "staleness",
  "profile-update",
  "soul-update",
]

/** Lower runs first. Deterministic tie-break for equal SWRR credits. */
export const WORK_PRIORITY: Readonly<Record<WorkKind, number>> = {
  mission: 0,
  "user-task": 1,
  "drain-pass": 2,
  "quiet-hours": 3,
  staleness: 4,
  "profile-update": 5,
  "soul-update": 6,
}

/** Relative SWRR service weights. A weight of 0 disables a kind. */
export type WorkWeights = Record<WorkKind, number>

export const DEFAULT_WORK_WEIGHTS: WorkWeights = {
  mission: 4,
  "user-task": 2,
  "drain-pass": 3,
  "quiet-hours": 1,
  staleness: 1,
  "profile-update": 1,
  "soul-update": 1,
}

export type SchedulerState = {
  fair: boolean
  weights: WorkWeights
  credits: Partial<Record<WorkKind, number>>
  served: Partial<Record<WorkKind, number>>
  last_kind: WorkKind | null
  updated_ms: number
}

export type WorkQueueState = {
  items: WorkItem[]
  scheduler: SchedulerState
}

export type WorkItem = {
  /** Stable dedupe key: `mission:<id>`, `drain-pass`, `quiet-hours`, `<source>:<key>`. */
  id: string
  kind: WorkKind
  /** Which producer enqueued it (`tick`, `brain-stale`, `scheduler`, …). */
  producer: string
  /** Enqueue time; preserved across ticks — FIFO order within a kind. A
   *  timeout requeue refreshes it so the item lands at the tail. */
  enqueued_ms: number
  /** Within-kind ordering hint (0–9, higher first). Only `user-task` sets it. */
  priority?: number
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

export function emptyScheduler(weights: WorkWeights = DEFAULT_WORK_WEIGHTS): SchedulerState {
  return {
    fair: true,
    weights: normalizeWeights(weights),
    credits: {},
    served: {},
    last_kind: null,
    updated_ms: 0,
  }
}

/** Accept only non-negative integer weights; unknown/invalid values fall back. */
export function normalizeWeights(
  raw: Partial<Record<string, unknown>> | undefined,
  base: WorkWeights = DEFAULT_WORK_WEIGHTS,
): WorkWeights {
  const out: WorkWeights = { ...base }
  for (const kind of KIND_ORDER) {
    const value = raw?.[kind]
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      out[kind] = value
    }
  }
  return out
}

export function isDue(item: WorkItem, nowMs: number): boolean {
  return item.not_before_ms === undefined || nowMs >= item.not_before_ms
}

/** Parse persisted work + scheduler state. A missing/corrupt file yields an
 *  empty queue. Only the v2 `{ items, scheduler }` shape is accepted. */
export async function loadWorkQueueState(file: string): Promise<WorkQueueState> {
  const text = await atomicRead(file)
  if (!text) return { items: emptyQueue(), scheduler: emptyScheduler() }
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) {
      return { items: sanitize(parsed), scheduler: emptyScheduler() }
    }
    const state = parsed as { items?: unknown; scheduler?: unknown }
    if (!Array.isArray(state.items)) {
      return { items: emptyQueue(), scheduler: emptyScheduler() }
    }
    return {
      items: sanitize(state.items),
      scheduler: sanitizeScheduler(state.scheduler),
    }
  } catch {
    return { items: emptyQueue(), scheduler: emptyScheduler() }
  }
}

/** Queue-only compatibility helper. */
export async function loadWorkQueue(file: string): Promise<WorkItem[]> {
  return (await loadWorkQueueState(file)).items
}

function sanitizeScheduler(raw: unknown): SchedulerState {
  const fallback = emptyScheduler()
  if (!raw || typeof raw !== "object") return fallback
  const value = raw as {
    fair?: unknown
    weights?: unknown
    credits?: unknown
    served?: unknown
    last_kind?: unknown
    updated_ms?: unknown
  }
  const scheduler = emptyScheduler(
    value.weights && typeof value.weights === "object"
      ? normalizeWeights(value.weights as Record<string, unknown>)
      : DEFAULT_WORK_WEIGHTS,
  )
  for (const kind of KIND_ORDER) {
    const credit = (value.credits as Record<string, unknown> | undefined)?.[kind]
    if (typeof credit === "number" && Number.isFinite(credit)) scheduler.credits[kind] = credit
    const served = (value.served as Record<string, unknown> | undefined)?.[kind]
    if (typeof served === "number" && Number.isFinite(served) && served >= 0) {
      scheduler.served[kind] = Math.floor(served)
    }
  }
  if (KIND_ORDER.includes(value.last_kind as WorkKind)) {
    scheduler.last_kind = value.last_kind as WorkKind
  }
  if (typeof value.updated_ms === "number" && Number.isFinite(value.updated_ms)) {
    scheduler.updated_ms = value.updated_ms
  }
  return scheduler
}

function sanitize(raw: unknown[]): WorkItem[] {
  const out: WorkItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Partial<WorkItem>
    if (typeof item.id !== "string" || item.id === "") continue
    const kind = normalizeKind(item.kind)
    if (!kind) continue
    out.push({
      id: item.id,
      kind,
      producer: typeof item.producer === "string" ? item.producer : "unknown",
      enqueued_ms: typeof item.enqueued_ms === "number" ? item.enqueued_ms : 0,
      ...(typeof item.priority === "number" && Number.isInteger(item.priority) && item.priority >= 0 && item.priority <= 9
        ? { priority: item.priority }
        : {}),
      ...(typeof item.not_before_ms === "number" ? { not_before_ms: item.not_before_ms } : {}),
      ...(typeof item.expires_ms === "number" ? { expires_ms: item.expires_ms } : {}),
      requeue_count: typeof item.requeue_count === "number" ? item.requeue_count : 0,
      ...(typeof item.requeue_reason === "string" ? { requeue_reason: item.requeue_reason } : {}),
      ...(item.payload && typeof item.payload === "object" ? { payload: item.payload } : {}),
    })
  }
  return out.sort((a, b) => a.enqueued_ms - b.enqueued_ms)
}

function normalizeKind(kind: unknown): WorkKind | null {
  // Legacy value from the first Phase 1 cut: the step was called "dream".
  if (kind === "dream") return "quiet-hours"
  if (
    kind === "mission" ||
    kind === "user-task" ||
    kind === "drain-pass" ||
    kind === "quiet-hours" ||
    kind === "staleness" ||
    kind === "profile-update" ||
    kind === "soul-update"
  ) {
    return kind
  }
  if (kind === undefined) return "mission"
  return null
}

/** Persist the queue + scheduler state (atomic rename); never throws. */
export async function saveWorkQueueState(
  file: string,
  queue: WorkItem[],
  scheduler: SchedulerState,
): Promise<void> {
  try {
    await atomicWrite(file, JSON.stringify({ version: 2, items: queue, scheduler }))
  } catch {
    // best-effort — a queue write must never fail a tick
  }
}

/** Legacy queue-only writer (tests, migrations). */
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

export type FairPick = {
  item: WorkItem
  kind: WorkKind
  scheduler: SchedulerState
  runnable: WorkKind[]
  credit_before: number
  credit_after: number
  total_weight: number
  previous_kind: WorkKind | null
}

/**
 * Smooth weighted round-robin over work kinds. Credits accrue only for kinds
 * with at least one due, runnable item; the winner pays the runnable weight.
 * The returned scheduler is already spent and ready to persist.
 */
export function pickFair(
  queue: WorkItem[],
  scheduler: SchedulerState,
  nowMs: number,
  isRunnable: (item: WorkItem) => boolean = () => true,
  weightsInput?: Partial<Record<string, unknown>>,
): FairPick | null {
  const weights = normalizeWeights(weightsInput ?? scheduler.weights, scheduler.weights)
  const runnable: WorkKind[] = []
  for (const kind of KIND_ORDER) {
    if (weights[kind] <= 0) continue
    if (queue.some((item) => item.kind === kind && isDue(item, nowMs) && isRunnable(item))) {
      runnable.push(kind)
    }
  }
  if (runnable.length === 0) return null

  const credits: Partial<Record<WorkKind, number>> = { ...scheduler.credits }
  for (const kind of runnable) credits[kind] = (credits[kind] ?? 0) + weights[kind]
  let kind = runnable[0]
  for (const candidate of runnable.slice(1)) {
    const dc = (credits[candidate] ?? 0) - (credits[kind] ?? 0)
    if (dc > 0 || (dc === 0 && WORK_PRIORITY[candidate] < WORK_PRIORITY[kind])) {
      kind = candidate
    }
  }
  const totalWeight = runnable.reduce((sum, item) => sum + weights[item], 0)
  const creditBefore = credits[kind] ?? 0
  credits[kind] = creditBefore - totalWeight
  const item = queue
    .filter((entry) => entry.kind === kind && isDue(entry, nowMs) && isRunnable(entry))
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        a.enqueued_ms - b.enqueued_ms ||
        a.id.localeCompare(b.id),
    )[0]
  if (!item) return null

  return {
    item,
    kind,
    scheduler: {
      fair: scheduler.fair,
      weights,
      credits,
      served: { ...scheduler.served, [kind]: (scheduler.served[kind] ?? 0) + 1 },
      last_kind: kind,
      updated_ms: nowMs,
    },
    runnable,
    credit_before: creditBefore,
    credit_after: credits[kind] ?? 0,
    total_weight: totalWeight,
    previous_kind: scheduler.last_kind,
  }
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
