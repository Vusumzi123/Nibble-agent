import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicRead, atomicUpdate, atomicWrite } from "./fsx.ts"

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fsx-test-"))
}

test("atomicWrite creates parent directories and writes content", async () => {
  const dir = await tempDir()
  const file = join(dir, "nested", "deep", "f.txt")
  await atomicWrite(file, "hello")
  assert.equal(await readFile(file, "utf8"), "hello")
})

test("atomicWrite overwrites an existing file", async () => {
  const dir = await tempDir()
  const file = join(dir, "f.txt")
  await atomicWrite(file, "one")
  await atomicWrite(file, "two")
  assert.equal(await readFile(file, "utf8"), "two")
})

test("atomicRead returns empty string for a missing file", async () => {
  const dir = await tempDir()
  assert.equal(await atomicRead(join(dir, "missing.txt")), "")
})

test("atomicUpdate read-modify-writes and returns the new content", async () => {
  const dir = await tempDir()
  const file = join(dir, "f.txt")
  await atomicWrite(file, "a")
  const next = await atomicUpdate(file, (cur) => cur + "b")
  assert.equal(next, "ab")
  assert.equal(await atomicRead(file), "ab")
})

test("atomicUpdate creates the file when absent", async () => {
  const dir = await tempDir()
  const file = join(dir, "f.txt")
  const next = await atomicUpdate(file, (cur) => (cur || "created") + "!")
  assert.equal(next, "created!")
})

test("atomicWrite cleans up its temp file when the rename fails", async () => {
  const dir = await tempDir()
  const target = join(dir, "iam-a-dir")
  await mkdir(target)
  await assert.rejects(atomicWrite(target, "x"))
  const leftovers = (await readdir(dir)).filter((n) => n.endsWith(".tmp"))
  assert.deepEqual(leftovers, [])
})

test("concurrent atomicUpdate calls serialize instead of losing updates", async () => {
  const dir = await tempDir()
  const file = join(dir, "counter.txt")
  await atomicWrite(file, "0")
  await Promise.all(
    Array.from({ length: 10 }, () =>
      atomicUpdate(file, (cur) => String(Number(cur) + 1)),
    ),
  )
  assert.equal(await atomicRead(file), "10")
})
