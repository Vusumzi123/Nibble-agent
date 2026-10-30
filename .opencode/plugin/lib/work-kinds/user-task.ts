// `user-task` work kind: one queued task file per item (user-task queue plan,
// Phase 1).
//
// The producer reads `<stateDir>/user-tasks/*.md`; the file is the per-item
// brief and the consumer mission (`.opencode/missions/user-task.md`, with
// `enqueue: item`) supplies the how-to body. Settling moves the file to
// done/blocked/failed with a `## Result` block — the task store is the only
// writer of task files, so the heartbeat still owns the queue alone.
//
// Loaded via relative import only.
import {
  HEARTBEAT_FIXED_PROMPT,
  assembleMissionBrief,
  missionContextHeader,
} from "../heartbeat.ts"
import { resumeContextBlock, type ResumePayload } from "../mission-resume.ts"
import type { Mission } from "../missions.ts"
import { MAX_REQUEUES, stallResumeItem, type WorkItem } from "../work-queue.ts"
import {
  listPendingTasks,
  pruneSettledTasks,
  readTaskSync,
  settleTask,
  type UserTask,
} from "../user-tasks.ts"
import type { ProducerCtx } from "./shared.ts"
import type { ChildRun, DispatchContext, DispatchResult, WorkKindHandler } from "./types.ts"

/** The consumer mission's id — it owns the how-to body, not the queue entry. */
export const USER_TASK_MISSION_ID = "user-task"
const PAYLOAD_REF = "task_ref"

function taskOf(item: WorkItem): string | null {
  const ref = item.payload?.[PAYLOAD_REF]
  return typeof ref === "string" && ref ? ref : null
}

function taskItem(task: UserTask, nowMs: number): WorkItem {
  return {
    id: `user-task:${task.id}`,
    kind: "user-task",
    producer: "user-tasks",
    enqueued_ms: nowMs,
    priority: task.priority,
    ...(task.expires_ms === undefined ? {} : { expires_ms: task.expires_ms }),
    requeue_count: 0,
    payload: { task_ref: task.id, title: task.title, priority: task.priority },
  }
}

/** The consumer mission gates the kind: disabled or below its `min_level`
 *  pauses the queue without touching the task files. */
export function userTaskEnabled(ctx: { missions: Mission[]; level: number }): boolean {
  const mission = ctx.missions.find((m) => m.id === USER_TASK_MISSION_ID)
  if (!mission) return true // let run() archive the task with a clear reason
  return mission.enabled && ctx.level >= mission.min_level
}

/** All pending tasks become items; the picker orders them by priority.
 *  Retention runs first so it keeps working while the kind is paused. */
export async function collectUserTasks(ctx: ProducerCtx): Promise<WorkItem[]> {
  if (!ctx.stateDir) return []
  await pruneSettledTasks(ctx.stateDir, {
    nowMs: ctx.nowMs,
    ...(ctx.userTaskRetentionDays === undefined
      ? {}
      : { retentionDays: ctx.userTaskRetentionDays }),
  })
  if (!userTaskEnabled(ctx)) return []
  const pending = await listPendingTasks(ctx.stateDir)
  return pending
    .filter((task) => !task.expires_ms || ctx.nowMs < task.expires_ms)
    .filter((task) => !ctx.queuedIds?.has(`user-task:${task.id}`))
    .map((task) => taskItem(task, ctx.nowMs))
}

export function userTaskRunnable(ctx: ProducerCtx, item: WorkItem): boolean {
  if (!ctx.stateDir || !userTaskEnabled(ctx)) return false
  const ref = taskOf(item)
  if (!ref) return false
  const task = readTaskSync(ctx.stateDir, ref)
  return task !== null && task.status === "pending"
}

/** A missing/archived task file drops the queue item instead of looping. */
export function userTaskStillDue(ctx: ProducerCtx, item: WorkItem): boolean {
  return userTaskRunnable(ctx, item)
}

function resumeBlockFor(item: WorkItem): string {
  const payload = item.payload as Partial<ResumePayload> | undefined
  if (!payload || payload.resume !== true || !payload.summary) return ""
  try {
    return resumeContextBlock(payload as ResumePayload)
  } catch {
    return ""
  }
}

function taskBlock(task: UserTask): string {
  return [
    "=== QUEUED USER TASK ===",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `priority: ${task.priority}`,
    `requested_by: ${task.requested_by}`,
    "",
    task.prompt,
    ...(task.context ? ["", "=== TASK CONTEXT ===", task.context] : []),
    "=== END QUEUED USER TASK ===",
  ].join("\n")
}

