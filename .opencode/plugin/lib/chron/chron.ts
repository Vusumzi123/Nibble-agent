// Chron core (docs/CHRON-SCHEDULER-PLAN.md §4.5, §4.6).
//
// Production is decoupled from execution: chron answers when a job is due and
// fires the owning handler once per occurrence. It never reads autonomy, never
// loads missions, never calls createTask, and never touches work-queue.json.
//
// A tick is lease-guarded by its own `state/chron.lock`, so production keeps
// running while the consumer drains and a second opencode instance cannot run a
// second chron. Handlers run sequentially and fail open; a thrown handler is
// logged and the next job still runs.
//
// Loaded via relative import only.
import { isAbsolute, join } from "node:path"
import { acquireOwnership, type OwnershipHandle } from "../ownership.ts"
import { readChronConfig } from "./config.ts"
import {
  createRegistry,
  type CodeJob,
  type JobHandler,
  type RegisterJob,
  type RegisterResult,
  type Registry,
} from "./registry.ts"
import { nextDue, occurrence } from "./schedule.ts"
import {
  pruneMissingJobs,
  readChronState,
  readJobFiles,
  setStateFor,
  writeChronState,
  type ChronJob,
  type ChronState,
  type JobIssue,
} from "./store.ts"
import type { ChronLog, FireEvent, HandlerResult } from "./types.ts"

export const CHRON_LOCK_FILE = "chron.lock"
export const CHRON_LOCK_TTL_MS = 60_000
export const CHRON_LOCK_REFRESH_MS = 20_000

type Listener = (event: FireEvent) => Promise<HandlerResult> | HandlerResult

type EffectiveJob = ChronJob & { handler?: JobHandler }

export type TickStatus = "fired" | "idle" | "disabled" | "lock-held" | "busy"

export type TickResult = {
  status: TickStatus
  fired: string[]
  deferred: string[]
  next_due_ms: number | null
}

export type ChronJobInfo = {
  id: string
  source: "file" | "code"
  schedule: string
  next_due_ms: number | null
  last_fired_ms: number | null
  deferred: boolean
}

export type ChronDeps = {
  directory: string
  stateDir: string
  logDir: string
  registry?: Registry
  now?: () => number
  log?: ChronLog
  acquire?: (file: string, opts?: { ttlMs?: number; refreshMs?: number }) => Promise<OwnershipHandle | null>
}

export type Chron = {
  readonly deps: ChronDeps
  register(job: RegisterJob): RegisterResult
  on(event: "fire" | `fire:${string}`, listener: Listener): () => void
  emit(id: string, payload?: unknown): Promise<void | { defer: true }>
  tick(opts?: { nowMs?: number }): Promise<TickResult>
  start(): void
  stop(): void
  list(): Promise<ChronJobInfo[]>
}

const NOOP_LOG: ChronLog = { event: () => {}, warn: () => {} }

function resolveUnder(root: string, leaf: string): string {
  return isAbsolute(leaf) ? leaf : join(root, leaf)
}

function earliestNextDue(state: ChronState): number | null {
  let earliest: number | null = null
  for (const entry of Object.values(state.jobs)) {
    const due = entry.next_due_ms
    if (due === null) continue
    if (earliest === null || due < earliest) earliest = due
  }
  return earliest
}

function mergeJobs(registry: Registry, fileJobs: ChronJob[]): Map<string, EffectiveJob> {
  const jobs = new Map<string, EffectiveJob>()
  for (const job of registry.list()) {
    jobs.set(job.id, {
      id: job.id,
      source: "code",
      schedule: job.schedule,
      schedule_raw: job.schedule_raw,
      enabled: true,
      title: job.id,
      prompt: "",
      handler: job.handler,
    })
  }
  for (const job of fileJobs) {
    if (jobs.has(job.id)) continue
    jobs.set(job.id, job)
  }
  return jobs
}

