// Code-job registry (docs/CHRON-SCHEDULER-PLAN.md §4.2, §4.8).
//
// A code job is registered at plugin load and owns its action through
// `handler`. Duplicate ids never overwrite: the first registration wins and the
// later one is reported so chron can log it once. Invalid schedules fail at
// registration and never fire.
//
// Loaded via relative import only.
import { parseSchedule, type ScheduleSpec } from "./schedule.ts"
import type { FireEvent, HandlerResult } from "./types.ts"

export type JobHandler = (event: FireEvent) => Promise<HandlerResult> | HandlerResult

export type RegisterJob = {
  id: string
  schedule: string
  handler: JobHandler
}

export type CodeJob = {
  id: string
  schedule_raw: string
  schedule: ScheduleSpec
  handler: JobHandler
}

export type RegisterResult = { ok: true } | { ok: false; reason: string }

export type Registry = {
  register(job: RegisterJob): RegisterResult
  get(id: string): CodeJob | undefined
  list(): CodeJob[]
}

export function createRegistry(): Registry {
  const jobs = new Map<string, CodeJob>()
  return {
    register(job: RegisterJob): RegisterResult {
      if (jobs.has(job.id)) return { ok: false, reason: `duplicate id: ${job.id}` }
      const parsed = parseSchedule(job.schedule)
      if (!parsed.ok) return { ok: false, reason: `invalid schedule: ${parsed.reason}` }
      jobs.set(job.id, {
        id: job.id,
        schedule_raw: job.schedule,
        schedule: parsed.schedule,
        handler: job.handler,
      })
      return { ok: true }
    },
    get(id: string): CodeJob | undefined {
      return jobs.get(id)
    },
    list(): CodeJob[] {
      return [...jobs.values()]
    },
  }
}
