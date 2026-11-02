// Chron job files and durable state (docs/CHRON-SCHEDULER-PLAN.md §4.2, §4.5).
//
// Markdown jobs live in the schedule directory; the file is the schedule and
// the prompt body. State is one atomic JSON file. Everything here is total:
// a missing directory reads as empty, a malformed job is reported and skipped,
// and a malformed state file resets to empty instead of throwing.
//
// Loaded via relative import only.
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { parseFlatBlock } from "../config.ts"
import { atomicRead, atomicWrite } from "../fsx.ts"
import { parseSchedule, type ScheduleSpec } from "./schedule.ts"

export const CHRON_STATE_VERSION = 1

const JOB_KEYS = new Set(["id", "title", "schedule", "enabled", "agent"])
const JOB_SCHEMA = {
  id: "string",
  title: "string",
  schedule: "string",
  enabled: "bool",
  agent: "string",
} as const
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/

export type JobIssue = { path: string; reason: string }

export type ChronJob = {
  id: string
  source: "file" | "code"
  schedule: ScheduleSpec
  schedule_raw: string
  enabled: boolean
  title: string
  prompt: string
  agent?: string
  path?: string
}

export type ChronJobState = {
  last_fired_ms: number | null
  next_due_ms: number | null
  first_deferred_ms: number | null
}

export type ChronState = {
  version: number
  jobs: Record<string, ChronJobState>
}

function blankJobState(): ChronJobState {
  return { last_fired_ms: null, next_due_ms: null, first_deferred_ms: null }
}

export function emptyState(): ChronState {
  return { version: CHRON_STATE_VERSION, jobs: {} }
}

function stripQuotes(value: unknown): string {
  return typeof value === "string" ? value.replace(/^["']|["']$/g, "").trim() : ""
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((raw) => raw.replace(/^#+\s*/, "").trim())
    .find((raw) => raw !== "")
  return (line ?? "").slice(0, 160)
}

/** Parse one markdown job. Never throws; a malformed file yields `job: null`. */
export function parseJobFile(
  content: string,
  fallbackId: string,
  path = fallbackId,
): { job: ChronJob | null; issues: JobIssue[] } {
  const issues: JobIssue[] = []
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  if (!fm) {
    return { job: null, issues: [{ path, reason: "missing frontmatter" }] }
  }
  const body = content.slice(fm[0].length).trim()
  if (!body) issues.push({ path, reason: "empty prompt body" })

  const wrapped =
    "fm:\n" +
    fm[1]
      .split("\n")
      .map((line) => "  " + line)
      .join("\n") +
    "\n"
  const parsed = parseFlatBlock(wrapped, "fm", {
    knownKeys: JOB_KEYS,
    schema: JOB_SCHEMA,
  })

  const idRaw = stripQuotes(parsed.id)
  const id = idRaw || fallbackId
  if (!ID_RE.test(id)) issues.push({ path, reason: `invalid id: ${id}` })

  const schedule_raw = stripQuotes(parsed.schedule)
  if (!schedule_raw) issues.push({ path, reason: "missing schedule" })
  const parsedSchedule = schedule_raw ? parseSchedule(schedule_raw) : null
  if (parsedSchedule && !parsedSchedule.ok) {
    issues.push({ path, reason: `invalid schedule: ${parsedSchedule.reason}` })
  }

  const title = stripQuotes(parsed.title) || firstLine(body) || id
  const agent = stripQuotes(parsed.agent)
  const job: ChronJob = {
    id,
    source: "file",
    schedule: parsedSchedule?.ok ? parsedSchedule.schedule : { kind: "manual", source: schedule_raw },
    schedule_raw,
    enabled: parsed.enabled !== false,
    title,
    prompt: body,
    ...(agent ? { agent } : {}),
    path,
  }

  const fatal = !parsedSchedule?.ok || !body || !ID_RE.test(id)
  return { job: fatal ? null : job, issues }
}

/** Read every `*.md` job file, first id wins. Missing directory is empty. */
export async function readJobFiles(
  scheduleDir: string,
): Promise<{ jobs: ChronJob[]; issues: JobIssue[] }> {
  let names: string[]
  try {
    names = await readdir(scheduleDir)
  } catch {
    return { jobs: [], issues: [] }
  }

  const jobs: ChronJob[] = []
  const issues: JobIssue[] = []
  const seen = new Set<string>()
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const path = join(scheduleDir, name)
    const parsed = parseJobFile(await atomicRead(path), name.slice(0, -3), path)
    issues.push(...parsed.issues)
    if (!parsed.job) continue
    if (seen.has(parsed.job.id)) {
      issues.push({ path, reason: `duplicate id: ${parsed.job.id}` })
      continue
    }
    seen.add(parsed.job.id)
    jobs.push(parsed.job)
  }
  return { jobs, issues }
}

function coerceTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Read the state file. Missing, malformed, or old-version input reads empty. */
export async function readChronState(file: string): Promise<ChronState> {
  try {
    const parsed = JSON.parse(await atomicRead(file)) as Partial<ChronState>
    if (!parsed || parsed.version !== CHRON_STATE_VERSION || typeof parsed.jobs !== "object") {
      return emptyState()
    }
    const jobs: Record<string, ChronJobState> = {}
    for (const [id, raw] of Object.entries(parsed.jobs ?? {})) {
      const value = raw as Partial<ChronJobState> | null
      if (!value || typeof value !== "object") continue
      jobs[id] = {
        last_fired_ms: coerceTime(value.last_fired_ms),
        next_due_ms: coerceTime(value.next_due_ms),
        first_deferred_ms: coerceTime(value.first_deferred_ms),
      }
    }
    return { version: CHRON_STATE_VERSION, jobs }
  } catch {
    return emptyState()
  }
}

export async function writeChronState(file: string, state: ChronState): Promise<void> {
  await atomicWrite(file, JSON.stringify(state, null, 2) + "\n")
}

export function stateFor(state: ChronState, id: string): ChronJobState {
  return state.jobs[id] ?? blankJobState()
}

export function setStateFor(
  state: ChronState,
  id: string,
  next: ChronJobState,
): ChronState {
  return { ...state, jobs: { ...state.jobs, [id]: next } }
}

/** Drop entries for jobs that no longer exist after `retainMs` of silence. */
export function pruneMissingJobs(
  state: ChronState,
  liveIds: Set<string>,
  nowMs: number,
  retainMs = 30 * 86_400_000,
): ChronState {
  const jobs: Record<string, ChronJobState> = {}
  for (const [id, entry] of Object.entries(state.jobs)) {
    if (liveIds.has(id)) {
      jobs[id] = entry
      continue
    }
    const lastActivity =
      entry.last_fired_ms ?? entry.next_due_ms ?? entry.first_deferred_ms ?? 0
    if (nowMs - lastActivity < retainMs) jobs[id] = entry
  }
  return { ...state, jobs }
}
