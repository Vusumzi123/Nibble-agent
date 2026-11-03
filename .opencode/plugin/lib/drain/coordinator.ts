// Per-pass drain coordinator.
//
// One coordinator exists for the duration of a `runDrainPipe` call. It owns the
// bounded pool, the pre-launch token-budget gate, deterministic result slots,
// the per-task state machine, isolated child aborts, in-pass retry, the live
// status snapshot, and the coordinator ledger rows. It is not a daemon and
// never reschedules itself.
//
// Loaded via relative import only.
import type { DrainConfig } from "./config.ts"
import {
  createChildExecutor,
  type ChildClient,
  type ChildExecutor,
  type ChildKind,
  type ChildOutcome,
} from "./child.ts"
import type { DrainLedger } from "./ledger.ts"

export type TaskPolicy = {
  kind: ChildKind
  agent: string
  model: string
  concurrency: number
  deadlineMs: number
  /** 0 = deadline-only (no progress detector). */
  stallMs: number
  maxAttempts: number
  retry: "reuse" | "respawn"
}

export type ChildJob = {
  id: string
  kind: ChildKind
  policy: TaskPolicy
  run(
    executor: ChildExecutor,
    ctx: { attempt: number; previous?: ChildOutcome },
  ): Promise<ChildOutcome>
}

export type CoordinatorPhase = "starting" | "summarizing" | "writing" | "finishing"

export type CoordinatorTaskState = {
  id: string
  kind: ChildKind
  state: "queued" | "running" | "complete" | "failed" | "timeout" | "deferred"
  attempt: number
  session: string | null
  stall_ms: number
  started_at?: string
  finished_at?: string
  late?: boolean
  timed_out?: boolean
  error?: string
}

export type CoordinatorCounts = {
  total: number
  queued: number
  running: number
  complete: number
  failed: number
  timeout: number
  deferred: number
}

export type CoordinatorSnapshot = {
  phase: CoordinatorPhase
  outcome?: string
  started_at: string
  finished_at?: string
  tasks_updated_at: string
  counts: CoordinatorCounts
  tasks: CoordinatorTaskState[]
}

export type DrainCoordinatorDeps = {
  client: ChildClient
  directory: string
  config: DrainConfig
  passId?: string
  ledger?: DrainLedger
  status?: (snapshot: CoordinatorSnapshot) => Promise<void>
  registerChild?: (sessionID: string) => void
  unregisterChild?: (sessionID: string) => void
  onWarn?: (message: string, err?: unknown) => void
  /** Checked before every launch; a hit launches no later child. */
  budgetExhausted?: () => boolean
  now?: () => string
  /** Test seam: lower the child poll interval. */
  pollMs?: number
}

export type DrainCoordinator = {
  run(jobs: ChildJob[]): Promise<ChildOutcome[]>
  executor: ChildExecutor
  dispose(): Promise<void>
  snapshot(): CoordinatorSnapshot
}

function countTasks(tasks: CoordinatorTaskState[]): CoordinatorCounts {
  const counts: CoordinatorCounts = {
    total: tasks.length,
    queued: 0,
    running: 0,
    complete: 0,
    failed: 0,
    timeout: 0,
    deferred: 0,
  }
  for (const task of tasks) counts[task.state]++
  return counts
}

function budgetOutcome(job: ChildJob): ChildOutcome {
  return {
    jobId: job.id,
    sessionID: null,
    phase: "failed",
    ok: false,
    started: false,
    rows: [],
    replies: [],
    late: false,
    timedOut: false,
    error: "token-budget",
    errorKind: "transient",
    attempts: 0,
  }
}

function thrownOutcome(job: ChildJob, err: unknown): ChildOutcome {
  return {
    jobId: job.id,
    sessionID: null,
    phase: "failed",
    ok: false,
    started: false,
    rows: [],
    replies: [],
    late: false,
    timedOut: false,
    error: err instanceof Error ? err.message : String(err),
    errorKind: "transient",
    attempts: 0,
  }
}

function maxAttemptsFor(job: ChildJob, config: DrainConfig): number {
  const value = Number.isFinite(job.policy.maxAttempts)
    ? job.policy.maxAttempts
    : config.max_attempts
  return Math.max(1, Math.floor(value))
}

function shouldRetry(
  job: ChildJob,
  outcome: ChildOutcome,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (outcome.ok || attempt >= maxAttempts) return false
  if (job.kind === "write") {
    // A timed-out or invalid writer may already have written: retrying could
    // duplicate vault notes. Respawn only when no work could have started.
    if (outcome.timedOut) return false
    if (outcome.errorKind === "permanent") return false
    if (outcome.started) return false
    return true
  }
  if (job.kind === "correct") return false
  return true
}

