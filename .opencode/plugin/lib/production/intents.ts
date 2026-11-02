// Durable producer intents (docs/CHRON-SCHEDULER-PLAN.md §5.1, §5.2).
//
// Producers write one JSON file per intent under `state/inbox/<producer>/` and
// never touch work-queue.json. The consumer merges the inbox under its lease:
// validate, dedupe by id, prune expired, accept only up to the free capacity,
// save the queue with the checked writer, then delete the consumed files.
//
// A malformed file is quarantined under `state/inbox/bad/` and never blocks the
// merge. A file whose work is not yet durable in the queue stays in place for
// the next session.
//
// Loaded via relative import only.
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { atomicRead, atomicWrite } from "../fsx.ts"
import {
  MAX_QUEUE_DEPTH,
  enqueueWithinCapacity,
  saveWorkQueueState,
  type SchedulerState,
  type WorkItem,
  type WorkKind,
} from "../work-queue.ts"

export const INBOX_DIRNAME = "inbox"
export const INTENT_VERSION = 1

const ID_MAX = 200

export type Intent = {
  version: number
  id: string
  kind: WorkKind
  producer: string
  enqueued_ms: number
  priority?: number
  expires_ms?: number
  payload?: Record<string, unknown>
}

export type IntentRecord = { intent: Intent; path: string }
export type BadIntent = { path: string; reason: string }
export type IntentReadResult = { intents: IntentRecord[]; bad: BadIntent[] }

export type WriteIntentInput = {
  id: string
  kind: WorkKind
  priority?: number
  expires_ms?: number
  payload?: Record<string, unknown>
  enqueued_ms?: number
}

export type WriteIntentResult =
  | { ok: true; path: string; deduped: boolean }
  | { ok: false; reason: string }

const WORK_KINDS = new Set<WorkKind>([
  "mission",
  "user-task",
  "drain-pass",
  "staleness",
  "profile-update",
  "soul-update",
])

export function isWorkKind(value: unknown): value is WorkKind {
  return typeof value === "string" && WORK_KINDS.has(value as WorkKind)
}

function safeSegment(value: string, max = 80): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
  return cleaned || "x"
}

function idHash(id: string): string {
  return createHash("sha1").update(id).digest("hex").slice(0, 10)
}

