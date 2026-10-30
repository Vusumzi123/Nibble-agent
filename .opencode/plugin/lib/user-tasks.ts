// User-task store (user-task queue plan, Phase 1).
//
// One Markdown file per task under `<stateDir>/user-tasks/`. The queue only
// carries scheduling metadata; the file carries the instructions. `queue_add`
// writes a file and NEVER touches `work-queue.json`, so there is no lock or
// lost-update race with the heartbeat tick — the `user-task` handler ingests
// pending files on the next tick.
//
// Lifecycle (files are moved, never deleted):
//
//   user-tasks/<id>.md            status: pending
//   user-tasks/done/<id>.md       completed   (+ `## Result`)
//   user-tasks/blocked/<id>.md    declined
//   user-tasks/failed/<id>.md     error / exhausted timeout
//
// Contract: never throws. A malformed file is skipped, a missing file reads as
// absent, and a write failure is reported through the return value.
//
// Loaded via relative import only.
import { existsSync, readFileSync } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { atomicRead, atomicWrite } from "./fsx.ts"

export const USER_TASKS_DIRNAME = "user-tasks"

/** Per-field text caps enforced at creation (bytes). */
export const MAX_TASK_PROMPT_BYTES = 16 * 1024
export const MAX_TASK_CONTEXT_BYTES = 16 * 1024

/** Refuse to add work past this many pending tasks (never silently drop). */
export const MAX_PENDING_TASKS = 50

/** Archived folders covered by retention (`pending` is never pruned). */
export const TERMINAL_TASK_STATUSES: readonly Exclude<UserTaskStatus, "pending">[] = [
  "done",
  "blocked",
  "failed",
]

/** Default age before a settled task file is removed (`0` disables). */
export const TASK_RETENTION_DAYS_DEFAULT = 30

export const TASK_PRIORITY_MIN = 0
export const TASK_PRIORITY_MAX = 9
export const TASK_PRIORITY_DEFAULT = 5

export type UserTaskStatus = "pending" | "done" | "blocked" | "failed"

export type UserTask = {
  id: string
  title: string
  /** 0–9; higher runs first inside the `user-task` kind. */
  priority: number
  created_ms: number
  expires_ms?: number
  /** Creation-time dedupe token; `queue_add` scans pending tasks for it. */
  dedupe_key?: string
  requested_by: string
  status: UserTaskStatus
  /** The task prompt (the per-item brief). */
  prompt: string
  /** Optional evidence section copied from `## Context`. */
  context: string
}

export type CreateTaskInput = {
  title: string
  prompt: string
  context?: string
  priority?: number
  dedupe_key?: string
  requested_by?: string
  expires_in_hours?: number
}

export type CreateTaskResult =
  | { ok: true; id: string; path: string; priority: number; deduped?: string }
  | { ok: false; reason: string }

const ID_RE = /^user-[a-z0-9]+-[a-z0-9]+$/

// Credential shapes worth rejecting outright. Deliberately broad: a task that
// looks like a secret should be rewritten by the user, not queued.
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /(?:api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{16,}/i,
]

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text))
}

export function tasksRoot(stateDir: string): string {
  return join(stateDir, USER_TASKS_DIRNAME)
}

export function isSafeTaskId(id: string): boolean {
  return ID_RE.test(id)
}

function pendingPath(stateDir: string, id: string): string {
  return join(tasksRoot(stateDir), `${id}.md`)
}

function archivePath(stateDir: string, status: UserTaskStatus, id: string): string {
  return join(tasksRoot(stateDir), status, `${id}.md`)
}

