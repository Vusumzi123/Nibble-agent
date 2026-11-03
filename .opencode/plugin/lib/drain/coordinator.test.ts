import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DRAIN } from "./config.ts"
import { createDrainCoordinator, type ChildJob, type TaskPolicy } from "./coordinator.ts"
import { createDrainLedger, DRAIN_LEDGER_FILE } from "./ledger.ts"

function outcome(
  jobId: string,
  overrides: Partial<Awaited<ReturnType<ChildJob["run"]>>> = {},
): Awaited<ReturnType<ChildJob["run"]>> {
  return {
    jobId,
    sessionID: null,
    phase: "complete",
    ok: true,
    started: true,
    rows: [],
    replies: [],
    late: false,
    timedOut: false,
    attempts: 1,
    ...overrides,
  }
}

function policy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return {
    kind: "summarize",
    agent: "session-summarizer",
    model: "",
    concurrency: 1,
    deadlineMs: 100,
    stallMs: 0,
    maxAttempts: 1,
    retry: "respawn",
    ...overrides,
  }
}

function job(
  id: string,
  run: ChildJob["run"],
  overrides: Partial<TaskPolicy> = {},
): ChildJob {
  return { id, kind: overrides.kind ?? "summarize", policy: policy({ kind: "summarize", ...overrides }), run }
}

function fakeClient(): {
  client: any
  aborts: string[]
  prompts: string[]
  rows: Map<string, unknown[]>
} {
  const aborts: string[] = []
  const prompts: string[] = []
  const rows = new Map<string, unknown[]>()
  let next = 0
  return {
    aborts,
    prompts,
    rows,
    client: {
      session: {
        async create() {
          const id = `ses_${++next}`
          rows.set(id, [])
          return { data: { id } }
        },
        async promptAsync(args: any) {
          const id = args.path.id as string
          prompts.push(id)
          const at = Date.now()
          rows.set(id, [
            { info: { id: `u_${id}`, role: "user", time: { created: at } }, parts: [] },
            {
              info: {
                id: `a_${id}`,
                role: "assistant",
                parentID: `u_${id}`,
                time: { created: at + 1 },
              },
              parts: [{ type: "text", text: "working" }],
            },
          ])
          return { response: { ok: true } }
        },
        async messages(args: any) {
          return { data: rows.get(args.path.id as string) ?? [] }
        },
        async abort(args: any) {
          aborts.push(args.path.id as string)
          return { response: { ok: true } }
        },
      },
    },
  }
}

async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

test("create and dispose are idempotent and write a final snapshot", async () => {
  const fake = fakeClient()
  const snapshots: unknown[] = []
  const coordinator = createDrainCoordinator({
    client: fake.client,
    directory: "/work",
    config: DEFAULT_DRAIN,
    passId: "pass-1",
    status: async (snapshot) => {
      snapshots.push(snapshot)
    },
  })

  await coordinator.dispose()
  await coordinator.dispose()

  assert.ok(snapshots.length >= 1)
  assert.equal(coordinator.snapshot().phase, "finishing")
  assert.equal(coordinator.snapshot().finished_at !== undefined, true)
})

test("one stalled child does not abort its siblings and results keep their slots", async () => {
  const fake = fakeClient()
  const coordinator = createDrainCoordinator({
    client: fake.client,
    directory: "/work",
    config: DEFAULT_DRAIN,
  })

  const results = await coordinator.run([
    job("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return outcome("slow", { ok: false, phase: "timeout", timedOut: true, error: "timeout" })
    }),
    job("fast", async () => outcome("fast")),
  ])

  assert.deepEqual(results.map((result) => result.ok), [false, true])
  assert.equal(results[0].timedOut, true)
  const snapshot = coordinator.snapshot()
  assert.equal(snapshot.tasks[0].state, "timeout")
  assert.equal(snapshot.tasks[1].state, "complete")
  await coordinator.dispose()
})