export function createDrainCoordinator(deps: DrainCoordinatorDeps): DrainCoordinator {
  const now = deps.now ?? (() => new Date().toISOString())
  const startedAt = now()
  const tasks = new Map<string, CoordinatorTaskState>()
  const order: string[] = []
  let disposed = false
  let phase: CoordinatorPhase = "starting"
  let finishedAt: string | undefined

  const taskOrder = (): CoordinatorTaskState[] =>
    order.map((id) => tasks.get(id)).filter((task): task is CoordinatorTaskState => !!task)

  const snapshot = (): CoordinatorSnapshot => {
    const list = taskOrder()
    return {
      phase,
      started_at: startedAt,
      ...(finishedAt ? { finished_at: finishedAt } : {}),
      tasks_updated_at: now(),
      counts: countTasks(list),
      tasks: list.map((task) => ({ ...task })),
    }
  }

  const emit = async (): Promise<void> => {
    try {
      await deps.status?.(snapshot())
    } catch (err) {
      deps.onWarn?.("drain coordinator: status write failed", err)
    }
  }

  const ledger = async (task: CoordinatorTaskState, outcome: ChildOutcome): Promise<void> => {
    try {
      await deps.ledger?.write({
        source: "coordinator",
        outcome:
          task.state === "complete"
            ? "ok"
            : task.state === "timeout"
              ? "timeout"
              : task.state === "deferred"
                ? "skipped"
                : "error",
        pass_id: deps.passId,
        task_id: task.id,
        kind: task.kind,
        attempt: task.attempt,
        session: outcome.sessionID,
        stall_ms: task.stall_ms,
        timed_out: outcome.timedOut,
        late: outcome.late,
        wall_ms: outcome.runMs ?? null,
        error: outcome.error ?? null,
      })
    } catch {
      /* fail-open */
    }
  }

  const executor = createChildExecutor({
    client: deps.client,
    directory: deps.directory,
    ...(deps.registerChild ? { registerChild: deps.registerChild } : {}),
    ...(deps.unregisterChild ? { unregisterChild: deps.unregisterChild } : {}),
    onStart: (sessionID, request) => {
      const task = request.id ? tasks.get(request.id) : undefined
      if (task) task.session = sessionID
    },
    onEnd: (outcome) => {
      const task = tasks.get(outcome.jobId)
      if (!task) return
      task.session = outcome.sessionID
      task.late = outcome.late
      task.timed_out = outcome.timedOut
      task.error = outcome.error
    },
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
  })

  const runTask = async (job: ChildJob): Promise<ChildOutcome> => {
    const task = tasks.get(job.id)!
    const maxAttempts = maxAttemptsFor(job, deps.config)
    let previous: ChildOutcome | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (deps.budgetExhausted?.()) {
        const outcome = budgetOutcome(job)
        task.state = "deferred"
        task.attempt = attempt - 1
        task.finished_at = now()
        await emit()
        await ledger(task, outcome)
        return outcome
      }

      task.state = "running"
      task.attempt = attempt
      task.started_at = task.started_at ?? now()
      task.finished_at = undefined
      task.error = undefined
      await emit()

      let outcome: ChildOutcome
      try {
        outcome = await job.run(executor, {
          attempt,
          ...(previous ? { previous } : {}),
        })
      } catch (err) {
        outcome = thrownOutcome(job, err)
      }
      outcome.attempts = attempt
      outcome.jobId = job.id
      task.session = outcome.sessionID
      task.late = outcome.late
      task.timed_out = outcome.timedOut
      task.error = outcome.error
      task.finished_at = now()
      task.state = outcome.ok ? "complete" : outcome.timedOut ? "timeout" : "failed"
      await emit()
      await ledger(task, outcome)

      if (!shouldRetry(job, outcome, attempt, maxAttempts)) return outcome
      previous = outcome
    }

    return previous ?? budgetOutcome(job)
  }

  const run = async (jobs: ChildJob[]): Promise<ChildOutcome[]> => {
    if (jobs.length === 0) return []
    if (disposed) return jobs.map((job) => ({ ...budgetOutcome(job), error: "coordinator disposed" }))

    for (const job of jobs) {
      if (tasks.has(job.id)) continue
      tasks.set(job.id, {
        id: job.id,
        kind: job.kind,
        state: "queued",
        attempt: 0,
        session: null,
        stall_ms: job.policy.stallMs,
      })
      order.push(job.id)
    }

    const kind = jobs[0].kind
    phase = kind === "summarize" ? "summarizing" : "writing"
    await emit()

    const results: ChildOutcome[] = new Array(jobs.length)
    const concurrency = Math.max(1, Math.min(jobs.length, jobs[0].policy.concurrency || 1))
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= jobs.length) return
        results[index] = await runTask(jobs[index])
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return results
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await executor.cancelAll()
    phase = "finishing"
    finishedAt = now()
    try {
      await deps.status?.(snapshot())
    } catch (err) {
      deps.onWarn?.("drain coordinator: final status write failed", err)
    }
  }

  return { run, executor, dispose, snapshot }
}
