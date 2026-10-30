import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  MAX_PENDING_TASKS,
  createTask,
  listPendingTasks,
  looksLikeSecret,
  newTaskId,
  parseTaskFile,
  pruneSettledTasks,
  readPendingTask,
  renderTaskFile,
  settleTask,
  taskSettled,
  tasksRoot,
  type UserTask,
} from "./user-tasks.ts"

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "user-tasks-"))
  return join(dir, ".opencode", "state")
}

const baseTask = (over: Partial<UserTask> = {}): UserTask => ({
  id: "user-m3k9x2-a1b2",
  title: "Fix the dashboard queue sort",
  priority: 5,
  created_ms: 1_793_347_200_000,
  requested_by: "user",
  status: "pending",
  prompt: "Do the thing.\n\nStop when the queue sorts.",
  context: "The page is Dashboard/src/app/pages/queues.ts.",
  ...over,
})

test("render → parse round-trips every field including the context section", () => {
  const task = baseTask({ dedupe_key: "dashboard-queue-sort", expires_ms: 1_793_947_200_000 })
  const parsed = parseTaskFile(renderTaskFile(task), task.id)
  assert.deepEqual(parsed.problems, [])
  assert.deepEqual(parsed.task, task)
})

test("parseTaskFile: malformed frontmatter or an unsafe id yields null, never throws", () => {
  assert.equal(parseTaskFile("no frontmatter here", "x").task, null)
  assert.equal(parseTaskFile("---\nid: ../../etc/passwd\n---\nprompt", "bad").task, null)
  const empty = parseTaskFile("---\nid: user-a-b\n---\n", "user-a-b")
  assert.ok(empty.problems.includes("empty prompt"))
  assert.ok(empty.problems.includes("missing title"))
})

test("newTaskId is unique enough for repeated creates", () => {
  const ids = new Set(Array.from({ length: 500 }, (_, i) => newTaskId(1_000 + i, () => i / 500)))
  assert.equal(ids.size, 500)
  assert.ok([...ids].every((id) => /^user-[a-z0-9]+-[a-z0-9]+$/.test(id)))
})

test("createTask writes a pending file that listPendingTasks returns, priority-first", async () => {
  const dir = await stateDir()
  const low = await createTask(dir, { title: "Low", prompt: "p", priority: 2 }, { nowMs: 10, random: () => 0.1 })
  const high = await createTask(dir, { title: "High", prompt: "p", priority: 9 }, { nowMs: 20, random: () => 0.2 })
  assert.ok(low.ok && high.ok)
  const pending = await listPendingTasks(dir)
  assert.deepEqual(pending.map((t) => t.title), ["High", "Low"])
  const read = await readPendingTask(dir, (low as any).id)
  assert.equal(read?.title, "Low")
})