export function createChron(deps: ChronDeps): Chron {
  const directory = deps.directory
  const stateDir = deps.stateDir
  const registry = deps.registry ?? createRegistry()
  const now = deps.now ?? Date.now
  const log = deps.log ?? NOOP_LOG
  const acquire = deps.acquire ?? acquireOwnership
  const listeners = new Map<string, Set<Listener>>()
  const warned = new Set<string>()

  let ticking = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function warnOnce(key: string, message: string, err?: unknown): void {
    if (warned.has(key)) return
    warned.add(key)
    log.warn(message, err)
  }

  function reportIssues(issues: JobIssue[]): void {
    for (const issue of issues) {
      warnOnce(`${issue.path}|${issue.reason}`, `[chron] ${issue.reason}: ${issue.path}`)
    }
  }

  async function effectiveJobs(): Promise<{ jobs: Map<string, EffectiveJob>; cfg: Awaited<ReturnType<typeof readChronConfig>> }> {
    const cfg = await readChronConfig(directory)
    const { jobs: fileJobs, issues } = await readJobFiles(resolveUnder(directory, cfg.schedule_dir))
    reportIssues(issues)
    for (const job of fileJobs) {
      if (registry.get(job.id)) {
        warnOnce(`shadow|${job.id}`, `[chron] code job shadows file job: ${job.id}`)
      }
    }
    return { jobs: mergeJobs(registry, fileJobs), cfg }
  }

  type JobRun = {
    outcome: "fired" | "defer"
    info: Record<string, unknown>
    errors: string[]
    duration_ms: number
  }

  async function runJob(job: EffectiveJob, event: FireEvent): Promise<JobRun> {
    const started = now()
    let defer = false
    const info: Record<string, unknown> = {}
    const errors: string[] = []
    const call = async (label: string, fn: Listener | JobHandler): Promise<void> => {
      try {
        const result = await fn(event)
        if (result && typeof result === "object") {
          if (result.defer === true) defer = true
          if (result.info && typeof result.info === "object" && !Array.isArray(result.info)) {
            Object.assign(info, result.info)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`${label}: ${message}`)
        log.warn(`[chron] ${label} failed for ${job.id}`, err)
      }
    }
    if (job.handler) await call("handler", job.handler)
    for (const fn of [...(listeners.get("fire") ?? [])]) await call("fire listener", fn)
    for (const fn of [...(listeners.get(`fire:${job.id}`) ?? [])]) {
      await call(`fire:${job.id} listener`, fn)
    }
    return {
      outcome: defer ? "defer" : "fired",
      info,
      errors,
      duration_ms: Math.max(0, now() - started),
    }
  }

  function on(event: "fire" | `fire:${string}`, listener: Listener): () => void {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  function register(job: RegisterJob): RegisterResult {
    const result = registry.register(job)
    if (!result.ok) warnOnce(`register|${job.id}|${result.reason}`, `[chron] ${result.reason}`)
    return result
  }

  function advance(
    state: ChronState,
    job: EffectiveJob,
    occurrenceMs: number,
    atMs: number,
  ): ChronState {
    return setStateFor(state, job.id, {
      last_fired_ms: occurrenceMs,
      next_due_ms: nextDue(job.schedule, atMs, occurrenceMs),
      first_deferred_ms: null,
    })
  }

  async function tick(opts: { nowMs?: number } = {}): Promise<TickResult> {
    if (ticking) return { status: "busy", fired: [], deferred: [], next_due_ms: null }
    ticking = true
    try {
      const at = opts.nowMs ?? now()
      const { jobs, cfg } = await effectiveJobs()
      if (!cfg.enabled) return { status: "disabled", fired: [], deferred: [], next_due_ms: null }

      const lockFile = resolveUnder(stateDir, CHRON_LOCK_FILE)
      const lease = await acquire(lockFile, {
        ttlMs: CHRON_LOCK_TTL_MS,
        refreshMs: CHRON_LOCK_REFRESH_MS,
      })
      if (!lease) {
        log.event({ ts: new Date(at).toISOString(), event: "lock-held" })
        return { status: "lock-held", fired: [], deferred: [], next_due_ms: null }
      }

      try {
        const file = resolveUnder(stateDir, cfg.state_file)
        let state = await readChronState(file)
        let dirty = false

        // First sight seeds `last_fired` at now so a new job waits for its
        // next occurrence instead of firing at boot.
        const ids = new Set(jobs.keys())
        for (const job of jobs.values()) {
          const entry = state.jobs[job.id]
          if (entry && entry.last_fired_ms !== null) continue
          state = setStateFor(state, job.id, {
            last_fired_ms: at,
            next_due_ms: nextDue(job.schedule, at, at),
            first_deferred_ms: null,
          })
          dirty = true
        }

        const fired: string[] = []
        const deferred: string[] = []
        const ordered = [...jobs.values()].sort((a, b) => a.id.localeCompare(b.id))
        for (const job of ordered) {
          if (!job.enabled) continue
          const entry = state.jobs[job.id]
          if (!entry) continue
          const due = occurrence(job.schedule, at, entry.last_fired_ms)
          if (!due.due) continue

          const event: FireEvent = {
            id: job.id,
            source: job.source,
            occurrence_ms: due.occurrence_ms,
            fired_at_ms: at,
            late: due.late,
          }
          const run = await runJob(job, event)
          let firstDeferred: number | null = null
          let dropped = false
          if (run.outcome === "defer") {
            const first = entry.first_deferred_ms ?? at
            const ttlMs = Math.max(0, cfg.defer_ttl_hours) * 3_600_000
            if (ttlMs > 0 && at - first >= ttlMs) {
              dropped = true
              state = advance(state, job, due.occurrence_ms, at)
            } else {
              state = setStateFor(state, job.id, {
                ...entry,
                first_deferred_ms: first,
                next_due_ms: due.occurrence_ms,
              })
              firstDeferred = first
            }
            deferred.push(job.id)
          } else {
            state = advance(state, job, due.occurrence_ms, at)
            fired.push(job.id)
          }
          dirty = true
          log.event({
            ts: new Date(at).toISOString(),
            event: "fire",
            id: job.id,
            source: job.source,
            occurrence_ms: due.occurrence_ms,
            fired_at_ms: at,
            lag_ms: Math.max(0, at - due.occurrence_ms),
            late: due.late,
            duration_ms: run.duration_ms,
            outcome: run.errors.length > 0 ? "error" : run.outcome,
            ...(run.errors.length > 0 ? { error: run.errors.join("; ") } : {}),
            ...(Object.keys(run.info).length > 0 ? { info: run.info } : {}),
            next_due_ms: state.jobs[job.id]?.next_due_ms ?? null,
            ...(run.outcome === "defer" ? { deferred: true } : {}),
            ...(firstDeferred !== null ? { first_deferred_ms: firstDeferred } : {}),
            ...(dropped ? { defer_dropped: true } : {}),
          })
        }

        const pruned = pruneMissingJobs(state, ids, at)
        if (Object.keys(pruned.jobs).length !== Object.keys(state.jobs).length) {
          state = pruned
          dirty = true
        }
        if (dirty) await writeChronState(file, state)

        return {
          status: fired.length || deferred.length ? "fired" : "idle",
          fired,
          deferred,
          next_due_ms: earliestNextDue(state),
        }
      } finally {
        await lease.release()
      }
    } finally {
      ticking = false
    }
  }

  async function list(): Promise<ChronJobInfo[]> {
    const { jobs, cfg } = await effectiveJobs()
    const state = await readChronState(resolveUnder(stateDir, cfg.state_file))
    return [...jobs.values()]
      .map((job) => {
        const entry = state.jobs[job.id]
        return {
          id: job.id,
          source: job.source,
          schedule: job.schedule_raw,
          next_due_ms: entry?.next_due_ms ?? null,
          last_fired_ms: entry?.last_fired_ms ?? null,
          deferred: entry?.first_deferred_ms != null,
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async function emit(id: string, payload?: unknown): Promise<void | { defer: true }> {
    const { jobs } = await effectiveJobs()
    const job = jobs.get(id)
    if (!job) {
      warnOnce(`emit|${id}`, `[chron] emit for unknown job: ${id}`)
      return
    }
    if (!job.enabled) {
      warnOnce(`emit-disabled|${id}`, `[chron] emit for disabled job: ${id}`)
      return
    }
    const at = now()
    const event: FireEvent = {
      id,
      source: job.source,
      occurrence_ms: at,
      fired_at_ms: at,
      late: false,
      ...(payload === undefined ? {} : { payload }),
    }
    const run = await runJob(job, event)
    log.event({
      ts: new Date(at).toISOString(),
      event: "emit",
      id,
      source: job.source,
      fired_at_ms: at,
      duration_ms: run.duration_ms,
      outcome: run.errors.length > 0 ? "error" : run.outcome,
      ...(run.errors.length > 0 ? { error: run.errors.join("; ") } : {}),
      ...(Object.keys(run.info).length > 0 ? { info: run.info } : {}),
    })
    return run.outcome === "defer" ? { defer: true } : undefined
  }

  async function loop(): Promise<void> {
    if (!started) return
    let delayMs = 60_000
    try {
      const result = await tick()
      const cfg = await readChronConfig(directory)
      const capMs = Math.max(0, cfg.max_sleep_seconds) * 1_000
      delayMs =
        result.next_due_ms === null
          ? capMs
          : Math.max(0, Math.min(capMs, result.next_due_ms - Date.now()))
    } catch (err) {
      log.warn("[chron] tick failed", err)
    }
    if (!started) return
    timer = setTimeout(() => {
      void loop()
    }, delayMs)
    timer.unref?.()
  }

  function start(): void {
    if (started) return
    started = true
    // Defer the first wake so every plugin module registers before the clock
    // starts.
    timer = setTimeout(() => {
      void loop()
    }, 0)
    timer.unref?.()
  }

  function stop(): void {
    started = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    deps,
    register,
    on,
    emit,
    tick,
    start,
    stop,
    list,
  }
}

let singleton: Chron | null = null

export function getChron(deps?: ChronDeps): Chron {
  if (!singleton) {
    if (!deps) throw new Error("chron: getChron called before initialization")
    singleton = createChron(deps)
  }
  return singleton
}

export function resetChronForTests(): void {
  singleton?.stop()
  singleton = null
}
