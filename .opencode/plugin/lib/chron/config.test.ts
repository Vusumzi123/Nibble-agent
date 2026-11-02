import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CHRON, parseChronConfig, readChronConfig } from "./config.ts"
import { tempDir, writeSection } from "../test-utils.ts"

test("missing chron section yields defaults", async () => {
  const dir = await tempDir("chron-config-")
  assert.deepEqual(await readChronConfig(dir), DEFAULT_CHRON)
  assert.deepEqual(parseChronConfig(""), DEFAULT_CHRON)
})

test("chron overrides are read with the right types", async () => {
  const dir = await tempDir("chron-config-")
  await writeSection(dir, "chron", [
    "enabled: false",
    "schedule_dir: schedule",
    "state_file: c.json",
    "inbox_dir: box",
    "max_sleep_seconds: 5",
    "prompt_ttl_hours: 12",
    "default_priority: 8",
    "mission_scan: every 5m",
    "mission_max_per_scan: 2",
    "defer_ttl_hours: 6",
  ])
  assert.deepEqual(await readChronConfig(dir), {
    enabled: false,
    schedule_dir: "schedule",
    state_file: "c.json",
    inbox_dir: "box",
    max_sleep_seconds: 5,
    prompt_ttl_hours: 12,
    default_priority: 8,
    mission_scan: "every 5m",
    mission_max_per_scan: 2,
    defer_ttl_hours: 6,
  })
})

test("malformed values fall back to defaults", () => {
  const parsed = parseChronConfig(
    "chron:\n  enabled: maybe\n  max_sleep_seconds: soon\n  mission_max_per_scan: -1\n",
  )
  assert.equal(parsed.enabled, DEFAULT_CHRON.enabled)
  assert.equal(parsed.max_sleep_seconds, DEFAULT_CHRON.max_sleep_seconds)
  assert.equal(parsed.mission_max_per_scan, DEFAULT_CHRON.mission_max_per_scan)
})