test("a summary task respawns and a writer only retries when nothing started", async () => {
  const fake = fakeClient()
  const coordinator = createDrainCoordinator({
    client: fake.client,
    directory: "/work",
    config: DEFAULT_DRAIN,
  })

  let summaryAttempts = 0
  const summarize = job(
    "sum-1",
    async () => {
      summaryAttempts++
      return summaryAttempts === 1
        ? outcome("sum-1", { ok: false, phase: "failed", error: "parse" })
        : outcome("sum-1")
    },
    { maxAttempts: 2, retry: "respawn" },
  )
  const [summary] = await coordinator.run([summarize])
  assert.equal(summary.ok, true)
  assert.equal(summaryAttempts, 2)

  let writerAttempts = 0
  let sawPrevious = false
  const writer = job(
    "write-1",
    async (_executor, ctx) => {
      writerAttempts++
      if (ctx.attempt === 2) sawPrevious = !!ctx.previous
      return writerAttempts === 1
        ? outcome("write-1", { ok: false, phase: "failed", started: false, error: "create" })
        : outcome("write-1")
    },
    { kind: "write", maxAttempts: 2, retry: "reuse" },
  )
  const [write] = await coordinator.run([writer])
  assert.equal(write.ok, true)
  assert.equal(writerAttempts, 2)
  assert.equal(sawPrevious, true)

  let stalledAttempts = 0
  const stalled = job(
    "write-2",
    async () => {
      stalledAttempts++
      return outcome("write-2", { ok: false, phase: "timeout", timedOut: true, error: "timeout" })
    },
    { kind: "write", maxAttempts: 3, retry: "reuse" },
  )
  const [stalledResult] = await coordinator.run([stalled])
  assert.equal(stalledResult.ok, false)
  assert.equal(stalledAttempts, 1, "a writer hard stall ends the unit")
  await coordinator.dispose()
})

test("a budget stop launches no later child", async () => {
  const fake = fakeClient()
  let started = 0
  const coordinator = createDrainCoordinator({
    client: fake.client,
    directory: "/work",
    config: DEFAULT_DRAIN,
    budgetExhausted: () => started > 0,
  })

  const calls: string[] = []
  const results = await coordinator.run([
    job("first", async () => {
      calls.push("first")
      started++
      return outcome("first")
    }),
    job("second", async () => {
      calls.push("second")
      return outcome("second")
    }),
  ])

  assert.deepEqual(calls, ["first"])
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.equal(results[1].error, "token-budget")
  assert.equal(coordinator.snapshot().tasks[1].state, "deferred")
  await coordinator.dispose()
})

test("dispose aborts a straggler and settles its observer", async () => {
  const fake = fakeClient()
  const coordinator = createDrainCoordinator({
    client: fake.client,
    directory: "/work",
    config: DEFAULT_DRAIN,
  })

  const running = coordinator.run([
    job(
      "stuck",
      async (executor) =>
        executor.spawn({
          id: "stuck",
          kind: "write",
          prompt: "write",
          deadlineMs: 60_000,
        }),
      { kind: "write" },
    ),
  ])

  await waitUntil(() => fake.prompts.length === 1, "prompt sent")
  await coordinator.dispose()
  const [result] = await running

  assert.equal(result.timedOut, true)
  assert.deepEqual(fake.aborts, ["ses_1"])
})

test("coordinator transitions reach the status callback and the ledger", async () => {
  const fake = fakeClient()
  const dir = await mkdtemp(join(tmpdir(), "drain-coordinator-"))
  const ledger = createDrainLedger({ logDir: dir })
  const snapshots: any[] = []
  const coordinator = createDrainCoordinator({
    client: fake.client,
    directory: "/work",
    config: DEFAULT_DRAIN,
    passId: "pass-7",
    ledger,
    status: async (snapshot) => {
      snapshots.push(snapshot)
    },
  })

  await coordinator.run([job("one", async () => outcome("one"))])
  await coordinator.dispose()
  await ledger.flush()

  assert.equal(snapshots[0].phase, "starting")
  assert.equal(snapshots[0].counts.queued, 1)
  assert.equal(snapshots[1].phase, "summarizing")
  assert.equal(snapshots.at(-1)?.tasks[0].state, "complete")

  const lines = (await readFile(join(dir, DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const row = lines.find((line) => line.source === "coordinator")
  assert.equal(row.task_id, "one")
  assert.equal(row.outcome, "ok")
  assert.equal(row.pass_id, "pass-7")
})
