import { test } from "node:test"
import assert from "node:assert/strict"
import { parseConsolidationReport } from "./report.ts"

function fence(kind: "consolidated" | "skipped", labels: string[]): string {
  return ["```" + kind, ...labels, "```"].join("\n")
}

test("a complete mixed report is valid", () => {
  const report = parseConsolidationReport(
    `${fence("consolidated", ["#1", "#3"])}\n${fence("skipped", ["#2"])}`,
    3,
  )
  assert.equal(report.valid, true)
  assert.deepEqual(report.consolidated, [1, 3])
  assert.deepEqual(report.skipped, [2])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.duplicates, [])
  assert.deepEqual(report.unknown, [])
  assert.equal(report.error, undefined)
})

test("an all-consolidated report is valid", () => {
  const report = parseConsolidationReport(fence("consolidated", ["#1", "#2"]), 2)
  assert.equal(report.valid, true)
})

test("missing labels block the batch", () => {
  const report = parseConsolidationReport(fence("consolidated", ["#1"]), 3)
  assert.equal(report.valid, false)
  assert.deepEqual(report.missing, [2, 3])
  assert.equal(report.error, "missing labels")
})

test("duplicate labels block the batch", () => {
  const report = parseConsolidationReport(
    `${fence("consolidated", ["#1", "#1"])}\n${fence("skipped", ["#2"])}`,
    2,
  )
  assert.equal(report.valid, false)
  assert.deepEqual(report.duplicates, [1])
  assert.equal(report.error, "duplicate labels")
})

test("an item reported in both blocks is a duplicate", () => {
  const report = parseConsolidationReport(
    `${fence("consolidated", ["#1", "#2"])}\n${fence("skipped", ["#2"])}`,
    2,
  )
  assert.equal(report.valid, false)
  assert.deepEqual(report.duplicates, [2])
})

test("unknown labels block the batch", () => {
  const report = parseConsolidationReport(fence("consolidated", ["#1", "#9"]), 2)
  assert.equal(report.valid, false)
  assert.deepEqual(report.unknown, [9])
  assert.equal(report.error, "unknown labels")
})

test("no fence blocks the batch", () => {
  const report = parseConsolidationReport("I consolidated everything.", 2)
  assert.equal(report.valid, false)
  assert.deepEqual(report.missing, [1, 2])
  assert.equal(report.error, "no report fence")
})

test("prose around fences and inline labels are tolerated", () => {
  const report = parseConsolidationReport(
    [
      "Done. Notes written:",
      "```consolidated",
      "#1 #2",
      "```",
      "Nothing skipped.",
    ].join("\n"),
    2,
  )
  assert.equal(report.valid, true)
  assert.deepEqual(report.consolidated, [1, 2])
})

test("repeated fences of the same kind are merged", () => {
  const report = parseConsolidationReport(
    `${fence("consolidated", ["#1"])}\n${fence("consolidated", ["#2"])}`,
    2,
  )
  assert.equal(report.valid, true)
  assert.deepEqual(report.consolidated, [1, 2])
})

test("an empty batch is never valid", () => {
  const report = parseConsolidationReport(fence("consolidated", []), 0)
  assert.equal(report.valid, false)
})
