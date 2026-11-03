// Legacy producer-intent reader (docs/CHRON-SCHEDULER-PLAN.md §5.1, §5.2).
//
// The file inbox is no longer a runtime rail: the SQLite importer reads it
// once on first open and moves the tree to `state/backup/pre-sqlite-<ts>/`.
// This module is the importer's reader only — producers write `queued` rows
// through `work-store.ts`.
//
// A malformed file is quarantined under `state/inbox/bad/` and never blocks the
// import.
//
// Loaded via relative import only.
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readdir, rename } from "node:fs/promises"
import { join } from "node:path"
import { atomicRead } from "../fsx.ts"
import type { WorkItem, WorkKind } from "../work-queue.ts"

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
