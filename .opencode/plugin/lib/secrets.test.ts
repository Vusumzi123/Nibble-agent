import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandHomePath, readCredential } from "./secrets.ts"

test("expandHomePath expands ~ against the supplied home", () => {
  assert.equal(expandHomePath("~/x", "/h"), "/h/x")
  assert.equal(expandHomePath("~", "/h"), "/h")
  assert.equal(expandHomePath("/abs", "/h"), "/abs")
  assert.equal(expandHomePath("rel", "/h"), "rel")
})

test("readCredential trims the file and returns '' on a miss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secrets-"))
  const file = join(dir, "token")
  await writeFile(file, "abc123\n")
  assert.equal(await readCredential(file), "abc123")
  assert.equal(await readCredential(join(dir, "nope")), "")
})
