import { test } from "node:test"
import assert from "node:assert/strict"
import { createChildExecutor } from "./child.ts"

function fakeClient(): {
  client: any
  prompts: any[]
} {
  const prompts: any[] = []
  let prompted = false
  const before = [{ info: { id: "u_old", role: "user", time: { created: 0 } }, parts: [] }]
  const after = [
    ...before,
    { info: { id: "u_new", role: "user", time: { created: 1 } }, parts: [] },
    {
      info: {
        id: "a_new",
        role: "assistant",
        parentID: "u_new",
        finish: "stop",
        time: { created: 2, completed: 3 },
      },
      parts: [{ type: "text", text: "done" }],
    },
  ]
  return {
    prompts,
    client: {
      session: {
        async create() {
          return { data: { id: "ses_child" } }
        },
        async promptAsync(args: any) {
          prompts.push(args)
          prompted = true
          return { response: { ok: true } }
        },
        async messages() {
          return { data: prompted ? after : before }
        },
        async abort() {
          return { response: { ok: true } }
        },
      },
    },
  }
}

function executor(client: any) {
  return createChildExecutor({ client, directory: "/work", pollMs: 1 })
}

test("spawn sends the provider/model spec as the SDK model object", async () => {
  const fake = fakeClient()
  const outcome = await executor(fake.client).spawn({
    id: "summarize:ses",
    kind: "summarize",
    prompt: "summarize this",
    agent: "session-summarizer",
    model: "qwencloud/qwen3.8-flash",
    deadlineMs: 500,
  })

  assert.equal(outcome.ok, true)
  assert.deepEqual(fake.prompts[0].body.model, {
    providerID: "qwencloud",
    modelID: "qwen3.8-flash",
  })
})

test("prompt reuses the same SDK model object shape", async () => {
  const fake = fakeClient()
  const outcome = await executor(fake.client).prompt("ses_child", {
    id: "correct:ses",
    kind: "correct",
    prompt: "fix the report",
    agent: "drain-writer",
    model: "deepseek/deepseek-flash",
    deadlineMs: 500,
  })

  assert.equal(outcome.ok, true)
  assert.deepEqual(fake.prompts[0].body.model, {
    providerID: "deepseek",
    modelID: "deepseek-flash",
  })
})

test("a malformed model spec omits the field instead of sending a raw string", async () => {
  const fake = fakeClient()
  await executor(fake.client).spawn({
    id: "summarize:ses",
    kind: "summarize",
    prompt: "summarize this",
    agent: "session-summarizer",
    model: "nope",
    deadlineMs: 500,
  })

  assert.equal("model" in fake.prompts[0].body, false)
})
