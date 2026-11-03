import { test } from "node:test"
import assert from "node:assert/strict"
import { DRAIN_REPORT_TOOL, parseDrainReport, validateDrainReport } from "./report.ts"

function toolRow(input: unknown): unknown {
  return {
    info: { role: "assistant" },
    parts: [{ type: "tool", tool: DRAIN_REPORT_TOOL, state: { input } }],
  }
}

test("a complete mixed report is valid", () => {
  const report = validateDrainReport({
    item_count: 3,
    consolidated: ["#1", "#3"],
    skipped: ["#2"],
  })
  assert.equal(report.valid, true)
  assert.deepEqual(report.consolidated, [1, 3])
  assert.deepEqual(report.skipped, [2])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.duplicates, [])
  assert.deepEqual(report.unknown, [])
  assert.equal(report.error, undefined)
})

test("missing labels block a complete report but not a partial one", () => {
  const report = validateDrainReport({
    item_count: 3,
    consolidated: ["#1"],
    skipped: [],
  })
  assert.equal(report.valid, false)
  assert.deepEqual(report.missing, [2, 3])
  assert.equal(report.error, "missing labels")

  assert.equal(
    validateDrainReport({
      item_count: 3,
      consolidated: ["#1"],
      skipped: [],
      partial: true,
    }).valid,
    true,
  )
})

test("duplicate labels block the batch", () => {
  const report = validateDrainReport({
    item_count: 2,
    consolidated: ["#1", "#1"],
    skipped: ["#2"],
  })
  assert.equal(report.valid, false)
  assert.deepEqual(report.duplicates, [1])
  assert.equal(report.error, "duplicate labels")
})

test("an item reported in both lists is a duplicate", () => {
  const report = validateDrainReport({
    item_count: 2,
    consolidated: ["#1", "#2"],
    skipped: ["#2"],
  })
  assert.equal(report.valid, false)
  assert.deepEqual(report.duplicates, [2])
})

test("unknown labels block the batch", () => {
  const report = validateDrainReport({
    item_count: 2,
    consolidated: ["#1", "#9"],
    skipped: [],
  })
  assert.equal(report.valid, false)
  assert.deepEqual(report.unknown, [9])
  assert.equal(report.error, "unknown labels")
})

test("no drain_report call is null, and the last call wins", () => {
  assert.equal(parseDrainReport([{ info: { role: "assistant" }, parts: [] }], 2), null)

  const report = parseDrainReport(
    [
      toolRow({ item_count: 2, consolidated: ["#1"], skipped: [] }),
      toolRow({ item_count: 2, consolidated: ["#1", "#2"], skipped: [] }),
    ],
    2,
  )
  assert.equal(report?.valid, true)
  assert.deepEqual(report?.consolidated, [1, 2])
})

test("the declared count is overridden by the real batch count", () => {
  const report = parseDrainReport(
    [toolRow({ item_count: 99, consolidated: ["#1", "#2"], skipped: [] })],
    2,
  )
  assert.equal(report?.valid, true)
  assert.equal(report?.itemCount, 2)

  const unknown = parseDrainReport(
    [toolRow({ item_count: 99, consolidated: ["#1", "#2", "#3"], skipped: [] })],
    2,
  )
  assert.equal(unknown?.valid, false)
  assert.deepEqual(unknown?.unknown, [3])
})

test("an empty batch is never valid", () => {
  const report = validateDrainReport({ item_count: 0, consolidated: [], skipped: [] })
  assert.equal(report.valid, false)
})
