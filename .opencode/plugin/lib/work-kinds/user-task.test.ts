import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTask, readPendingTask, settleTask, taskSettled, tasksRoot } from "../user-tasks.ts"
import { MAX_REQUEUES, type WorkItem } from "../work-queue.ts"
import { parseMissionFile } from "../missions.ts"
import {
  collectUserTasks,
  runUserTaskItem,
  userTaskRunnable,
  userTaskStillDue,
} from "./user-task.ts"
import type { ProducerCtx } from "./shared.ts"
import type { ChildRun, DispatchContext } from "./types.ts"

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "user-task-kind-"))
  return join(dir, ".opencode", "state")
}

const { mission: consumer } = parseMissionFile(
  "---\nid: user-task\ntitle: Run a queued task\nenqueue: item\ntimeout_minutes: 5\n---\nConsumer body.\n",
  "user-task",
)

const signals = {
  backlog_pending: 0,
  unconsumed_turns: 0,
  audit_failures: 0,
  staleness: {},
  quiet: false,
}

function producerCtx(dir: string, over: Partial<ProducerCtx> = {}): ProducerCtx {
  return {
    nowMs: 1_000,
    stateDir: dir,
    level: 3,
    quiet: false,
    signals,
    missions: [consumer],
    candidates: [],
    ...over,
  }
}

function dispatchCtx(
  dir: string,
  run: ChildRun,
  over: Partial<DispatchContext> = {},
): DispatchContext {
  return {
    tick: 1,
    nowMs: 1_000,
    level: 3,
    quiet: false,
    signals,
    digest: { digest_hash: "d1" } as any,
    missions: [consumer],
    autonomy: { mission_token_budget: "unlimited" } as any,
    ideaCfg: { enabled: false } as any,
    dir,
    stateDir: dir,
    logDir: dir,
    vaultDir: dir,
    diag: { error: () => {}, warn: () => {} } as any,
    setPhase: async () => {},
    runChild: async () => run,
    runDrain: async () => ({ ran: false, reason: "off" }) as any,
    summarizeResume: async () => ({
      payload: {
        prior_session: "ses_1",
        stopped_at: "2026-01-01T00:00:00.000Z",
        aborted: false,
        summary: "progress",
      },
      summarizer: "fallback" as const,
    }),
    recordDispatch: async () => {},
    idea: {
      storeGenerated: async () => "none",
      recordGenerated: async () => {},
      recordExpressed: async () => {},
    },
    ...over,
  }
}

const completed = (status: "completed" | "declined" | "error", summary = "ok"): ChildRun => ({
  outcome: "completed",
  tokenCost: 42,
  summary,
  sessionId: "ses_1",
  result: { status, summary },
})

const itemFor = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: `user-task:${id}`,
  kind: "user-task",
  producer: "user-tasks",
  enqueued_ms: 1,
  priority: 5,
  requeue_count: 0,
  payload: { task_ref: id, title: "T", priority: 5 },
  ...over,
})

test("collectUserTasks emits one prioritized item per pending task", async () => {
  const dir = await stateDir()
  const low = await createTask(dir, { title: "low", prompt: "p", priority: 1 }, { nowMs: 10, random: () => 0.1 })
  const high = await createTask(dir, { title: "high", prompt: "p", priority: 9 }, { nowMs: 11, random: () => 0.2 })
  assert.ok(low.ok && high.ok)

  const items = await collectUserTasks(producerCtx(dir))
  assert.deepEqual(items.map((i) => i.priority).sort(), [1, 9])
  assert.equal(items[0].kind, "user-task")
  assert.equal(items[0].payload?.task_ref, (high as any).id, "priority-first")
  assert.ok(items.some((i) => i.payload?.task_ref === (low as any).id))

  const queued = new Set(items.map((i) => i.id))
  assert.deepEqual(await collectUserTasks(producerCtx(dir, { queuedIds: queued })), [])
  assert.deepEqual(await collectUserTasks(producerCtx(dir, { nowMs: 0, stateDir: undefined })), [])
})

test("runnable/stillDue: pending file yes, missing file no", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "t", prompt: "p" })
  assert.ok(created.ok)
  const item = itemFor((created as any).id)
  const ctx = producerCtx(dir)
  assert.equal(userTaskRunnable(ctx, item), true)
  assert.equal(userTaskStillDue(ctx, item), true)

  const missing = itemFor("user-nope-x")
  assert.equal(userTaskRunnable(ctx, missing), false)
  assert.equal(userTaskStillDue(ctx, missing), false)
})

