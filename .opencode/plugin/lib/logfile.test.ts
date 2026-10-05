import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNdjsonLogger } from "./logfile.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "logfile-"))
}

async function ls(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

test("append writes newline-delimited JSON in order", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({ log, rotateBytes: 0, keepGenerations: 3, retentionDays: 0 })
  await logger.append({ event: "a", n: 1 })
  await logger.append({ event: "b", n: 2 })
  const lines = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.event), ["a", "b"])
})

test("concurrent appends are serialized (no interleaved lines)", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({ log, rotateBytes: 0, keepGenerations: 3, retentionDays: 0 })
  await Promise.all(Array.from({ length: 25 }, (_, i) => logger.append({ i })))
  const lines = (await readFile(log, "utf8")).trim().split("\n")
  assert.equal(lines.length, 25)
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l))
})

test("rotation shifts generations once the size cap is reached", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({ log, rotateBytes: 50, keepGenerations: 3, retentionDays: 0 })
  for (let i = 0; i < 10; i++) await logger.append({ i, padding: "x".repeat(20) })
  const entries = await ls(dir)
  assert.ok(entries.includes("k.log"))
  assert.ok(entries.some((e) => /^k\.log\.\d+$/.test(e)), "expected at least one rotated generation")
  assert.equal(entries.filter((e) => /^k\.log\.\d+(\.gz)?$/.test(e)).length <= 3, true)
})

test("compresses generations beyond compressAfter, keeping the newest plain", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({
    log,
    rotateBytes: 50,
    keepGenerations: 3,
    retentionDays: 0,
    compress: true,
    compressAfter: 1,
  })
  for (let i = 0; i < 12; i++) await logger.append({ i, padding: "x".repeat(20) })
  const entries = await ls(dir)
  assert.ok(entries.includes("k.log.1"), "newest rotated generation stays plain")
  assert.ok(!entries.includes("k.log.1.gz"), "newest rotated generation must not be gzipped")
  assert.ok(entries.includes("k.log.2.gz"), "older generations are gzipped")
  // No plain file may survive beyond the hot window.
  assert.ok(!entries.includes("k.log.2"))
})

test("compression preserves the rotated content", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({
    log,
    rotateBytes: 40,
    keepGenerations: 2,
    retentionDays: 0,
    compress: true,
    compressAfter: 0, // gzip everything rotated, including .1
  })
  for (let i = 0; i < 8; i++) await logger.append({ marker: `m${i}` })
  const entries = await ls(dir)
  assert.ok(entries.includes("k.log.1.gz"), "compressAfter 0 gzips the newest generation too")
  const { createGunzip } = await import("node:zlib")
  const { createReadStream, createWriteStream } = await import("node:fs")
  const { pipeline } = await import("node:stream/promises")
  const out = join(dir, "gunzipped")
  await pipeline(createReadStream(join(dir, "k.log.1.gz")), createGunzip(), createWriteStream(out))
  const text = await readFile(out, "utf8")
  for (const line of text.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line))
})

test("retention deletes old rotated plain and gz files", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  // rotateBytes 0 isolates the retention sweep from rotation.
  const logger = createNdjsonLogger({ log, rotateBytes: 0, keepGenerations: 3, retentionDays: 1 })
  const old = new Date(Date.now() - 5 * 86_400_000)
  const plain = `${log}.1`
  const gz = `${log}.2.gz`
  await writeFile(plain, '{"event":"old"}\n')
  await writeFile(gz, "not-really-gzip\n")
  await utimes(plain, old, old)
  await utimes(gz, old, old)
  await logger.append({ event: "fresh" })
  const after = await ls(dir)
  assert.ok(!after.includes("k.log.1"), "aged-out plain generation should be deleted")
  assert.ok(!after.includes("k.log.2.gz"), "aged-out gz generation should be deleted")
  assert.ok(after.includes("k.log"), "active log is never deleted")
})

test("retention never deletes the active log", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({ log, rotateBytes: 0, keepGenerations: 3, retentionDays: 1 })
  await logger.append({ event: "keep" })
  const old = new Date(Date.now() - 10 * 86_400_000)
  await utimes(log, old, old)
  await logger.append({ event: "still here" })
  assert.ok((await stat(log)).size > 0)
})

test("daily rotation triggers when the active log crosses a UTC day boundary", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({
    log,
    rotateBytes: 0,
    keepGenerations: 3,
    retentionDays: 0,
    rotateBy: "daily",
  })
  await logger.append({ event: "day1" })
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
  await utimes(log, twoDaysAgo, twoDaysAgo)
  await logger.append({ event: "day3" })
  const entries = await ls(dir)
  assert.ok(entries.includes("k.log.1"), "stale active log rotated on the next append")
})

test("weekly rotation triggers when the active log crosses a UTC week boundary", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({
    log,
    rotateBytes: 0,
    keepGenerations: 3,
    retentionDays: 0,
    rotateBy: "weekly",
  })
  await logger.append({ event: "wk1" })
  const threeWeeksAgo = new Date(Date.now() - 21 * 86_400_000)
  await utimes(log, threeWeeksAgo, threeWeeksAgo)
  await logger.append({ event: "wk4" })
  const entries = await ls(dir)
  assert.ok(entries.includes("k.log.1"), "stale active log rotated on the next append")
})

test("custom rotationEntry is written as the first line of the fresh log", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({
    log,
    rotateBytes: 40,
    keepGenerations: 2,
    retentionDays: 0,
    rotationEntry: (ts) => ({ ts, agent: "x", cmd: "log-rotation", exit: 0 }),
  })
  for (let i = 0; i < 6; i++) await logger.append({ i, padding: "x".repeat(20) })
  const first = JSON.parse((await readFile(log, "utf8")).split("\n")[0])
  assert.equal(first.cmd, "log-rotation")
  assert.equal(first.agent, "x")
})

test("flush resolves after all queued appends settle", async () => {
  const dir = await tmpDir()
  const log = join(dir, "k.log")
  const logger = createNdjsonLogger({ log, rotateBytes: 0, keepGenerations: 3, retentionDays: 0 })
  void logger.append({ event: "a" })
  void logger.append({ event: "b" })
  await logger.flush()
  const lines = (await readFile(log, "utf8")).trim().split("\n")
  assert.equal(lines.length, 2)
})

test("onError is invoked on a logging failure and append never rejects", async () => {
  const dir = await tmpDir()
  const bad = join(dir, "afile", "k.log")
  await writeFile(join(dir, "afile"), "x")
  const errors: unknown[] = []
  const logger = createNdjsonLogger({
    log: bad,
    rotateBytes: 0,
    keepGenerations: 3,
    retentionDays: 0,
    onError: (e) => errors.push(e),
  })
  await assert.doesNotReject(() => logger.append({ event: "ignored" }))
  assert.equal(errors.length, 1)
})

test("a logging failure never rejects the caller", async () => {
  const dir = await tmpDir()
  // A path whose parent is a file cannot be created — the logger must swallow it.
  const bad = join(dir, "afile", "k.log")
  await writeFile(join(dir, "afile"), "x")
  const logger = createNdjsonLogger({ log: bad, rotateBytes: 0, keepGenerations: 3, retentionDays: 0 })
  await assert.doesNotReject(() => logger.append({ event: "ignored" }))
})
