// Schedule grammar and due evaluation for chron (docs/CHRON-SCHEDULER-PLAN.md
// §4.3, §4.4).
//
// A schedule is one of: an interval (`every 1h`, `30m`), a cron expression
// (`0 9 * * *`, `@daily`, `daily 09:00`, `weekly mon 09:00`), a one-shot
// (`at <ISO>`), or `manual` (push-only). Cron parsing, DST handling, and exact
// next-run math are delegated to croner; nothing here hand-rolls a cron parser.
//
// `parseSchedule` never throws. Invalid input yields `{ ok: false }` and chron
// fails closed (warn once, never fire). `occurrence` returns at most one due
// occurrence per call; missed cron occurrences coalesce to the latest one.
//
// Loaded via relative import only.
import { Cron } from "croner"

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
type Unit = keyof typeof UNIT_MS

const EVERY_RE = /^every\s+(\d+)\s*([smhd])$/i
const BARE_INTERVAL_RE = /^(\d+)\s*([smhd])$/i
const DAILY_RE = /^daily\s+(\d{1,2}):(\d{2})$/i
const WEEKLY_RE = /^weekly\s+([a-z0-9]+)\s+(\d{1,2}):(\d{2})$/i
const AT_RE = /^at\s+(.+)$/i

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

export type IntervalSchedule = { kind: "interval"; interval_ms: number; source: string }
export type CronSchedule = { kind: "cron"; pattern: string; source: string }
export type ManualSchedule = { kind: "manual"; source: string }
export type OnceSchedule = { kind: "once"; at_ms: number; source: string }

export type ScheduleSpec =
  | IntervalSchedule
  | CronSchedule
  | ManualSchedule
  | OnceSchedule

export type ParseResult =
  | { ok: true; schedule: ScheduleSpec }
  | { ok: false; reason: string }

export type Occurrence =
  | { due: false }
  | { due: true; occurrence_ms: number; late: boolean }

function cronOf(pattern: string): Cron {
  return new Cron(pattern, { paused: true, mode: "5-part" })
}

function validCron(pattern: string): string | null {
  if (!pattern.startsWith("@") && pattern.trim().split(/\s+/).length !== 5) {
    return "cron expressions must have five fields"
  }
  try {
    cronOf(pattern)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function interval(amount: number, unit: Unit, source: string): ParseResult {
  const interval_ms = amount * UNIT_MS[unit]
  if (!Number.isFinite(interval_ms) || interval_ms <= 0) {
    return { ok: false, reason: "interval must be greater than zero" }
  }
  return { ok: true, schedule: { kind: "interval", interval_ms, source } }
}

function cronPattern(hour: number, minute: number, day = "*"): string | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${minute} ${hour} * * ${day}`
}

export function parseSchedule(raw: string): ParseResult {
  const source = raw.trim()
  if (source === "") return { ok: false, reason: "empty schedule" }
  if (source.toLowerCase() === "manual") {
    return { ok: true, schedule: { kind: "manual", source } }
  }

  const every = EVERY_RE.exec(source) ?? BARE_INTERVAL_RE.exec(source)
  if (every) {
    return interval(Number(every[1]), every[2].toLowerCase() as Unit, source)
  }

  const daily = DAILY_RE.exec(source)
  if (daily) {
    const pattern = cronPattern(Number(daily[1]), Number(daily[2]))
    if (!pattern) return { ok: false, reason: `invalid time: ${source}` }
    return { ok: true, schedule: { kind: "cron", pattern, source } }
  }

  const weekly = WEEKLY_RE.exec(source)
  if (weekly) {
    const day = weekly[1].toLowerCase()
    const dayIndex = WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number])
    if (dayIndex < 0 && !/^[0-6]$/.test(day)) {
      return { ok: false, reason: `unknown weekday: ${weekly[1]}` }
    }
    const dayField = dayIndex >= 0 ? day : String(dayIndex)
    const pattern = cronPattern(Number(weekly[2]), Number(weekly[3]), dayField)
    if (!pattern) return { ok: false, reason: `invalid time: ${source}` }
    return { ok: true, schedule: { kind: "cron", pattern, source } }
  }

  const at = AT_RE.exec(source)
  if (at) {
    const at_ms = Date.parse(at[1])
    if (!Number.isFinite(at_ms)) return { ok: false, reason: `invalid date: ${at[1]}` }
    return { ok: true, schedule: { kind: "once", at_ms, source } }
  }

  const reason = validCron(source)
  if (reason) return { ok: false, reason }
  return { ok: true, schedule: { kind: "cron", pattern: source, source } }
}

// Latest cron run at or before `atMs`. croner's `previousRuns` is exclusive of
// its reference and needs a one-second cushion, so ask for two and filter.
function previousCronRuns(pattern: string, atMs: number): number[] {
  const runs = cronOf(pattern).previousRuns(2, new Date(atMs + 1_000))
  return runs.map((run) => run.getTime()).filter((run_ms) => run_ms <= atMs)
}

export function occurrence(
  schedule: ScheduleSpec,
  nowMs: number,
  lastFiredMs?: number | null,
): Occurrence {
  switch (schedule.kind) {
    case "manual":
      return { due: false }
    case "interval": {
      if (lastFiredMs == null) return { due: false }
      if (nowMs - lastFiredMs < schedule.interval_ms) return { due: false }
      const occurrence_ms = lastFiredMs + schedule.interval_ms
      return {
        due: true,
        occurrence_ms,
        late: nowMs - occurrence_ms >= schedule.interval_ms,
      }
    }
    case "cron": {
      if (lastFiredMs == null) return { due: false }
      const runs = previousCronRuns(schedule.pattern, nowMs)
      const latest = runs[0]
      if (latest === undefined || latest <= lastFiredMs) return { due: false }
      const coalesced = runs[1] !== undefined && runs[1] > lastFiredMs
      return { due: true, occurrence_ms: latest, late: coalesced }
    }
    case "once": {
      if (lastFiredMs != null && lastFiredMs >= schedule.at_ms) return { due: false }
      if (nowMs < schedule.at_ms) return { due: false }
      return {
        due: true,
        occurrence_ms: schedule.at_ms,
        late: nowMs - schedule.at_ms >= 60_000,
      }
    }
  }
}

// When chron should next wake for this job. A past result means "wake now"
// (the job is behind); chron clamps the timer. `null` means never.
export function nextDue(
  schedule: ScheduleSpec,
  nowMs: number,
  lastFiredMs?: number | null,
): number | null {
  switch (schedule.kind) {
    case "manual":
      return null
    case "interval":
      return lastFiredMs == null ? null : lastFiredMs + schedule.interval_ms
    case "cron":
      return cronOf(schedule.pattern).nextRun(new Date(nowMs))?.getTime() ?? null
    case "once":
      if (lastFiredMs != null && lastFiredMs >= schedule.at_ms) return null
      return schedule.at_ms
  }
}
