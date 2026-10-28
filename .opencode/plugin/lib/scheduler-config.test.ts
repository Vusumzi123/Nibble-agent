import { test } from "node:test"
import assert from "node:assert/strict"

import { parseSchedulerConfig } from "./scheduler-config.ts"

test("scheduler config reads weights, with defaults for missing keys", () => {
  const cfg = parseSchedulerConfig(`
scheduler:
  weights:
    mission: 7
    drain-pass: 2
    staleness: 0
`)
  assert.equal(cfg.weights.mission, 7)
  assert.equal(cfg.weights["drain-pass"], 2)
  assert.equal(cfg.weights.staleness, 0)
  assert.equal(cfg.weights["quiet-hours"], 1)
})

test("scheduler config ignores malformed weights", () => {
  const cfg = parseSchedulerConfig(`
scheduler:
  weights:
    mission: -3
    drain-pass: nope
`)
  assert.equal(cfg.weights.mission, 4)
  assert.equal(cfg.weights["drain-pass"], 3)
})

test("scheduler config is total when the section is absent", () => {
  const cfg = parseSchedulerConfig("")
  assert.equal(cfg.weights.mission, 4)
})
