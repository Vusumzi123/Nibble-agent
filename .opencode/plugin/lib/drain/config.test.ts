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
      '  writer_model: "provider/model"',
      "  poison_attempts: 0",
      "  unknown_key: 1",
    ].join("\n"),
  )
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.batch_sessions, 9)
  assert.equal(parsed.writer_model, "provider/model")
  assert.equal(parsed.poison_attempts, 0)
  assert.equal("unknown_key" in parsed, false)
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
  assert.equal(cfg.poison_attempts, DEFAULT_DRAIN.poison_attempts)
  assert.equal(cfg.cursor_file, DEFAULT_DRAIN.cursor_file)
  assert.equal(cfg.writer_model, "")
  assert.equal(cfg.summarize_model, "")
})
