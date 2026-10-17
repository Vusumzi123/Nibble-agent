import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearLoggerCache } from "../logging.ts"
import { createDrainLedger, DRAIN_LEDGER_FILE } from "./ledger.ts"

after(clearLoggerCache)

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "drain-ledger-"))
}

async function readLines(dir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(dir, DRAIN_LEDGER_FILE), "utf8")
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("stamps every entry and writes newline-delimited JSON", async () => {
  const dir = await tmpDir()
  const ledger = createDrainLedger({ logDir: dir })
  await ledger.write({
    source: "pipe",
    outcome: "completed",
    sessions: 2,
    items: 3,
    cursor_before: 100,
    cursor_after: 200,
  })
  await ledger.write({
    source: "writer",
    outcome: "ok",
    model: "test/model",
    prompt_bytes: 1234,
    wall_ms: 456,
    steps: 7,
    tokens: 890,
  })
  await ledger.flush()

  const lines = await readLines(dir)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].source, "pipe")
  assert.equal(lines[0].outcome, "completed")
  assert.equal(lines[0].cursor_before, 100)
  assert.equal(lines[0].cursor_after, 200)
  assert.match(String(lines[0].ts), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(lines[1].source, "writer")
  assert.equal(lines[1].model, "test/model")
  assert.equal(lines[1].prompt_bytes, 1234)
  assert.equal(lines[1].steps, 7)
})

test("records explorer spawns with an explicit timestamp preserved", async () => {
  const dir = await tmpDir()
  const ledger = createDrainLedger({ logDir: dir })
  await ledger.write({
    source: "explorer",
    outcome: "ok",
    ts: "2026-10-17T00:00:00.000Z",
    prompt_bytes: 10,
  })
  await ledger.flush()

  const [line] = await readLines(dir)
  assert.equal(line.ts, "2026-10-17T00:00:00.000Z")
  assert.equal(line.source, "explorer")
})

test("flush settles all queued writes in order", async () => {
  const dir = await tmpDir()
  const ledger = createDrainLedger({ logDir: dir })
  for (let i = 0; i < 25; i++) {
    await ledger.write({ source: "pipe", outcome: "nothing", items: i })
  }
  await ledger.flush()

  const lines = await readLines(dir)
  assert.equal(lines.length, 25)
  assert.deepEqual(
    lines.map((l) => l.items),
    Array.from({ length: 25 }, (_, i) => i),
  )
})