test("run: completed settles the file under done/ with a result block", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "t", prompt: "do it" })
  assert.ok(created.ok)
  const item = itemFor((created as any).id)

  const result = await runUserTaskItem(dispatchCtx(dir, completed("completed", "fixed it")), item)
  assert.equal(result.executed, true)
  assert.equal(result.ledger.reason, "done")
  assert.equal(result.ledger.task_id, (created as any).id)
  assert.equal(result.token_cost, undefined)
  assert.equal(result.ledger.token_cost, 42)
  assert.equal(result.requeue, undefined)
  assert.equal(await readPendingTask(dir, (created as any).id), null)
  assert.equal(await taskSettled(dir, (created as any).id), true)
})

test("run: a declined task is archived under blocked/", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "t", prompt: "do it" })
  const result = await runUserTaskItem(
    dispatchCtx(dir, completed("declined", "precondition missing")),
    itemFor((created as any).id),
  )
  assert.equal(result.ledger.reason, "blocked")
  assert.equal(await taskSettled(dir, (created as any).id), true)
})

test("run: a missing task file is silent, not an error", async () => {
  const dir = await stateDir()
  const result = await runUserTaskItem(dispatchCtx(dir, completed("completed")), itemFor("user-gone-x"))
  assert.equal(result.executed, false)
  assert.equal(result.ledger.reason, "missing-task")
})

test("run: a timeout requeues with a resume payload, then fails at the cap", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "t", prompt: "do it" })
  const id = (created as any).id
  const timeout: ChildRun = {
    outcome: "timeout",
    tokenCost: 10,
    summary: "partial",
    sessionId: "ses_1",
    result: null,
  }

  const first = await runUserTaskItem(dispatchCtx(dir, timeout), itemFor(id))
  assert.ok(first.requeue, "a timeout re-enqueues the same item")
  assert.equal(first.requeue!.id, `user-task:${id}`)
  assert.equal(first.requeue!.payload?.resume, true)
  assert.equal(first.requeue!.requeue_count, 1)
  assert.equal(first.ledger.reason, "requeued")
  assert.notEqual(await readPendingTask(dir, id), null, "the task stays pending while requeued")

  const exhausted = await runUserTaskItem(
    dispatchCtx(dir, timeout),
    itemFor(id, { requeue_count: MAX_REQUEUES }),
  )
  assert.equal(exhausted.requeue, undefined)
  assert.equal(exhausted.ledger.reason, "failed")
  assert.equal(await taskSettled(dir, id), true)
})

test("run: a missing consumer mission fails the task instead of looping", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "t", prompt: "do it" })
  const result = await runUserTaskItem(
    dispatchCtx(dir, completed("completed"), { missions: [] }),
    itemFor((created as any).id),
  )
  assert.equal(result.ledger.reason, "missing-mission")
  assert.equal(await taskSettled(dir, (created as any).id), true)
})

test("settleTask ignores a non-pending id, keeping the settle idempotent", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "t", prompt: "p" })
  await settleTask(dir, (created as any).id, "done")
  assert.equal(await settleTask(dir, (created as any).id, "failed"), false)
})

test("the consumer mission pauses the kind when disabled or below min_level", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "t", prompt: "p" })
  const item = itemFor((created as any).id)
  assert.equal(userTaskRunnable(producerCtx(dir, { level: 1 }), item), false, "below min_level 2")
  assert.deepEqual(await collectUserTasks(producerCtx(dir, { level: 1 })), [])

  const disabled = { ...consumer, enabled: false }
  assert.equal(userTaskRunnable(producerCtx(dir, { missions: [disabled] }), item), false)
  assert.equal(userTaskRunnable(producerCtx(dir, { missions: [] }), item), true, "missing mission runs, then fails")
})

test("collectUserTasks prunes old settled files, and retention 0 disables it", async () => {
  const dir = await stateDir()
  const now = Date.now()
  const old = new Date(now - 31 * 86_400_000)

  const pruned = await createTask(dir, { title: "old", prompt: "p" })
  await settleTask(dir, (pruned as any).id, "done")
  const prunedFile = join(tasksRoot(dir), "done", `${(pruned as any).id}.md`)
  await utimes(prunedFile, old, old)

  await collectUserTasks(producerCtx(dir, { nowMs: now }))
  await assert.rejects(readFile(prunedFile, "utf8"))

  const kept = await createTask(dir, { title: "kept", prompt: "p" })
  await settleTask(dir, (kept as any).id, "failed")
  const keptFile = join(tasksRoot(dir), "failed", `${(kept as any).id}.md`)
  await utimes(keptFile, old, old)

  await collectUserTasks(producerCtx(dir, { nowMs: now, userTaskRetentionDays: 0 }))
  await readFile(keptFile, "utf8")
})
