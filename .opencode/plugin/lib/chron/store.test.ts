import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  emptyState,
  parseJobFile,
  pruneMissingJobs,
  readChronState,
  readJobFiles,
  setStateFor,
  writeChronState,
} from "./store.ts"
import { tempDir } from "../test-utils.ts"

const VALID = `---
id: disk-check
schedule: daily 09:00
enabled: true
agent: chat
---
Check disk usage and report anything above 80%.
`

test("parses a markdown job", () => {
  const { job, issues } = parseJobFile(VALID, "fallback")
  assert.deepEqual(issues, [])
  assert.ok(job)
  assert.equal(job.id, "disk-check")
  assert.equal(job.title, "Check disk usage and report anything above 80%.")
  assert.equal(job.agent, "chat")
  assert.equal(job.enabled, true)
  assert.equal(job.prompt, "Check disk usage and report anything above 80%.")
  assert.equal(job.schedule_raw, "daily 09:00")
  assert.equal(job.schedule.kind, "cron")
})

test("id defaults to the filename stem and enabled can be false", () => {
  const content = `---\nschedule: 1h\nenabled: false\n---\nDo the thing.\n`
  const { job, issues } = parseJobFile(content, "from-file")
  assert.deepEqual(issues, [])
  assert.ok(job)
  assert.equal(job.id, "from-file")
  assert.equal(job.enabled, false)
  assert.equal(job.schedule.kind, "interval")
})

test("bad jobs are rejected with a reason", () => {
  for (const content of [
    "no frontmatter\n",
    "---\nid: x\ntitle: no schedule\n---\nbody\n",
    "---\nid: x\nschedule: nonsense\n---\nbody\n",
    "---\nid: x\nschedule: 1h\n---\n\n",
  ]) {
    const { job, issues } = parseJobFile(content, "x")
    assert.equal(job, null)
    assert.ok(issues.length > 0)
  }
})

test("readJobFiles keeps the first file for a duplicate id", async () => {
  const dir = await tempDir("chron-jobs-")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "a.md"),
    "---\nid: same\nschedule: 1h\n---\nfirst\n",
    "utf8",
  )
  await writeFile(
    join(dir, "b.md"),
    "---\nid: same\nschedule: 2h\n---\nsecond\n",
    "utf8",
  )
  const { jobs, issues } = await readJobFiles(dir)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].prompt, "first")
  assert.ok(issues.some((issue) => issue.reason.startsWith("duplicate id")))
})

test("state round-trips and malformed state reads empty", async () => {
  const dir = await tempDir("chron-state-")
  const file = join(dir, "chron.json")
  let state = emptyState()
  state = setStateFor(state, "job", {
    last_fired_ms: 10,
    next_due_ms: 20,
    first_deferred_ms: null,
  })
  await writeChronState(file, state)
  assert.deepEqual(await readChronState(file), state)

  await writeFile(file, "{not json", "utf8")
  assert.deepEqual(await readChronState(file), emptyState())
  assert.deepEqual(await readChronState(join(dir, "missing.json")), emptyState())
})

test("pruneMissingJobs drops old unseen entries and keeps live ones", () => {
  const now = 1_000_000_000
  let state = emptyState()
  state = setStateFor(state, "live", { last_fired_ms: 0, next_due_ms: null, first_deferred_ms: null })
  state = setStateFor(state, "old", { last_fired_ms: now - 31 * 86_400_000, next_due_ms: null, first_deferred_ms: null })
  state = setStateFor(state, "recent", { last_fired_ms: now - 86_400_000, next_due_ms: null, first_deferred_ms: null })
  const pruned = pruneMissingJobs(state, new Set(["live"]), now)
  assert.deepEqual(Object.keys(pruned.jobs).sort(), ["live", "recent"])
})
