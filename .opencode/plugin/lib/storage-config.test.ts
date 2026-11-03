import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_STORAGE,
  normalizeStorageConfig,
  parseStorageConfig,
  readStorageConfig,
} from "./storage-config.ts"

test("storage config parses the documented block", () => {
  const cfg = parseStorageConfig(
    [
      "storage:",
      "  path: custom.db",
      "  busy_timeout_ms: 1200",
      "  synchronous: FULL",
      "  failed_retry_ms: 5000",
      "  failed_retention_days: 7",
      "",
    ].join("\n"),
  )
  assert.deepEqual(cfg, {
    path: "custom.db",
    busy_timeout_ms: 1200,
    synchronous: "FULL",
    failed_retry_ms: 5000,
    failed_retention_days: 7,
  })
})

test("storage config falls back on missing or malformed values", () => {
  const cfg = parseStorageConfig(
    ["storage:", "  path:", "  busy_timeout_ms: -1", "  synchronous: weird", ""].join("\n"),
  )
  assert.equal(cfg.path, DEFAULT_STORAGE.path)
  assert.equal(cfg.busy_timeout_ms, DEFAULT_STORAGE.busy_timeout_ms)
  assert.equal(cfg.synchronous, "NORMAL")
  assert.equal(cfg.failed_retry_ms, DEFAULT_STORAGE.failed_retry_ms)
  assert.equal(cfg.failed_retention_days, DEFAULT_STORAGE.failed_retention_days)
})

test("readStorageConfig uses defaults when the config is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storage-config-"))
  assert.deepEqual(await readStorageConfig(dir), DEFAULT_STORAGE)
})

test("readStorageConfig overlays the project file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storage-config-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["storage:", "  path: work.db", "  busy_timeout_ms: 250", ""].join("\n"),
    "utf8",
  )
  const cfg = await readStorageConfig(dir)
  assert.equal(cfg.busy_timeout_ms, 250)
  assert.deepEqual(normalizeStorageConfig(cfg), cfg)
})
