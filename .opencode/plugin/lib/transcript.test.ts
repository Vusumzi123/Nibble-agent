import assert from "node:assert/strict"
import { test } from "node:test"

import { sessionAccounting } from "./transcript.ts"

test("sessionAccounting reports model, tool, and span time", () => {
  const rows = [
    {
      info: {
        role: "assistant",
        id: "a1",
        time: { created: 1000, completed: 1400 },
        tokens: { input: 10, output: 2 },
      },
      parts: [
        { type: "tool", state: { time: { start: 1400, end: 1600 } } },
        { type: "text", text: "first" },
      ],
    },
    {
      info: {
        role: "assistant",
        id: "a2",
        time: { created: 1800, completed: 2000 },
        tokens: { input: 3, output: 1 },
      },
      parts: [{ type: "text", text: "second" }],
    },
  ]

  const acct = sessionAccounting(rows)

  assert.equal(acct.assistantSteps, 2)
  assert.equal(acct.toolCalls, 1)
  assert.equal(acct.modelMs, 600, "400 + 200 ms of assistant generation")
  assert.equal(acct.spanMs, 1000, "first start -> last completion")
  assert.equal(acct.toolMs, 200)
  assert.equal(acct.inputTokens, 13)
  assert.equal(acct.outputTokens, 3)
})

test("sessionAccounting leaves timings null when rows carry no time", () => {
  const acct = sessionAccounting([
    { info: { role: "assistant", id: "a1" }, parts: [] },
  ])

  assert.equal(acct.spanMs, null)
  assert.equal(acct.modelMs, null)
  assert.equal(acct.toolMs, null)
})

test("sessionAccounting dedupes a repeated assistant row before counting time", () => {
  const row = {
    info: { role: "assistant", id: "a1", time: { created: 10, completed: 60 } },
    parts: [{ type: "tool", state: { time: { start: 60, end: 90 } } }],
  }

  const acct = sessionAccounting([row, row])

  assert.equal(acct.assistantSteps, 1)
  assert.equal(acct.modelMs, 50)
  assert.equal(acct.toolMs, 30)
  assert.equal(acct.spanMs, 50)
})