test("createTask enforces the caps, secret rejection, and dedupe_key reuse", async () => {
  const dir = await stateDir()
  const big = await createTask(dir, { title: "Big", prompt: "x".repeat(16 * 1024 + 1) })
  assert.equal(big.ok, false)

  const secret = await createTask(dir, {
    title: "Secret",
    prompt: "use ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  })
  assert.equal(secret.ok, false)
  assert.ok(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----"))
  assert.ok(!looksLikeSecret("rotate the token file under ~/.ssh is denied"))

  const first = await createTask(dir, { title: "Once", prompt: "p", dedupe_key: "same" })
  const again = await createTask(dir, { title: "Twice", prompt: "p", dedupe_key: "same" })
  assert.ok(first.ok && again.ok)
  assert.equal((again as any).id, (first as any).id)
  assert.equal((again as any).deduped, (first as any).id)
})

test("createTask refuses past MAX_PENDING_TASKS instead of dropping old work", async () => {
  const dir = await stateDir()
  await mkdir(tasksRoot(dir), { recursive: true })
  for (let i = 0; i < MAX_PENDING_TASKS; i += 1) {
    await writeFile(
      join(tasksRoot(dir), `user-a${i.toString(36)}-c.md`),
      renderTaskFile(baseTask({ id: `user-a${i.toString(36)}-c`, title: `T${i}` })),
      "utf8",
    )
  }
  const result = await createTask(dir, { title: "Overflow", prompt: "p" })
  assert.equal(result.ok, false)
  assert.match((result as any).reason, /cap/)
})

test("settleTask moves the file, appends ## Result, and is immutable", async () => {
  const dir = await stateDir()
  const created = await createTask(dir, { title: "T", prompt: "p" }, { nowMs: 50, random: () => 0.3 })
  assert.ok(created.ok)
  const id = (created as any).id

  const moved = await settleTask(dir, id, "done", { summary: "fixed", session_id: "ses_1" }, 99)
  assert.equal(moved, true)
  assert.equal(await readPendingTask(dir, id), null)
  assert.equal(await taskSettled(dir, id), true)

  const archived = await readFile(join(tasksRoot(dir), "done", `${id}.md`), "utf8")
  assert.match(archived, /^status: done$/m)
  assert.match(archived, /## Result/)
  assert.match(archived, /- summary: fixed/)
  assert.match(archived, /- session: ses_1/)

  assert.equal(await settleTask(dir, id, "failed", {}, 100), false, "second settle is a no-op")
  const blocked = await settleTask(dir, "user-nope-x", "blocked")
  assert.equal(blocked, false, "a missing task never throws")
})

test("settleTask archives blocked and failed under their own folders", async () => {
  const dir = await stateDir()
  for (const status of ["blocked", "failed"] as const) {
    const created = await createTask(dir, { title: status, prompt: "p" })
    assert.ok(created.ok)
    await settleTask(dir, (created as any).id, status, { summary: status })
    const text = await readFile(join(tasksRoot(dir), status, `${(created as any).id}.md`), "utf8")
    assert.match(text, new RegExp(`^status: ${status}$`, "m"))
  }
})

// ---------------------------------------------------------------------------
// Retention

const DAY = 86_400_000

async function archive(
  dir: string,
  status: "done" | "blocked" | "failed",
  mtimeMs: number,
): Promise<string> {
  const created = await createTask(dir, { title: status, prompt: "p" })
  assert.ok(created.ok)
  const id = (created as any).id
  await settleTask(dir, id, status)
  const file = join(tasksRoot(dir), status, `${id}.md`)
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

test("pruneSettledTasks removes old files from all three terminal folders", async () => {
  const dir = await stateDir()
  const now = Date.now()
  const old = now - 31 * DAY
  const fresh = now - DAY

  const oldDone = await archive(dir, "done", old)
  const oldBlocked = await archive(dir, "blocked", old)
  const oldFailed = await archive(dir, "failed", old)
  const freshDone = await archive(dir, "done", fresh)
  const pending = await createTask(dir, { title: "pending", prompt: "p" })
  assert.ok(pending.ok)

  const result = await pruneSettledTasks(dir, { nowMs: now, retentionDays: 30 })
  assert.equal(result.kept, 1)
  const expected = [
    `done/${oldDone.split("/").pop()}`,
    `blocked/${oldBlocked.split("/").pop()}`,
    `failed/${oldFailed.split("/").pop()}`,
  ].sort()
  assert.deepEqual(result.pruned.sort(), expected)
  for (const file of [oldDone, oldBlocked, oldFailed]) {
    await assert.rejects(readFile(file, "utf8"))
  }
  await readFile(freshDone, "utf8")
  assert.notEqual(await readPendingTask(dir, (pending as any).id), null)
})

test("pruneSettledTasks: 0/negative disables it; missing folders are clean", async () => {
  const dir = await stateDir()
  const file = await archive(dir, "done", Date.now() - 400 * DAY)
  assert.deepEqual(await pruneSettledTasks(dir, { retentionDays: 0 }), { pruned: [], kept: 0 })
  assert.deepEqual(await pruneSettledTasks(dir, { retentionDays: -5 }), { pruned: [], kept: 0 })
  await readFile(file, "utf8")

  const empty = await stateDir()
  assert.deepEqual(await pruneSettledTasks(empty), { pruned: [], kept: 0 })
})

test("pruneSettledTasks ignores non-.md and unsafe-id files in a terminal folder", async () => {
  const dir = await stateDir()
  const done = join(tasksRoot(dir), "done")
  await mkdir(done, { recursive: true })
  const old = Date.now() - 400 * DAY
  const keepNoise = join(done, "notes.txt")
  const keepBad = join(done, "bad-id.md")
  await writeFile(keepNoise, "x", "utf8")
  await writeFile(keepBad, "x", "utf8")
  await utimes(keepNoise, new Date(old), new Date(old))
  await utimes(keepBad, new Date(old), new Date(old))

  const result = await pruneSettledTasks(dir, { retentionDays: 30 })
  assert.deepEqual(result.pruned, [])
  await readFile(keepNoise, "utf8")
  await readFile(keepBad, "utf8")
})