function userTaskBrief(mission: Mission, item: WorkItem, task: UserTask, ctx: DispatchContext): string | null {
  const context = missionContextHeader(
    {
      tick: ctx.tick,
      nowMs: ctx.nowMs,
      level: ctx.level,
      quiet: ctx.quiet,
      sleepStatus: ctx.digest.sleep_status,
      signals: ctx.signals,
      digestHash: ctx.digest.digest_hash,
    },
    {
      tokenBudget: ctx.autonomy.mission_token_budget,
      injectSleepState: ctx.autonomy.quiet.inject_state,
      sleepPrompts: ctx.sleepPrompts,
    },
  )
  const brief = assembleMissionBrief(mission, HEARTBEAT_FIXED_PROMPT, context, resumeBlockFor(item))
  if (!brief) return null
  return `${brief.prompt}\n\n${taskBlock(task)}`
}

type Terminal = "done" | "blocked" | "failed"

function terminalOf(run: ChildRun): Terminal {
  if (run.outcome !== "completed") return "failed"
  switch (run.result?.status) {
    case "completed":
      return "done"
    case "declined":
      return "blocked"
    default:
      return "failed"
  }
}

/** Settle the task file; a timeout first re-enqueues with a resume payload. */
async function settleTaskRun(
  ctx: DispatchContext,
  item: WorkItem,
  mission: Mission,
  task: UserTask,
  run: ChildRun,
): Promise<{ outcome: Terminal | "timeout"; requeue: WorkItem | null }> {
  const settledAt = Date.now()
  const result = {
    summary: run.summary,
    session_id: run.sessionId,
    detail: run.stopReason ? `stopped: ${run.stopReason}` : "",
  }

  if (run.outcome === "timeout") {
    if (item.requeue_count < MAX_REQUEUES) {
      const summary = await ctx.summarizeResume(mission, run)
      const requeued = stallResumeItem(item, summary.payload, settledAt)
      if (requeued) return { outcome: "timeout", requeue: requeued }
    }
    await settleTask(ctx.stateDir, task.id, "failed", { ...result, summary: run.summary || "timeout" }, settledAt)
    return { outcome: "failed", requeue: null }
  }

  const outcome = terminalOf(run)
  await settleTask(
    ctx.stateDir,
    task.id,
    outcome,
    {
      ...result,
      summary: run.summary || run.result?.reason || outcome,
      detail: outcome === "blocked" ? run.result?.reason ?? "" : result.detail,
    },
    settledAt,
  )
  return { outcome, requeue: null }
}

export async function runUserTaskItem(ctx: DispatchContext, item: WorkItem): Promise<DispatchResult> {
  const ref = taskOf(item)
  const task = ref ? readTaskSync(ctx.stateDir, ref) : null
  if (!task || task.status !== "pending") {
    return {
      executed: false,
      ledger: {
        verdict: "no_reply",
        mission: null,
        outcome: "silent",
        token_cost: 0,
        gate: "user-task",
        reason: "missing-task",
      },
    }
  }

  const mission = ctx.missions.find((m) => m.id === USER_TASK_MISSION_ID)
  if (!mission) {
    await settleTask(ctx.stateDir, task.id, "failed", { summary: "consumer mission missing" })
    return {
      executed: true,
      ledger: {
        verdict: `user-task:${task.id}`,
        mission: USER_TASK_MISSION_ID,
        outcome: "error",
        token_cost: 0,
        gate: "user-task",
        reason: "missing-mission",
        task_id: task.id,
        priority: task.priority,
      },
    }
  }

  const prompt = userTaskBrief(mission, item, task, ctx)
  if (!prompt) {
    await settleTask(ctx.stateDir, task.id, "failed", { summary: "empty brief" })
    return {
      executed: true,
      ledger: {
        verdict: `user-task:${task.id}`,
        mission: USER_TASK_MISSION_ID,
        outcome: "error",
        token_cost: 0,
        gate: "user-task",
        reason: "empty-brief",
        task_id: task.id,
      },
    }
  }

  await ctx.setPhase("dispatch")
  const run = await ctx.runChild({ mission, prompt, agent: mission.agent })
  await ctx.setPhase("post")
  const { outcome, requeue } = await settleTaskRun(ctx, item, mission, task, run)

  const failed = outcome === "failed"
  return {
    executed: true,
    session_id: run.sessionId,
    ...(requeue ? { requeue } : {}),
    ...(failed ? { mood: "mission_failure" } : {}),
    ledger: {
      verdict: `user-task:${task.id}`,
      mission: USER_TASK_MISSION_ID,
      outcome: run.outcome,
      token_cost: run.tokenCost,
      gate: "user-task",
      reason: outcome === "timeout" ? "requeued" : outcome,
      task_id: task.id,
      task_title: task.title,
      priority: task.priority,
      requeued: requeue !== null,
      ...(run.sessionId ? { session: run.sessionId } : {}),
      result_status: run.result?.status ?? (run.outcome === "completed" ? "missing" : "error"),
      ...(run.runError ? { error: run.runError } : {}),
      ...(run.stopReason ? { stop_reason: run.stopReason } : {}),
    },
  }
}

export const userTaskHandler: WorkKindHandler = {
  kind: "user-task",
  produce: collectUserTasks,
  runnable: userTaskRunnable,
  stillDue: userTaskStillDue,
  run: runUserTaskItem,
}
