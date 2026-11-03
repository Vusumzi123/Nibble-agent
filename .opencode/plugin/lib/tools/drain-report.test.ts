import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DRAIN_REPORT_TOOL,
  parseDrainReport,
  validateDrainReport,
} from "../memory/providers/builtin/brain/report.ts"
import { createDrainReportTool } from "./drain-report.ts"

function toolCall(input: unknown): unknown {
  return [
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: DRAIN_REPORT_TOOL, state: { input } }],
    },
  ]
}

test("a complete mixed report is valid and normalizes #n and n", () => {
  const report = validateDrainReport({
    item_count: 3,
    consolidated: ["#1", 3],
    skipped: ["2"],
  })
  assert.equal(report.valid, true)
  assert.deepEqual(report.consolidated, [1, 3])
  assert.deepEqual(report.skipped, [2])
  assert.deepEqual(report.missing, [])
})

test("duplicate labels in one list or across both lists are rejected", () => {
  const same = validateDrainReport({
    item_count: 2,
    consolidated: ["#1", "#1"],
    skipped: ["#2"],
  })
  assert.equal(same.valid, false)
  assert.deepEqual(same.duplicates, [1])

  const across = validateDrainReport({
    item_count: 2,
    consolidated: ["#1", "#2"],
    skipped: ["#2"],
  })
  assert.equal(across.valid, false)
  assert.deepEqual(across.duplicates, [2])
})

test("unknown and missing labels block a complete report", () => {
  const unknown = validateDrainReport({
    item_count: 2,
    consolidated: ["#1", "#9"],
    skipped: [],
  })
  assert.equal(unknown.valid, false)
  assert.deepEqual(unknown.unknown, [9])
  assert.equal(unknown.error, "unknown labels")

  const missing = validateDrainReport({
    item_count: 3,
    consolidated: ["#1"],
    skipped: [],
  })
  assert.equal(missing.valid, false)
  assert.deepEqual(missing.missing, [2, 3])
  assert.equal(missing.error, "missing labels")
})

test("partial allows missing labels but not duplicates or unknown labels", () => {
  const partial = validateDrainReport({
    item_count: 4,
    consolidated: ["#1", "#2"],
    skipped: [],
    partial: true,
  })
  assert.equal(partial.valid, true)
  assert.deepEqual(partial.missing, [3, 4])

  const bad = validateDrainReport({
    item_count: 4,
    consolidated: ["#1", "#1", "#9"],
    skipped: [],
    partial: true,
  })
  assert.equal(bad.valid, false)
  assert.deepEqual(bad.duplicates, [1])
  assert.deepEqual(bad.unknown, [9])
})

test("an empty or malformed report is never valid", () => {
  assert.equal(validateDrainReport({ item_count: 0, consolidated: [], skipped: [] }).valid, false)
  assert.equal(validateDrainReport("not json").valid, false)
  assert.equal(validateDrainReport({ consolidated: ["#1"], skipped: [] }).valid, false)
  assert.equal(
    validateDrainReport({ item_count: 2, consolidated: ["nope"], skipped: [] }).valid,
    false,
  )
})

test("the coordinator's expected count overrides the declared item_count", () => {
  const report = validateDrainReport(
    { item_count: 99, consolidated: ["#1", "#2"], skipped: [] },
    2,
  )
  assert.equal(report.valid, true)
  assert.equal(report.itemCount, 2)
})

test("the tool returns a structured correction payload on failure", async () => {
  const tool = createDrainReportTool()
  const result = JSON.parse(
    await (tool as any).execute({
      item_count: 3,
      consolidated: ["#1"],
      skipped: [],
    }),
  )
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, [2, 3])
  assert.deepEqual(result.valid_labels, ["#1", "#2", "#3"])
})

test("the tool confirms a valid report", async () => {
  const tool = createDrainReportTool()
  const result = JSON.parse(
    await (tool as any).execute({
      item_count: 2,
      consolidated: ["#1", 2],
      skipped: [],
    }),
  )
  assert.deepEqual(result, { ok: true, consolidated: [1, 2], skipped: [], partial: false })
})

test("the last drain_report call wins in a transcript", () => {
  const rows = [
    ...(toolCall({ item_count: 2, consolidated: ["#1"], skipped: ["#2"] }) as any[]),
    {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: DRAIN_REPORT_TOOL,
          state: { input: { item_count: 2, consolidated: ["#1", "#2"], skipped: [] } },
        },
      ],
    },
  ]
  const report = parseDrainReport(rows, 2)
  assert.equal(report?.valid, true)
  assert.deepEqual(report?.consolidated, [1, 2])
})
