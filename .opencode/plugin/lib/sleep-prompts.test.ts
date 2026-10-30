import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SLEEP_PROMPTS,
  parseSleepPrompts,
  readSleepPrompts,
  resolveSleepPrompts,
} from "./sleep-prompts.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sleep-prompts-"))
}

test("parseSleepPrompts accepts a complete file and trims values", () => {
  const parsed = parseSleepPrompts({
    awake: " a ",
    dreaming: "d",
    woken: "w",
    quiet_awake: "q",
    extra: "ignored",
  })
  assert.deepEqual(parsed, { awake: "a", dreaming: "d", woken: "w", quiet_awake: "q" })
})

test("parseSleepPrompts rejects malformed or incomplete files", () => {
  assert.equal(parseSleepPrompts(null), null)
  assert.equal(parseSleepPrompts("nope"), null)
  assert.equal(parseSleepPrompts([]), null)
  assert.equal(parseSleepPrompts({}), null)
  assert.equal(parseSleepPrompts({ awake: "a", dreaming: "d", woken: "w" }), null)
  assert.equal(parseSleepPrompts({ awake: "a", dreaming: "d", woken: "w", quiet_awake: "  " }), null)
  assert.equal(parseSleepPrompts({ awake: 1, dreaming: "d", woken: "w", quiet_awake: "q" }), null)
})

test("readSleepPrompts returns null for a missing or malformed file", async () => {
  const dir = await tmpDir()
  assert.equal(await readSleepPrompts(join(dir, "missing.json")), null)
  const bad = join(dir, "bad.json")
  await writeFile(bad, "{not json", "utf8")
  assert.equal(await readSleepPrompts(bad), null)
})

test("resolveSleepPrompts honors absolute, ~, and project-relative leaves", () => {
  assert.equal(resolveSleepPrompts("/proj", ".opencode/p.json"), "/proj/.opencode/p.json")
  assert.equal(resolveSleepPrompts("/proj", "/abs/p.json"), "/abs/p.json")
  assert.equal(resolveSleepPrompts("/proj", "~/p.json"), join(homedir(), "p.json"))
})

test("DEFAULT_SLEEP_PROMPTS covers every status", () => {
  assert.ok(DEFAULT_SLEEP_PROMPTS.awake.length > 0)
  assert.ok(DEFAULT_SLEEP_PROMPTS.dreaming.length > 0)
  assert.ok(DEFAULT_SLEEP_PROMPTS.woken.includes("groggy"))
  assert.ok(DEFAULT_SLEEP_PROMPTS.quiet_awake.length > 0)
})
