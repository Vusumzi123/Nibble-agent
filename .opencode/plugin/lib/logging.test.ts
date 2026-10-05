import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LOG_DEFAULTS,
  clearLoggerCache,
  createDiagnostics,
  getLogger,
  logSettingsFrom,
  resolveLogPath,
} from "./logging.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "logging-"))
}

test("logSettingsFrom maps prefixed section keys onto LogSettings", () => {
  const settings = logSettingsFrom(
    {
      log: "knowledge-hook.log",
      log_rotate_bytes: 2048,
      log_keep_generations: 3,
      log_retention_days: 7,
      log_compress: false,
      log_compress_after: 2,
      log_compress_level: 9,
      log_rotate_by: "daily",
    },
    "log",
  )
  assert.deepEqual(settings, {
    file: "knowledge-hook.log",
    rotateBytes: 2048,
    keepGenerations: 3,
    retentionDays: 7,
    compress: false,
    compressAfter: 2,
    compressLevel: 9,
    rotateBy: "daily",
  })
})

test("logSettingsFrom falls back to defaults for missing keys", () => {
  const settings = logSettingsFrom({ log: "x.log" }, "log")
  assert.equal(settings.file, "x.log")
  assert.equal(settings.rotateBytes, LOG_DEFAULTS.rotateBytes)
  assert.equal(settings.compress, LOG_DEFAULTS.compress)
  assert.equal(settings.rotateBy, "size")
})

test("logSettingsFrom reads bare keys when prefix is empty (audit convention)", () => {
  const settings = logSettingsFrom(
    { log: "audit.log", rotate_bytes: 10485760, keep_generations: 5, retention_days: 90, compress: true },
    "log",
    "",
  )
  assert.equal(settings.rotateBytes, 10485760)
  assert.equal(settings.keepGenerations, 5)
  assert.equal(settings.compress, true)
})

test("logSettingsFrom normalizes an unknown rotateBy to size", () => {
  assert.equal(logSettingsFrom({ log: "x.log", log_rotate_by: "monthly" }, "log").rotateBy, "size")
})

test("logSettingsFrom accepts the ledger/scan_log filename keys", () => {
  assert.equal(logSettingsFrom({ ledger: "decisions.log" }, "ledger").file, "decisions.log")
  assert.equal(logSettingsFrom({ scan_log: "web-scan.log" }, "scan_log").file, "web-scan.log")
})

test("resolveLogPath honors absolute, ~, and sysop-relative leaves", () => {
  const sysop = "/sysop"
  assert.equal(resolveLogPath(sysop, "/abs/x.log", "/home/u"), "/abs/x.log")
  assert.equal(resolveLogPath(sysop, "~/y.log", "/home/u"), "/home/u/y.log")
  assert.equal(resolveLogPath(sysop, "z.log", "/home/u"), join(sysop, "z.log"))
})

test("getLogger caches one instance per resolved file", async () => {
  clearLoggerCache()
  const dir = await tmpDir()
  const settings = { ...LOG_DEFAULTS, file: "a.log" }
  const a = getLogger(settings, { sysopDir: dir })
  const b = getLogger(settings, { sysopDir: dir })
  assert.equal(a, b)
  clearLoggerCache()
  const c = getLogger(settings, { sysopDir: dir })
  assert.notEqual(a, c)
})

test("createDiagnostics writes a structured line and keeps console output", async () => {
  clearLoggerCache()
  const dir = await tmpDir()
  const original = console.error
  const consoleArgs: unknown[][] = []
  console.error = (...args: unknown[]) => {
    consoleArgs.push(args)
  }
  try {
    const diag = createDiagnostics({ sysopDir: dir })
    await diag.error("[demo] something broke", new Error("boom"))
  } finally {
    console.error = original
  }
  assert.equal(consoleArgs.length, 1, "console output is preserved")
  const text = await readFile(join(dir, "diagnostics.log"), "utf8")
  const line = JSON.parse(text.trim().split("\n").pop() as string)
  assert.equal(line.event, "diagnostic")
  assert.equal(line.level, "error")
  assert.match(line.msg, /\[demo\] something broke boom/)
})