/** `user-<epoch36>-<rand>`: monotonic-ish, unique enough for a local store. */
export function newTaskId(nowMs: number = Date.now(), random: () => number = Math.random): string {
  const stamp = Math.floor(nowMs).toString(36)
  const rand = Math.floor(random() * 0xffffff)
    .toString(36)
    .padStart(5, "0")
  return `user-${stamp}-${rand}`
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function clampPriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TASK_PRIORITY_DEFAULT
  return Math.min(TASK_PRIORITY_MAX, Math.max(TASK_PRIORITY_MIN, Math.trunc(value)))
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

// ---------------------------------------------------------------------------
// Parsing / rendering

export function renderTaskFile(task: UserTask): string {
  const fm = [
    "---",
    `id: ${task.id}`,
    `title: ${oneLine(task.title)}`,
    `priority: ${task.priority}`,
    `created_ms: ${task.created_ms}`,
    ...(task.expires_ms === undefined ? [] : [`expires_ms: ${task.expires_ms}`]),
    ...(task.dedupe_key ? [`dedupe_key: ${oneLine(task.dedupe_key)}`] : []),
    `requested_by: ${oneLine(task.requested_by)}`,
    `status: ${task.status}`,
    "---",
    "",
    task.prompt.trim(),
    ...(task.context.trim() ? ["", "## Context", "", task.context.trim()] : []),
    "",
  ]
  return fm.join("\n")
}

export type ParseTaskResult = { task: UserTask | null; problems: string[] }

/** Parse one task file. Never throws; a malformed file yields `task: null`. */
export function parseTaskFile(content: string, fallbackId: string): ParseTaskResult {
  const problems: string[] = []
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  if (!fm) return { task: null, problems: ["missing frontmatter"] }
  const body = content.slice(fm[0].length)

  const fields = new Map<string, string>()
  for (const raw of fm[1].split("\n")) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    fields.set(m[1], m[2].replace(/^["']|["']$/g, "").trim())
  }

  const id = fields.get("id") || fallbackId
  if (!isSafeTaskId(id)) return { task: null, problems: [`invalid id: ${id}`] }

  const title = fields.get("title") ?? ""
  if (!title) problems.push("missing title")

  const { prompt, context } = splitContext(body)
  if (!prompt.trim()) problems.push("empty prompt")

  const priorityRaw = fields.get("priority")
  const createdRaw = fields.get("created_ms")
  const expiresRaw = fields.get("expires_ms")
  const statusRaw = fields.get("status")

  const task: UserTask = {
    id,
    title: title || id,
    priority: clampPriority(priorityRaw === undefined ? undefined : Number(priorityRaw)),
    created_ms: createdRaw && /^\d+$/.test(createdRaw) ? Number(createdRaw) : 0,
    ...(expiresRaw && /^\d+$/.test(expiresRaw) ? { expires_ms: Number(expiresRaw) } : {}),
    ...(fields.get("dedupe_key") ? { dedupe_key: fields.get("dedupe_key")! } : {}),
    requested_by: fields.get("requested_by") || "user",
    status: isTaskStatus(statusRaw) ? statusRaw : "pending",
    prompt,
    context,
  }
  return { task, problems }
}

function isTaskStatus(value: string | undefined): value is UserTaskStatus {
  return value === "pending" || value === "done" || value === "blocked" || value === "failed"
}

function splitContext(body: string): { prompt: string; context: string } {
  const m = body.match(/^##\s+Context\s*$/im)
  if (!m || m.index === undefined) return { prompt: body.trim(), context: "" }
  return {
    prompt: body.slice(0, m.index).trim(),
    context: body.slice(m.index + m[0].length).trim(),
  }
}

// ---------------------------------------------------------------------------
// Reading

/** Sync read used by the handler's `runnable`/`stillDue` (small file, never
 *  throws). Returns null for a missing or malformed file. */
export function readTaskSync(stateDir: string, id: string): UserTask | null {
  if (!isSafeTaskId(id)) return null
  try {
    const file = pendingPath(stateDir, id)
    if (!existsSync(file)) return null
    const parsed = parseTaskFile(readFileSync(file, "utf8"), id)
    return parsed.task
  } catch {
    return null
  }
}

/** Pending tasks, newest metadata first by (priority desc, created asc, id). */
export async function listPendingTasks(stateDir: string): Promise<UserTask[]> {
  let names: string[]
  try {
    names = await readdir(tasksRoot(stateDir))
  } catch {
    return []
  }
  const out: UserTask[] = []
  for (const name of names) {
    if (!name.endsWith(".md") || name === "README.md") continue
    const id = name.slice(0, -3)
    if (!isSafeTaskId(id)) continue
    const text = await atomicRead(join(tasksRoot(stateDir), name))
    if (!text) continue
    const parsed = parseTaskFile(text, id)
    if (parsed.task && parsed.task.status === "pending") out.push(parsed.task)
  }
  return out.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.created_ms - b.created_ms ||
      a.id.localeCompare(b.id),
  )
}

export async function readPendingTask(stateDir: string, id: string): Promise<UserTask | null> {
  if (!isSafeTaskId(id)) return null
  const text = await atomicRead(pendingPath(stateDir, id))
  if (!text) return null
  const parsed = parseTaskFile(text, id)
  return parsed.task?.status === "pending" ? parsed.task : null
}

// ---------------------------------------------------------------------------
// Creating

/**
 * Write a new pending task file. Enforces the text caps, the pending-depth cap,
 * secret-shape rejection, and `dedupe_key` reuse. Never throws.
 */
export async function createTask(
  stateDir: string,
  input: CreateTaskInput,
  opts: { nowMs?: number; random?: () => number } = {},
): Promise<CreateTaskResult> {
  try {
    const title = oneLine(input.title ?? "")
    if (!title) return { ok: false, reason: "title is required" }
    if (title.length > 160) return { ok: false, reason: "title is longer than 160 characters" }

    const prompt = (input.prompt ?? "").trim()
    if (!prompt) return { ok: false, reason: "prompt is required" }
    if (utf8Length(prompt) > MAX_TASK_PROMPT_BYTES) {
      return { ok: false, reason: `prompt exceeds ${MAX_TASK_PROMPT_BYTES} bytes` }
    }
    const context = (input.context ?? "").trim()
    if (utf8Length(context) > MAX_TASK_CONTEXT_BYTES) {
      return { ok: false, reason: `context exceeds ${MAX_TASK_CONTEXT_BYTES} bytes` }
    }
    if (looksLikeSecret(prompt) || looksLikeSecret(context)) {
      return { ok: false, reason: "content looks like a credential; rewrite it without secrets" }
    }

    const dedupeKey = input.dedupe_key ? oneLine(input.dedupe_key) : ""
    const pending = await listPendingTasks(stateDir)
    if (dedupeKey) {
      const existing = pending.find((task) => task.dedupe_key === dedupeKey)
      if (existing) {
        return {
          ok: true,
          id: existing.id,
          path: pendingPath(stateDir, existing.id),
          priority: existing.priority,
          deduped: existing.id,
        }
      }
    }
    if (pending.length >= MAX_PENDING_TASKS) {
      return { ok: false, reason: `pending task cap reached (${MAX_PENDING_TASKS})` }
    }

    const nowMs = opts.nowMs ?? Date.now()
    const id = newTaskId(nowMs, opts.random)
    const hours = input.expires_in_hours
    const expiresMs =
      typeof hours === "number" && Number.isFinite(hours) && hours > 0
        ? nowMs + Math.floor(hours * 3_600_000)
        : undefined
    const task: UserTask = {
      id,
      title,
      priority: clampPriority(input.priority),
      created_ms: nowMs,
      ...(expiresMs === undefined ? {} : { expires_ms: expiresMs }),
      ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
      requested_by: oneLine(input.requested_by ?? "user") || "user",
      status: "pending",
      prompt,
      context,
    }
    await atomicWrite(pendingPath(stateDir, id), renderTaskFile(task))
    return { ok: true, id, path: pendingPath(stateDir, id), priority: task.priority }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Settling

export type SettleResult = {
  summary?: string
  detail?: string
  session_id?: string | null
}

/**
 * Move a pending task into its terminal folder with a `## Result` block. A
 * done/blocked/failed status is immutable (a second settle is a no-op). Never
 * throws; returns whether the move happened.
 */
export async function settleTask(
  stateDir: string,
  id: string,
  status: Exclude<UserTaskStatus, "pending">,
  result: SettleResult = {},
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!isSafeTaskId(id)) return false
  try {
    const text = await atomicRead(pendingPath(stateDir, id))
    if (!text) return false
    const parsed = parseTaskFile(text, id)
    if (!parsed.task || parsed.task.status !== "pending") return false

    const settled: UserTask = { ...parsed.task, status }
    const summary = oneLine(result.summary ?? "")
    const detail = (result.detail ?? "").trim()
    const resultBlock = [
      "",
      "## Result",
      "",
      `- status: ${status}`,
      `- settled_ms: ${nowMs}`,
      ...(result.session_id ? [`- session: ${result.session_id}`] : []),
      ...(summary ? [`- summary: ${summary}`] : []),
      ...(detail ? ["", detail] : []),
      "",
    ].join("\n")

    await atomicWrite(archivePath(stateDir, status, id), renderTaskFile(settled) + resultBlock)
    await rm(pendingPath(stateDir, id), { force: true })
    return true
  } catch {
    return false
  }
}

/** True once a task has been archived (any terminal status). */
export async function taskSettled(stateDir: string, id: string): Promise<boolean> {
  if (!isSafeTaskId(id)) return false
  for (const status of TERMINAL_TASK_STATUSES) {
    if (existsSync(archivePath(stateDir, status, id))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Retention

const DAY_MS = 86_400_000

/**
 * Delete settled task files older than `retentionDays` (default 30) from
 * `done/`, `blocked/`, and `failed/`. `retentionDays <= 0` disables the prune.
 *
 * Age is the file mtime: `settleTask` writes the archive at settle time, so a
 * legacy file needs no extra frontmatter field. Pending files are never
 * touched. Never throws.
 */
export async function pruneSettledTasks(
  stateDir: string,
  opts: { nowMs?: number; retentionDays?: number } = {},
): Promise<{ pruned: string[]; kept: number }> {
  const days = opts.retentionDays ?? TASK_RETENTION_DAYS_DEFAULT
  if (!Number.isFinite(days) || days <= 0) return { pruned: [], kept: 0 }
  const nowMs = opts.nowMs ?? Date.now()
  const cutoff = nowMs - days * DAY_MS
  const pruned: string[] = []
  let kept = 0

  for (const status of TERMINAL_TASK_STATUSES) {
    let entries
    try {
      entries = await readdir(join(tasksRoot(stateDir), status), { withFileTypes: true })
    } catch {
      continue // missing folder — nothing to prune
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const id = entry.name.slice(0, -3)
      if (!isSafeTaskId(id)) continue
      const file = join(tasksRoot(stateDir), status, entry.name)
      try {
        const info = await stat(file)
        if (info.mtimeMs >= cutoff) {
          kept += 1
          continue
        }
        await rm(file, { force: true })
        pruned.push(`${status}/${entry.name}`)
      } catch {
        /* one unreadable/unremovable file never blocks the rest */
      }
    }
  }
  return { pruned, kept }
}
