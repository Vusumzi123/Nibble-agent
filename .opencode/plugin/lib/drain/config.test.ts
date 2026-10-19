import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DRAIN, parseDrainConfig, readDrainConfig } from "./config.ts"

test("parseDrainConfig overlays known keys", () => {
  const parsed = parseDrainConfig(
    [
      "drain:",
      "  enabled: false",
      "  batch_sessions: 9",
      "  max_items_per_batch: 5",
      "  initial_lookback_hours: 6",
      '  writer_model: "provider/model"',
      "  poison_attempts: 0",
      "  exclude_missions: [drain, staleness]",
      "  unknown_key: 1",
    ].join("\n"),
  )
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.batch_sessions, 9)
  assert.equal(parsed.max_items_per_batch, 5)
  assert.equal(parsed.initial_lookback_hours, 6)
  assert.equal(parsed.writer_model, "provider/model")
  assert.equal(parsed.poison_attempts, 0)
  assert.deepEqual(parsed.exclude_missions, ["drain", "staleness"])
  assert.equal("unknown_key" in parsed, false)
})

test("exclude_missions accepts inline lists and empty means none", () => {
  assert.deepEqual(
    parseDrainConfig("drain:\n  exclude_missions: [drain, staleness]").exclude_missions,
    ["drain", "staleness"],
  )
  assert.deepEqual(parseDrainConfig("drain:\n  exclude_missions: []").exclude_missions, [])
  assert.equal(
    parseDrainConfig("drain:\n  exclude_missions: [drain,").exclude_missions,
    undefined,
    "a malformed list is dropped so the default applies",
  )
})

test("readDrainConfig reads exclude_missions from the drain section", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drain-config-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["drain:", "  exclude_missions: [drain, staleness, research]"].join("\n"),
    "utf8",
  )

  const cfg = await readDrainConfig(dir)
  assert.deepEqual(cfg.exclude_missions, ["drain", "staleness", "research"])
})

test("missing config yields defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drain-config-"))
  assert.deepEqual(await readDrainConfig(dir), DEFAULT_DRAIN)
})

test("invalid values fall back and models may be empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drain-config-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    [
      "drain:",
      "  enabled: true",
      "  batch_sessions: 0",
      "  max_turns_per_session: 0",
      "  max_items_per_session: 0",
      "  max_items_per_batch: 0",
      "  initial_lookback_hours: -1",
      "  poison_attempts: -1",
      '  cursor_file: ""',
      '  writer_model: ""',
      '  summarize_model: ""',
    ].join("\n"),
    "utf8",
  )

  const cfg = await readDrainConfig(dir)
  assert.equal(cfg.batch_sessions, DEFAULT_DRAIN.batch_sessions)
  assert.equal(cfg.max_turns_per_session, DEFAULT_DRAIN.max_turns_per_session)
  assert.equal(cfg.max_items_per_session, DEFAULT_DRAIN.max_items_per_session)
  assert.equal(cfg.max_items_per_batch, DEFAULT_DRAIN.max_items_per_batch)
  assert.equal(cfg.initial_lookback_hours, DEFAULT_DRAIN.initial_lookback_hours)
  assert.equal(cfg.poison_attempts, DEFAULT_DRAIN.poison_attempts)
  assert.equal(cfg.cursor_file, DEFAULT_DRAIN.cursor_file)
  assert.equal(cfg.writer_model, "")
  assert.equal(cfg.summarize_model, "")
})