export function intentPath(
  stateDir: string,
  producer: string,
  id: string,
  inboxDir: string = INBOX_DIRNAME,
): string {
  return join(
    stateDir,
    inboxDir,
    safeSegment(producer),
    `${safeSegment(id)}.${idHash(id)}.json`,
  )
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeIntent(raw: unknown): { intent: Intent } | { reason: string } {
  if (!raw || typeof raw !== "object") return { reason: "not an object" }
  const value = raw as Partial<Intent>
  if (value.version !== INTENT_VERSION) return { reason: `unsupported version: ${String(value.version)}` }
  if (typeof value.id !== "string" || value.id.trim() === "") return { reason: "missing id" }
  if (value.id.length > ID_MAX) return { reason: "id is too long" }
  if (!isWorkKind(value.kind)) return { reason: `invalid kind: ${String(value.kind)}` }
  if (typeof value.producer !== "string" || value.producer.trim() === "") {
    return { reason: "missing producer" }
  }
  const enqueued_ms = asNumber(value.enqueued_ms)
  if (enqueued_ms === undefined) return { reason: "missing enqueued_ms" }
  const priority = asNumber(value.priority)
  if (
    value.priority !== undefined &&
    (priority === undefined || !Number.isInteger(priority) || priority < 0 || priority > 9)
  ) {
    return { reason: "priority must be an integer 0-9" }
  }
  const expires_ms = asNumber(value.expires_ms)
  if (value.expires_ms !== undefined && expires_ms === undefined) {
    return { reason: "expires_ms must be a number" }
  }
  if (
    value.payload !== undefined &&
    (value.payload === null || typeof value.payload !== "object" || Array.isArray(value.payload))
  ) {
    return { reason: "payload must be an object" }
  }
  return {
    intent: {
      version: INTENT_VERSION,
      id: value.id,
      kind: value.kind,
      producer: value.producer,
      enqueued_ms,
      ...(priority === undefined ? {} : { priority }),
      ...(expires_ms === undefined ? {} : { expires_ms }),
      ...(value.payload === undefined ? {} : { payload: value.payload }),
    },
  }
}

async function quarantine(inboxDir: string, path: string): Promise<string> {
  const badDir = join(inboxDir, "bad")
  await mkdir(badDir, { recursive: true })
  const target = join(badDir, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.json`)
  await rename(path, target)
  return target
}

/** Read every inbox file. Invalid files are moved to `inbox/bad/`. */
export async function readIntents(
  stateDir: string,
  inboxDirName: string = INBOX_DIRNAME,
): Promise<IntentReadResult> {
  const inboxDir = join(stateDir, inboxDirName)
  let entries
  try {
    entries = await readdir(inboxDir, { withFileTypes: true })
  } catch {
    return { intents: [], bad: [] }
  }

  const intents: IntentRecord[] = []
  const bad: BadIntent[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "bad") continue
    const producerDir = join(inboxDir, entry.name)
    let files: string[]
    try {
      files = await readdir(producerDir)
    } catch {
      continue
    }
    for (const name of files.filter((n) => n.endsWith(".json")).sort()) {
      const path = join(producerDir, name)
      let raw: unknown
      try {
        raw = JSON.parse(await atomicRead(path))
      } catch {
        bad.push({ path, reason: "invalid JSON" })
        await quarantine(inboxDir, path).catch(() => {})
        continue
      }
      const parsed = normalizeIntent(raw)
      if ("reason" in parsed) {
        bad.push({ path, reason: parsed.reason })
        await quarantine(inboxDir, path).catch(() => {})
        continue
      }
      intents.push({ intent: parsed.intent, path })
    }
  }

  intents.sort(
    (a, b) =>
      (b.intent.priority ?? 0) - (a.intent.priority ?? 0) ||
      a.intent.enqueued_ms - b.intent.enqueued_ms ||
      a.intent.id.localeCompare(b.intent.id),
  )
  return { intents, bad }
}

/** Write one intent file. An existing file for the same id wins (deduped). */
export async function writeIntent(
  stateDir: string,
  producer: string,
  input: WriteIntentInput,
  opts: { inboxDir?: string } = {},
): Promise<WriteIntentResult> {
  if (!input.id || input.id.length > ID_MAX) return { ok: false, reason: "invalid id" }
  if (!isWorkKind(input.kind)) return { ok: false, reason: `invalid kind: ${String(input.kind)}` }
  if (!producer.trim()) return { ok: false, reason: "missing producer" }

  const path = intentPath(stateDir, producer, input.id, opts.inboxDir)
  if (existsSync(path)) return { ok: true, path, deduped: true }

  const priority =
    typeof input.priority === "number" &&
    Number.isInteger(input.priority) &&
    input.priority >= 0 &&
    input.priority <= 9
      ? input.priority
      : undefined
  const expires_ms = asNumber(input.expires_ms)
  const intent: Intent = {
    version: INTENT_VERSION,
    id: input.id,
    kind: input.kind,
    producer,
    enqueued_ms: asNumber(input.enqueued_ms) ?? Date.now(),
    ...(priority === undefined ? {} : { priority }),
    ...(expires_ms === undefined ? {} : { expires_ms }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  }
  try {
    await atomicWrite(path, JSON.stringify(intent, null, 2) + "\n")
    return { ok: true, path, deduped: false }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function toWorkItem(intent: Intent): WorkItem {
  return {
    id: intent.id,
    kind: intent.kind,
    producer: intent.producer,
    enqueued_ms: intent.enqueued_ms,
    requeue_count: 0,
    ...(intent.priority === undefined ? {} : { priority: intent.priority }),
    ...(intent.expires_ms === undefined ? {} : { expires_ms: intent.expires_ms }),
    ...(intent.payload === undefined ? {} : { payload: intent.payload }),
  }
}

export function pruneExpired(queue: WorkItem[], nowMs: number): WorkItem[] {
  return queue.filter((item) => item.expires_ms === undefined || nowMs < item.expires_ms)
}

export type IntentMergePlan = {
  queue: WorkItem[]
  accepted: IntentRecord[]
  duplicates: IntentRecord[]
  expired: IntentRecord[]
  rejected: IntentRecord[]
}

/** Plan the merge without writing or deleting anything. */
export function planIntentMerge(
  queue: WorkItem[],
  records: IntentRecord[],
  nowMs: number,
): IntentMergePlan {
  const pruned = pruneExpired(queue, nowMs)
  const ids = new Set(pruned.map((item) => item.id))
  const accepted: IntentRecord[] = []
  const duplicates: IntentRecord[] = []
  const expired: IntentRecord[] = []

  for (const record of records) {
    const { intent } = record
    if (intent.expires_ms !== undefined && intent.expires_ms <= nowMs) {
      expired.push(record)
      continue
    }
    if (ids.has(intent.id)) {
      duplicates.push(record)
      continue
    }
    ids.add(intent.id)
    accepted.push(record)
  }

  const free = Math.max(0, MAX_QUEUE_DEPTH - pruned.length)
  const fitting = accepted.slice(0, free)
  const rejected = accepted.slice(free)
  const merged = enqueueWithinCapacity(
    pruned,
    fitting.map((record) => toWorkItem(record.intent)),
  ).queue
  return { queue: merged, accepted: fitting, duplicates, expired, rejected }
}

export type MergeIntentOptions = {
  stateDir: string
  inboxDir?: string
  queueFile: string
  queue: WorkItem[]
  scheduler: SchedulerState
  nowMs: number
  save?: (file: string, queue: WorkItem[], scheduler: SchedulerState) => Promise<boolean>
}

export type MergeIntentReport = IntentMergePlan & {
  bad: BadIntent[]
  saved: boolean
  deleted: string[]
}

/**
 * Merge the inbox into the queue and persist it. Accepted files are deleted
 * only after a successful save; on failure they stay for the next session.
 * Duplicates and expired files are redundant, so they are removed either way.
 */
export async function mergeIntents(opts: MergeIntentOptions): Promise<MergeIntentReport> {
  const { intents, bad } = await readIntents(opts.stateDir, opts.inboxDir)
  const plan = planIntentMerge(opts.queue, intents, opts.nowMs)
  const save = opts.save ?? saveWorkQueueState
  let saved = false
  try {
    saved = await save(opts.queueFile, plan.queue, opts.scheduler)
  } catch {
    saved = false
  }

  const removable = saved
    ? [...plan.accepted, ...plan.duplicates, ...plan.expired]
    : [...plan.duplicates, ...plan.expired]
  const deleted: string[] = []
  for (const record of removable) {
    try {
      await unlink(record.path)
      deleted.push(record.path)
    } catch {
      /* already gone */
    }
  }

  return { ...plan, bad, saved, deleted }
}
