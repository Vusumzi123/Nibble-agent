import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChildExecutor, ChildOutcome, ChildRequest } from "../../../../drain/child.ts"
import { promptConsolidationChild, spawnConsolidationChild } from "./spawn.ts"

function outcome(request: ChildRequest, overrides: Partial<ChildOutcome> = {}): ChildOutcome {
  return {
    jobId: request.id ?? "ses_writer",
    sessionID: "ses_writer",
    phase: "complete",
    ok: true,
    started: true,
    rows: [],
    replies: [],
    late: false,
    timedOut: false,
    attempts: 1,
    tokens: 20,
    cost: 0.03,
    spawnMs: 1,
    queueMs: 2,
    runMs: 3,
    steps: 2,
    spanMs: 4,
    modelMs: 3,
    toolMs: 1,
    ...overrides,
  }
}

function fakeExecutor(result: Partial<ChildOutcome> = {}): {
  executor: ChildExecutor
  spawns: ChildRequest[]
  prompts: Array<{ sessionID: string; request: ChildRequest }>
} {
  const spawns: ChildRequest[] = []
  const prompts: Array<{ sessionID: string; request: ChildRequest }> = []
  return {
    spawns,
    prompts,
    executor: {
      async spawn(request) {
        spawns.push(request)
        return outcome(request, result)
      },
      async prompt(sessionID, request) {
        prompts.push({ sessionID, request })
        return outcome(request, result)
      },
      async abort() {},
    },
  }
}

test("spawns the writer through the executor and maps its result", async () => {
  const { executor, spawns } = fakeExecutor({
    rows: [{ info: { role: "assistant" } }],
    replies: ["second reply", "first reply"],
  })
  const result = await spawnConsolidationChild(executor, {
    directory: "/work/project-a",
    prompt: "Consolidation mode.\nbody",
    model: "test/writer",
    deadlineMs: 60_000,
  })

  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].kind, "write")
  assert.equal(spawns[0].agent, "rag-brain")
  assert.equal(spawns[0].model, "test/writer")
  assert.equal(spawns[0].prompt, "Consolidation mode.\nbody")
  assert.equal(spawns[0].deadlineMs, 60_000)

  assert.equal(result.ok, true)
  assert.equal(result.sessionID, "ses_writer")
  assert.equal(result.reply, "second reply")
  assert.deepEqual(result.replies, ["second reply", "first reply"])
  assert.equal(result.rows.length, 1)
  assert.equal(result.tokens, 20)
  assert.equal(result.cost, 0.03)
})

test("omits the model when writer_model is empty", async () => {
  const { executor, spawns } = fakeExecutor()
  await spawnConsolidationChild(executor, { directory: "/work", prompt: "x" })
  assert.equal("model" in spawns[0], false)
})

test("a timed-out writer is mapped to aborted and late", async () => {
  const { executor } = fakeExecutor({
    phase: "timeout",
    ok: false,
    timedOut: true,
    late: true,
    replies: ["late reply"],
  })
  const result = await spawnConsolidationChild(executor, { directory: "/work", prompt: "x" })
  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
  assert.equal(result.lateReply, true)
})

test("a prompt failure returns ok:false instead of throwing", async () => {
  const { executor } = fakeExecutor({
    phase: "failed",
    ok: false,
    error: "promptAsync failed",
  })
  const result = await spawnConsolidationChild(executor, { directory: "/work", prompt: "x" })
  assert.equal(result.ok, false)
  assert.equal(result.error, "promptAsync failed")
})

test("the report correction prompts the same session", async () => {
  const { executor, prompts } = fakeExecutor()
  await promptConsolidationChild(executor, "ses_writer", {
    directory: "/work",
    prompt: "call drain_report",
    model: "test/writer",
  })
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionID, "ses_writer")
  assert.equal(prompts[0].request.kind, "correct")
  assert.equal(prompts[0].request.prompt, "call drain_report")
})
