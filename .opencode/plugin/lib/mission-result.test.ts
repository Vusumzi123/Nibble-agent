import { test } from "node:test"
import assert from "node:assert/strict"

import { parseMissionResult } from "./mission-result.ts"

function toolPart(tool: string, input: unknown): unknown {
  return { type: "tool", tool, state: { input } }
}

test("parseMissionResult reads the last mission_result call", () => {
  const rows = [
    {
      parts: [
        toolPart("mission_result", { status: "completed", summary: "first" }),
        toolPart("mission_result", { status: "declined", summary: "nothing", reason: "in-sync" }),
      ],
    },
  ]
  assert.deepEqual(parseMissionResult(rows), {
    status: "declined",
    summary: "nothing",
    reason: "in-sync",
  })
})

test("parseMissionResult accepts a JSON string and an output fallback", () => {
  const asString = [{ parts: [toolPart("mission_result", JSON.stringify({ status: "completed", summary: "ok" }))] }]
  assert.deepEqual(parseMissionResult(asString), { status: "completed", summary: "ok" })

  const asOutput = [
    {
      parts: [
        {
          type: "tool",
          tool: "mission_result",
          state: { output: JSON.stringify({ status: "error", summary: "boom" }) },
        },
      ],
    },
  ]
  assert.deepEqual(parseMissionResult(asOutput), { status: "error", summary: "boom" })
})

test("parseMissionResult ignores invalid or missing calls", () => {
  assert.equal(parseMissionResult([]), null)
  assert.equal(parseMissionResult([{ parts: [{ type: "text", text: "hi" }] }]), null)
  assert.equal(
    parseMissionResult([{ parts: [toolPart("mission_result", { status: "maybe", summary: "?" })] }]),
    null,
  )
  assert.equal(parseMissionResult([{ parts: [toolPart("drain_run", { status: "completed" })] }]), null)
})
