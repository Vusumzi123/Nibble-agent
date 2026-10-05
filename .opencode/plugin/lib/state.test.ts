import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStateStore } from "./state.ts"

type Demo = { a: number; b: string[] }

const DEFAULTS: Demo = { a: 1, b: [] }

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "state-test-"))
}

test("read returns defaults when the file is missing", async () => {
  const dir = await tempDir()
  const store = createStateStore<Demo>(join(dir, "missing.json"), DEFAULTS)
  assert.deepEqual(await store.read(), DEFAULTS)
})

test("read returns defaults when the file is corrupt", async () => {
  const dir = await tempDir()
  const file = join(dir, "bad.json")
  await writeFile(file, "{ not json")
  const store = createStateStore<Demo>(file, DEFAULTS)
  assert.deepEqual(await store.read(), DEFAULTS)
})

test("read merges persisted fields over defaults", async () => {
  const dir = await tempDir()
  const file = join(dir, "s.json")
  await writeFile(file, JSON.stringify({ a: 5 }))
  const store = createStateStore<Demo>(file, DEFAULTS)
  assert.deepEqual(await store.read(), { a: 5, b: [] })
})

test("write then read round-trips with 2-space JSON", async () => {
  const dir = await tempDir()
  const file = join(dir, "s.json")
  const store = createStateStore<Demo>(file, DEFAULTS)
  await store.write({ a: 9, b: ["x"] })
  assert.deepEqual(await store.read(), { a: 9, b: ["x"] })
})

test("update applies the function and persists", async () => {
  const dir = await tempDir()
  const file = join(dir, "s.json")
  const store = createStateStore<Demo>(file, DEFAULTS)
  const next = await store.update((prev) => ({ ...prev, a: prev.a + 1 }))
  assert.deepEqual(next, { a: 2, b: [] })
  assert.deepEqual(await store.read(), { a: 2, b: [] })
})

test("onError receives write failures instead of throwing", async () => {
  const dir = await tempDir()
  const target = join(dir, "blocked.json")
  await mkdir(target)
  const errors: unknown[] = []
  const store = createStateStore<Demo>(target, DEFAULTS, {
    onError: (err) => errors.push(err),
  })
  await store.write({ a: 2, b: [] })
  assert.equal(errors.length, 1)
})
