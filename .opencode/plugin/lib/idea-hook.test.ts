import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempHome } from "./test-utils.ts"

// Isolate the state/log files: point HOME at a throwaway dir BEFORE the hook
// module computes its top-level paths.
const TEST_HOME = tempHome("ihook-home-")

const { default: createHook } = await import("../idea-hook.ts")
const { localDayKey, parseBucket, appendIdeaToBucket } = await import("./idea.ts")

const SYSP_DIR = join(TEST_HOME, ".opencode-sysop")
const STATE_FILE = join(SYSP_DIR, "idea-hook.json")
const LOG_FILE = join(SYSP_DIR, "idea-hook.log")

async function resetSysop(): Promise<void> {
  await rm(STATE_FILE, { force: true })
  await rm(LOG_FILE, { force: true })
}

async function readLog(): Promise<any[]> {
  try {
    return (await readFile(LOG_FILE, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await delay(20)
  }
  return false
}

async function freshProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ihook-proj-"))
}

async function writeConfig(
  dir: string,
  opts: { idea: string[]; decisions?: string[] },
): Promise<void> {
  const lines = ["idea:", ...opts.idea.map((l) => "  " + l)]
  if (opts.decisions) lines.push("decisions:", ...opts.decisions.map((l) => "  " + l))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode/sysop-config.yaml"), lines.join("\n") + "\n", "utf8")
}

async function seedState(overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(SYSP_DIR, { recursive: true })
  const base = {
    dayKey: localDayKey(new Date()),
    dailyTarget: 1,
    generatedToday: 0,
    dueAt: [Date.now() - 1000],
    lastGeneratedAt: null,
    passSeq: 0,
  }
  await writeFile(STATE_FILE, JSON.stringify({ ...base, ...overrides }, null, 2), "utf8")
}

function bucketPath(dir: string): string {
  return join(dir, "Brain", "Ideas.md")
}

async function readBucket(dir: string): Promise<string> {
  try {
    return await readFile(bucketPath(dir), "utf8")
  } catch {
    return ""
  }
}

function reply(title: string, body: string, category = "thought"): string {
  return ["<<<IDEA", `TITLE: ${title}`, `CATEGORY: ${category}`, "BODY:", body, ">>>"].join("\n")
}

function makeClient(childReply?: string) {
  const calls = { create: 0, prompts: [] as any[], toasts: [] as any[] }
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async ({ path }: any) => {
        if (path.id === "ses_child" && childReply) {
          return { data: [{ info: { role: "assistant", id: "m1" }, parts: [{ type: "text", text: childReply }] }] }
        }
        return { data: [] as any[] }
      },
      create: async () => {
        calls.create++
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
    tui: {
      showToast: async (args: any) => {
        calls.toasts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
}

// A config with a full-day window and review off (so generation does not need a
// decision provider).
const OPEN_IDEA = [
  "enabled: true",
  "active_start_hour: 0",
  "active_end_hour: 24",
  "child_timeout_ms: 4000",
  "review: false",
  "notify: false",
]

test("a due tick generates an idea and appends it to the bucket", async () => {
  await resetSysop()
  const dir = await freshProject()
  await writeConfig(dir, { idea: OPEN_IDEA })
  await seedState()
  const client = makeClient(reply("Test idea", "A unique body about underwater basket weaving economics."))
  await createHook({ client, directory: dir })

  const ok = await waitFor(async () => (await readBucket(dir)).includes("### Test idea"))
  assert.equal(ok, true, "idea was appended")
  const entries = parseBucket(await readBucket(dir))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].category, "thought")
  const log = await readLog()
  assert.ok(log.some((e) => e.event === "idea-generated" && e.title === "Test idea"))
  const state = JSON.parse(await readFile(STATE_FILE, "utf8"))
  assert.equal(state.generatedToday, 1)
})

test("disabled config is a no-op", async () => {
  await resetSysop()
  const dir = await freshProject()
  await writeConfig(dir, { idea: ["enabled: false"] })
  const hook = await createHook({ client: makeClient(reply("X", "body")) as any, directory: dir })
  assert.deepEqual(Object.keys(hook as object), [])
  await delay(200)
  assert.equal(await readBucket(dir), "")
})

test("day rollover draws a 0-2 target and matching due times", async () => {
  await resetSysop()
  const dir = await freshProject()
  await writeConfig(dir, {
    idea: ["enabled: true", "active_start_hour: 0", "active_end_hour: 24", "child_timeout_ms: 200", "review: false", "notify: false"],
  })
  await seedState({ dayKey: "1999-01-01", dailyTarget: 0, dueAt: [] })
  await createHook({ client: makeClient() as any, directory: dir })

  const scheduled = await waitFor(async () => (await readLog()).some((e) => e.event === "idea-schedule"))
  assert.equal(scheduled, true)
  const log = await readLog()
  const ev = log.find((e) => e.event === "idea-schedule")
  assert.ok(ev.dailyTarget >= 0 && ev.dailyTarget <= 2)
  assert.equal(ev.dueAt.length, ev.dailyTarget)
  assert.equal(ev.dayKey, localDayKey(new Date()))
})

test("a due time missed while closed catches up when the window is open", async () => {
  await resetSysop()
  const dir = await freshProject()
  await writeConfig(dir, { idea: OPEN_IDEA })
  await seedState({ dueAt: [Date.now() - 3600_000] })
  const client = makeClient(reply("Catchup idea", "Catching up on a missed due time with a novel thought."))
  await createHook({ client, directory: dir })

  const ok = await waitFor(async () => (await readBucket(dir)).includes("### Catchup idea"))
  assert.equal(ok, true)
})

test("an out-of-window due time is skipped, not burst-generated", async () => {
  await resetSysop()
  const dir = await freshProject()
  const h = new Date().getHours()
  const start = (h + 3) % 22
  const end = start + 1
  await writeConfig(dir, {
    idea: [
      "enabled: true",
      `active_start_hour: ${start}`,
      `active_end_hour: ${end}`,
      "child_timeout_ms: 500",
      "review: false",
      "notify: false",
    ],
  })
  await seedState({ dueAt: [Date.now() - 1000] })
  await createHook({ client: makeClient(reply("Nope", "body")) as any, directory: dir })

  const skipped = await waitFor(async () =>
    (await readLog()).some((e) => e.event === "idea-skipped" && e.reason === "out-of-window"),
  )
  assert.equal(skipped, true)
  assert.equal(await readBucket(dir), "")
})

test("a duplicate draft is rejected and not stored", async () => {
  await resetSysop()
  const dir = await freshProject()
  const body = "A unique body about underwater basket weaving economics."
  const today = localDayKey(new Date())
  const existing = appendIdeaToBucket(
    "",
    { title: "Existing", category: "thought", id: "idea-x", created: today, hash: "x", body },
    today,
  )
  await mkdir(join(dir, "Brain"), { recursive: true })
  await writeFile(bucketPath(dir), existing, "utf8")
  await writeConfig(dir, { idea: OPEN_IDEA })
  await seedState()
  const client = makeClient(reply("Duplicate attempt", body))
  await createHook({ client, directory: dir })

  const duped = await waitFor(async () =>
    (await readLog()).some((e) => e.event === "idea-skipped" && e.reason === "duplicate"),
  )
  assert.equal(duped, true)
  const entries = parseBucket(await readBucket(dir))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, "Existing")
})

test("a reviewer rejection does not store the idea", async () => {
  await resetSysop()
  const dir = await freshProject()
  await writeConfig(dir, {
    idea: ["enabled: true", "active_start_hour: 0", "active_end_hour: 24", "child_timeout_ms: 4000", "notify: false"],
    decisions: ["enabled: true", "provider: rules"],
  })
  await seedState()
  const client = makeClient(reply("Review me", "A genuinely novel and useful standalone idea body."))
  await createHook({ client, directory: dir })

  const reviewed = await waitFor(async () =>
    (await readLog()).some((e) => e.event === "idea-review" && e.accepted === false),
  )
  assert.equal(reviewed, true)
  assert.equal(await readBucket(dir), "")
})

test("a child with no reply produces no write (fail-open)", async () => {
  await resetSysop()
  const dir = await freshProject()
  await writeConfig(dir, {
    idea: ["enabled: true", "active_start_hour: 0", "active_end_hour: 24", "child_timeout_ms: 200", "review: false", "notify: false"],
  })
  await seedState()
  await createHook({ client: makeClient(undefined) as any, directory: dir })

  const skipped = await waitFor(async () =>
    (await readLog()).some((e) => e.event === "idea-skipped" && e.reason === "child-no-reply"),
  )
  assert.equal(skipped, true)
  assert.equal(await readBucket(dir), "")
})

test("a corrupt state file does not throw during init", async () => {
  await resetSysop()
  const dir = await freshProject()
  await writeConfig(dir, {
    idea: ["enabled: true", "active_start_hour: 0", "active_end_hour: 24", "child_timeout_ms: 200", "review: false", "notify: false"],
  })
  await mkdir(SYSP_DIR, { recursive: true })
  await writeFile(STATE_FILE, "{ not json", "utf8")
  const hook = await createHook({ client: makeClient() as any, directory: dir })
  assert.ok(hook && typeof hook === "object")
})
