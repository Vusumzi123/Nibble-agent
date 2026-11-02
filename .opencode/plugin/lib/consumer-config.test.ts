import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULT_CONSUMER,
  normalizeConsumerConfig,
  parseConsumerConfig,
  readConsumerConfig,
} from "./consumer-config.ts"
import { tempDir, writeSection } from "./test-utils.ts"

test("missing consumer section yields defaults", async () => {
  const dir = await tempDir("consumer-config-")
  assert.deepEqual(await readConsumerConfig(dir), DEFAULT_CONSUMER)
  assert.deepEqual(parseConsumerConfig(""), DEFAULT_CONSUMER)
})

test("consumer overrides are read and 0 stays unlimited", async () => {
  const dir = await tempDir("consumer-config-")
  await writeSection(dir, "consumer", [
    "max_items_per_tick: 3",
    "max_wall_minutes: 0",
    "token_budget: 1000",
  ])
  assert.deepEqual(await readConsumerConfig(dir), {
    max_items_per_tick: 3,
    max_wall_minutes: 0,
    token_budget: 1000,
  })
  assert.deepEqual(
    normalizeConsumerConfig({ max_items_per_tick: 0, max_wall_minutes: 0, token_budget: 0 }),
    { max_items_per_tick: 0, max_wall_minutes: 0, token_budget: 0 },
  )
})

test("malformed values fall back to defaults", () => {
  const parsed = parseConsumerConfig(
    "consumer:\n  max_items_per_tick: soon\n  max_wall_minutes: -1\n  token_budget: 1.5\n",
  )
  assert.deepEqual(parsed, DEFAULT_CONSUMER)
})
