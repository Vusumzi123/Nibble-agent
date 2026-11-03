import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { mockClient, tempDir, tempHome } from "./test-utils.ts"
import { HEARTBEAT_FIXED_PROMPT } from "./heartbeat.ts"
import { openWorkStore } from "./work-store/sqlite.ts"
import { emptyScheduler } from "./work-queue.ts"
import { createTask, settleTask } from "./user-tasks.ts"

// Isolate HOME before the hook module resolves anything home-scoped.
const TEST_HOME = tempHome("hbhook-home-")
void TEST_HOME
const { default: createHook } = await import("../heartbeat-hook.ts")

const HOUR = 3_600_000
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await delay(25)
  }
  throw new Error("waitFor: condition not met within timeout")
}

// Phase 1: one ordered work queue, keyed by kind. v2 persists
// `{version, items, scheduler}`; legacy arrays still appear in migrations.
const queueItems = (q: any) => (Array.isArray(q) ? q : Array.isArray(q?.items) ? q.items : [])
const missionsIn = (q: any) => queueItems(q).filter((i: any) => i?.kind === "mission")
const sideIn = (q: any) => queueItems(q).filter((i: any) => i?.kind === "staleness")

async function project(lines: string[]): Promise<string> {
  const dir = await tempDir("hbhook-proj-")
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), [...lines, ""].join("\n"), "utf8")
  return dir
}

async function writeMission(dir: string): Promise<void> {
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", "drain.md"),
    [
      "---",
      "id: drain",
      "title: Drain conversation backlog into the vault",
      "schedule: every 1m",
      "priority: 5",
      "menus: [day, night]",
      "min_level: 2",
      'agent: ""',
      "enabled: true",
      "---",
      "",
      "Do the drain thing.",
      "",
    ].join("\n"),
    "utf8",
  )
}

async function writeMissionWithCandidacy(
  dir: string,
  id: string,
  title: string,
  candidacy: string,
): Promise<void> {
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      "schedule: every 1m",
      "menus: [day, night]",
      "min_level: 2",
      'agent: ""',
      `candidacy: ${candidacy}`,
      "enabled: true",
      "---",
      "",
      "Do the mission thing.",
      "",
    ].join("\n"),
    "utf8",
  )
}

// Mission production now happens in chron; seed the store directly so these
// consumer tests exercise the claim -> dispatch -> settle path with one row.
async function withStore<T>(dir: string, fn: (store: Awaited<ReturnType<typeof openWorkStore>>) => T): Promise<T> {
  const store = await openWorkStore({ stateDir: join(dir, ".opencode", "state") })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

async function seedMissionIntent(
  dir: string,
  id = "drain",
  kind: "mission" | "staleness" = "mission",
): Promise<void> {
  const now = Date.now()
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await withStore(dir, (store) =>
    store.enqueue(
      [
        {
          id: `mission:${id}`,
          kind,
          producer: "chron:missions",
          priority: 5,
          enqueued_ms: now,
          expires_ms: now + 24 * HOUR,
          requeue_count: 0,
          payload: {
            mission: id,
            occurrence_ms: now,
            level: 3,
            quiet: false,
            sleep_status: "awake",
            signals: {},
          },
        },
      ],
      now,
    ),
  )
}

async function storeRows(dir: string) {
  return withStore(dir, (store) => store.dump().items)
}

async function seedItems(
  dir: string,
  items: Parameters<Awaited<ReturnType<typeof openWorkStore>>["enqueue"]>[0],
  now = Date.now(),
): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await withStore(dir, (store) => store.enqueue(items, now))
}

async function seedRunningClaim(
  dir: string,
  item: Parameters<Awaited<ReturnType<typeof openWorkStore>>["enqueue"]>[0][number],
  owner = "crashed-owner",
  now = Date.now(),
): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const store = await openWorkStore({ stateDir, now: () => now })
  try {
    store.leaseAcquire(owner, now)
    store.enqueue([item], now)
    store.claim(item.id, {
      ...emptyScheduler(),
      served: { [item.kind]: 1 },
      last_kind: item.kind,
      updated_ms: now,
    }, owner, now)
    store.leaseRelease(owner)
  } finally {
    store.close()
  }
}

async function stealLease(dir: string, owner = "thief"): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  const store = await openWorkStore({ stateDir })
  try {
    const current = store.leaseHolder()
    if (current) store.leaseRelease(current.owner)
    store.leaseAcquire(owner)
  } finally {
    store.close()
  }
}

async function leaseRow(dir: string) {
  return withStore(dir, (store) => store.leaseHolder())
}

async function writeBurstMission(dir: string, id: string): Promise<void> {
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `title: ${id}`,
      "schedule: every 1h",
      "priority: 5",
      "menus: [day, night]",
      "min_level: 1",
      "candidacy: always",
      'agent: ""',
      "enabled: true",
      "---",
      "",
      `Do the ${id} thing.`,
      "",
    ].join("\n"),
    "utf8",
  )
}

async function seedMissionQueue(dir: string, ids: string[]): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const now = Date.now()
  await withStore(dir, (store) =>
    store.enqueue(
      ids.map((id, index) => ({
        id: `mission:${id}`,
        kind: "mission" as const,
        producer: "chron:missions",
        enqueued_ms: now - (ids.length - index) * 1_000,
        requeue_count: 0,
      })),
      now,
    ),
  )
}

function burstClient() {
  const calls = { create: 0, prompts: [] as any[], ids: [] as string[] }
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 10, output: 5 } },
            parts: [{ type: "text", text: "done" }],
          },
        ],
      }),
      create: async () => {
        calls.create++
        const id = `ses_burst_${calls.create}`
        calls.ids.push(id)
        return { data: { id } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
}

async function driveChildren(client: ReturnType<typeof burstClient>, hooks: any, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await waitFor(() => client.calls.prompts.length >= i + 1, 8000)
    const id = client.calls.prompts[i].path.id
    await delay(5)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: id } } } as any)
  }
}

async function seedDrainIntent(dir: string): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const now = Date.now()
  await withStore(dir, (store) =>
    store.enqueue(
      [
        {
          id: "drain-pass",
          kind: "drain-pass",
          producer: "chron:drain",
          priority: 3,
          enqueued_ms: now,
          requeue_count: 0,
        },
      ],
      now,
    ),
  )
}

// Seed the default opencode DB (under the test HOME) with one unconsumed turn
// owned by `dir`, so `computeDigest` reports turns-pending.
async function seedTurns(dir: string, tag: string): Promise<void> {
  const dataDir = join(TEST_HOME, ".local", "share", "opencode")
  await mkdir(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, "opencode.db"))
  const now = Date.now()
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  const sid = `s_${tag}`
  const mid = `m_${tag}`
  db.prepare("INSERT OR REPLACE INTO session (id, parent_id, directory, time_updated, title) VALUES (?, ?, ?, ?, ?)").run(
    sid,
    null,
    dir,
    now,
    "s",
  )
  db.prepare("INSERT OR REPLACE INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    mid,
    sid,
    now - 60_000,
    JSON.stringify({ role: "user" }),
  )
  db.prepare("INSERT OR REPLACE INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    `${mid}-p`,
    mid,
    JSON.stringify({ type: "text", text: "pending turn" }),
  )
  db.close()
}

async function writePendingBacklog(dir: string): Promise<void> {
  await mkdir(join(dir, ".opencode", "state"), { recursive: true })
  const now = new Date().toISOString()
  await writeFile(
    join(dir, ".opencode", "state", "backlog.ndjson"),
    JSON.stringify({
      id: "bl-1",
      created: now,
      updated: now,
      source: "conversation",
      kind: "task",
      payload: { title: "t", detail: "", commands: [], files: [] },
      level_required: 2,
      priority: 0,
      status: "pending",
      channel_notified: null,
      awaiting_reply: false,
      jev_decision: null,
      result: null,
      view_ref: null,
      links: [],
    }) + "\n",
    "utf8",
  )
}

const abstainingSpawner = async () => ({
  code: 0,
  stdout: JSON.stringify({
    kind: "choice",
    value: null,
    confidence: 0,
    abstained: true,
    provider: "openjev",
    backend: "test",
    latencyMs: 1,
  }),
  stderr: "",
})

async function readTickLog(dir: string): Promise<any[]> {
  try {
    const raw = await readFile(join(dir, ".opencode", "logs", "heartbeat.log"), "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function readTickState(dir: string): Promise<{ last_tick?: number; ticks?: number }> {
  try {
    return JSON.parse(await readFile(join(dir, ".opencode", "state", "heartbeat.json"), "utf8"))
  } catch {
    return {}
  }
}

async function readMood(dir: string): Promise<{ valence?: number; arousal?: number }> {
  try {
    return JSON.parse(await readFile(join(dir, ".opencode", "state", "mood.json"), "utf8"))
  } catch {
    return {}
  }
}

async function readBacklog(dir: string): Promise<any[]> {
  try {
    const raw = await readFile(join(dir, ".opencode", "state", "backlog.ndjson"), "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

// A client whose child session reports tokens + a final assistant line, so the
// ledger's token_cost and the backlog result can be asserted for real.
function missionClient(opts: { promptOk?: boolean } = {}) {
  const calls = { create: 0, prompts: [] as any[] }
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 120, output: 40 } },
            parts: [{ type: "text", text: "drained 2 turns" }],
          },
        ],
      }),
      create: async () => {
        calls.create++
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return opts.promptOk === false
          ? { error: { message: "boom" } }
          : { response: { ok: true, status: 200 } }
      },
    },
  }
}

// The test seam for the JEV bridge: a fake spawner answering `mission:drain`.
const missionSpawner = async () => ({
  code: 0,
  stdout: JSON.stringify({
    kind: "choice",
    value: "mission:drain",
    confidence: 0.9,
    abstained: false,
    provider: "openjev",
    backend: "test",
    latencyMs: 1,
  }),
  stderr: "",
})

const LEDGER_FIELDS = [
  "ts",
  "event",
  "tick",
  "digest_hash",
  "level",
  "quiet",
  "candidates",
  "bias",
  "verdict",
  "mission",
  "outcome",
  "token_cost",
  "mood_event",
  "gate",
  "reason",
]

// A fresh, never-ticked project at level 2 with no signals is all-quiet: the
// deterministic pre-gate must end the tick as NO_REPLY with zero LLM calls —
// no child session is created and no JEV provider runs on this path.
test("zero-LLM quiet path: all-quiet tick at L2 logs the full ledger line and creates no session", async () => {
  const dir = await project(["autonomy:", "  level: 2"])
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const ticks = await readTickLog(dir)
  assert.equal(ticks.length, 1)
  const t = ticks[0]
  // Full §7 line shape, every field present and typed.
  for (const field of LEDGER_FIELDS) assert.ok(field in t, `missing ${field}`)
  assert.equal(t.event, "tick")
  assert.equal(typeof t.ts, "string")
  assert.equal(t.tick, 1)
  assert.equal(typeof t.digest_hash, "string")
  assert.equal(t.level, 2)
  assert.equal(typeof t.quiet, "boolean")
  assert.deepEqual(t.candidates, [])
  assert.equal(typeof t.bias.mood, "number")
  assert.equal(t.verdict, "no_reply")
  assert.equal(t.mission, null)
  assert.equal(t.outcome, "silent")
  assert.equal(t.token_cost, 0)
  assert.equal(t.mood_event, null)
  assert.equal(t.gate, "queues")
  assert.equal(t.reason, "empty")

  // Zero LLM calls: no child session was ever created or prompted.
  assert.equal(client.calls.create, 0)
  assert.equal(client.calls.prompts.length, 0)

  const state = await readTickState(dir)
  assert.equal(state.ticks, 1)
  assert.ok((state.last_tick ?? 0) > 0)

  // The lease was released after the tick.
  await waitFor(async () => (await leaseRow(dir)) === null)
  void hooks
})

// L0 disables the timer entirely: the first wake sleeps on the cap, so no tick
// log line appears — frequency is ignored at L0.
test("L0 gating: level 0 sleeps, no tick fires", async () => {
  const dir = await project(["autonomy:", "  level: 0"])
  const client = mockClient()
  await createHook({ client, directory: dir } as any)

  await delay(250)
  assert.deepEqual(await readTickLog(dir), [])
  assert.equal(client.calls.create, 0)
  const state = await readTickState(dir)
  assert.ok((state.ticks ?? 0) === 0)
})

// `frequency: off` is the other sleep-on path (hot dial — flipping it back
// re-enables within one wake cap without a restart).
test("off gating: frequency off sleeps, no tick fires", async () => {
  const dir = await project(["autonomy:", "  level: 3", "  heartbeat:", "    frequency: off"])
  const client = mockClient()
  await createHook({ client, directory: dir } as any)

  await delay(250)
  assert.deepEqual(await readTickLog(dir), [])
  assert.equal(client.calls.create, 0)
  const state = await readTickState(dir)
  assert.ok((state.ticks ?? 0) === 0)
})

// The `heartbeat: enabled: false` kill switch is the same sleep-on path, hot.
test("kill switch: heartbeat.enabled false sleeps, no tick fires", async () => {
  const dir = await project(["autonomy:", "  level: 3", "", "heartbeat:", "  enabled: false"])
  const client = mockClient()
  await createHook({ client, directory: dir } as any)

  await delay(250)
  assert.deepEqual(await readTickLog(dir), [])
  assert.equal(client.calls.create, 0)
  assert.ok((await readTickState(dir)).ticks === undefined)
})

// A fresh lock held by another instance (the parallel-server case, §12.1
// step 4) skips the tick: no tick log, no state update, the foreign lock is
// left standing.
test("store-unavailable: a broken state path skips the tick without a session", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 2",
    "",
    "paths:",
    "  state: state-file",
  ])
  await writeFile(join(dir, "state-file"), "not a directory", "utf8")
  const client = mockClient()
  await createHook({ client, directory: dir } as any)

  await delay(250)
  assert.deepEqual(await readTickLog(dir), [], "the tick is skipped, not crashed")
  assert.equal(client.calls.create, 0)
})

test("lock-held skip: a fresh live ownership lease skips the tick and is not stolen", async () => {
  const dir = await project(["autonomy:", "  level: 2"])
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await withStore(dir, (store) => store.leaseAcquire("foreign", Date.now()))

  const client = mockClient()
  await createHook({ client, directory: dir } as any)

  await delay(250)
  assert.deepEqual(await readTickLog(dir), [])
  assert.equal(client.calls.create, 0)
  const state = await readTickState(dir)
  assert.ok((state.ticks ?? 0) === 0)
  // The foreign lease stands untouched.
  assert.equal((await leaseRow(dir))?.owner, "foreign")
})

// §5.1 execution lock: a foreign mission.lock means another agent is working.
// The tick skips dispatch, journals gate:lock, creates no session, and leaves
// lanes.json byte-identical (no enqueue/prune write reaches disk).
// The full mission-execution path (§12.1 step 6 + §7 recording): JEV verdict
// → one child session with the fixed brief → session.idle → ledger line with
// token_cost → backlog record + one-way view refresh → lock released.
test("mission execution: verdict spawns one child, ledger + backlog record the outcome", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "  mission_token_budget: 50",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await writeMission(dir)
  await seedMissionIntent(dir)
  const client = missionClient()
  const hooks = await createHook({ client, directory: dir, spawner: missionSpawner } as any)

  // 1. The tick creates exactly one child and prompts the fixed brief.
  await waitFor(() => client.calls.prompts.length > 0)
  assert.equal(client.calls.create, 1)
  const body = client.calls.prompts[0].body
  const text: string = body.parts[0].text
  assert.ok(text.includes(HEARTBEAT_FIXED_PROMPT))
  assert.ok(text.includes("Mission: drain — Drain conversation backlog into the vault"))
  assert.ok(text.includes("Do the drain thing."))
  assert.ok(text.includes("~50 tokens"), "the child is told the configured budget")

  // 2. The child idles → the tick completes.
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  // 3. Full ledger line for a completed mission.
  const [t] = await readTickLog(dir)
  for (const field of LEDGER_FIELDS) assert.ok(field in t, `missing ${field}`)
  assert.equal(t.tick, 1)
  assert.equal(t.verdict, "mission:drain")
  assert.equal(t.mission, "drain")
  assert.equal(t.outcome, "completed")
  assert.equal(t.token_cost, 160) // input 120 + output 40
  assert.equal(t.over_budget, true, "160 measured tokens exceed the 50-token budget")
  assert.equal(t.session, "ses_child", "the ledger carries the child session id")
  assert.equal(t.mood_event, null)
  assert.equal(t.reason, "none")
  assert.ok(t.candidates.includes("drain"), String(t.candidates))

  // 4. The mission recorded itself in the backlog with the reserved result.
  const entries = await readBacklog(dir)
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.source, "heartbeat")
  assert.equal(entry.status, "done")
  assert.equal(entry.payload.title, "Drain conversation backlog into the vault")
  assert.equal(entry.result.ok, true)
  assert.equal(entry.result.token_cost, 160)
  assert.equal(entry.result.summary, "drained 2 turns")

  // 5. The derived view was refreshed one-way.
  const view = await readFile(join(dir, "Brain", "Backlog.md"), "utf8")
  assert.ok(view.includes("Drain conversation backlog into the vault"))

  // 6. Single-flight released: exactly one session, both locks gone.
  assert.equal(client.calls.create, 1)
  await waitFor(async () => (await leaseRow(dir)) === null)
  await waitFor(async () => {
    try {
      await readFile(join(dir, ".opencode", "state", "mission.lock"), "utf8")
      return false
    } catch {
      return true
    }
  })
})

// A queued mission is a reservation: it runs even when its `roll:` gate can
// never pass again. This is the fix for the free-run ghost item.
test("a queued mission runs even when its candidacy no longer passes", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeMissionWithCandidacy(dir, "free", "Free", "roll:0")
  await seedMissionQueue(dir, ["free"])

  const client = missionClient()
  const hooks = await createHook({ client, directory: dir } as any)
  await waitFor(() => client.calls.prompts.length > 0)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "mission:free")
  assert.equal(tick.mission, "free")
  assert.equal(client.calls.create, 1)

  assert.equal(
    (await storeRows(dir)).filter((row) => row.kind === "mission").length,
    0,
    "the reservation is consumed",
  )
})

// A pool with an item that is not runnable must not be labelled "empty".
test("an unrunnable pool item is labelled no-runnable, not empty", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await seedMissionQueue(dir, ["gone"])

  const client = mockClient()
  await createHook({ client, directory: dir } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "no_reply")
  assert.equal(tick.gate, "queues")
  assert.equal(tick.reason, "no-runnable")
  assert.equal(tick.queues, 1)
  assert.equal(client.calls.create, 0)

  await delay(200)
  assert.equal(
    (await readTickLog(dir)).length,
    1,
    "no-runnable sleeps to the frequency instead of spinning at 0",
  )
})

// A declined mission drops its queue item and records the result without
// treating the decline as a failure.
test("a declined mission drops the item and records the result", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeMission(dir)
  await seedMissionIntent(dir)

  const calls = { creates: 0, prompts: [] as any[] }
  const client = {
    ...mockClient(),
    session: {
      get: async () => ({ data: {} }),
      create: async () => {
        calls.creates++
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 10, output: 5 } },
            parts: [
              {
                type: "tool",
                tool: "mission_result",
                state: { input: { status: "declined", summary: "nothing", reason: "in-sync" } },
              },
            ],
          },
        ],
      }),
    },
  }

  const hooks = await createHook({ client, directory: dir } as any)
  await waitFor(() => calls.prompts.length === 1)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0)
  await delay(100)
  assert.equal(calls.creates, 1, "one item, one child")

  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "mission:drain")
  assert.equal(tick.mission, "drain")
  assert.equal(tick.outcome, "completed")
  assert.equal(tick.reason, "declined")
  assert.equal(tick.result_status, "declined")
  assert.equal(tick.mood_event, null, "a decline is not a failure")
  assert.deepEqual(await readBacklog(dir), [], "a decline is not backlog-recorded")

  assert.equal(
    (await storeRows(dir)).filter((row) => row.kind === "mission").length,
    0,
    "the declined item dropped",
  )
})

// A failed mission run: outcome error feeds `mission_failure` (shared mood
// feed), the backlog record lands as failed with ok:false, and the ledger
// carries both facts.
test("mission failure: outcome error feeds mission_failure and records a failed backlog entry", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "  mission_token_budget: 50",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await writeMission(dir)
  await seedMissionIntent(dir)
  const client = missionClient({ promptOk: false })
  const hooks = await createHook({ client, directory: dir, spawner: missionSpawner } as any)

  await waitFor(() => client.calls.prompts.length > 0)
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [t] = await readTickLog(dir)
  assert.equal(t.verdict, "mission:drain")
  assert.equal(t.outcome, "error")
  assert.equal(t.mood_event, "mission_failure")
  // Structured error record: the failed provider call is diagnosable from
  // the ledger line alone (phase + message, not just a bare outcome).
  const err = t.error as { phase?: string; name?: string; message?: string } | undefined
  assert.ok(err, "error ticks must carry a structured error record")
  assert.equal(err.phase, "dispatch")
  assert.equal(err.message, "boom")

  // The shared feed persisted the mood delta (0 → -0.08).
  const mood = await readMood(dir)
  assert.ok((mood.valence ?? 0) < 0)

  const entries = await readBacklog(dir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].source, "heartbeat")
  assert.equal(entries[0].status, "failed")
  assert.equal(entries[0].result.ok, false)
})

// A tick whose gap since the previous tick is ≥ long_silence_factor ×
// frequency feeds `long_silence` through the shared feed; with an empty lane
// queue the tick is a silent no-action tick (`gate: "queues"`) and creates no
// session — the queue emptiness is decided before any JEV call.
test("long_silence: a 36h gap feeds the mood event; an empty queue ticks silently", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const gap = 36 * HOUR // = 3 × the default 12h frequency
  await writeFile(
    join(stateDir, "heartbeat.json"),
    JSON.stringify({ last_tick: Date.now() - gap, ticks: 0 }),
    "utf8",
  )

  const client = mockClient()
  await createHook({ client, directory: dir } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [t] = await readTickLog(dir)
  assert.equal(t.tick, 1)
  assert.equal(t.mood_event, "long_silence")
  assert.equal(t.verdict, "no_reply")
  assert.equal(t.outcome, "silent")
  assert.equal(t.reason, "empty")
  assert.equal(t.gate, "queues")

  // The shared feed persisted the arousal dip (0.3 → 0.2).
  const mood = await readMood(dir)
  assert.ok((mood.arousal ?? 1) < 0.3)
  assert.equal(client.calls.create, 0)
})

// With work queued but the decision gate off, the no_reply must still be
// labelled with WHY (no silent guessing) — and never create a session.
// B7 day-side adaptive backoff (missions-plan §7, §11 — lands in card 6
// alongside quiet.backoff): repeated NO_REPLY ticks on an IDENTICAL digest
// stretch the day cadence ×2 at streak 2 (the day twin of the §17.8 dream
// ladder); a mission execution resets the streak. The `wakeCapMs` seam
// shrinks the 60 s wake ceiling so the loop re-checks due-ness on a test
// timescale — the due MATH is what is under test.
test("consumer session: a 12-item burst runs 10, leaves 2, and wakes immediately", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "consumer:",
    "  max_items_per_tick: 10",
  ])
  const ids = Array.from({ length: 12 }, (_, i) => `burst-${i}`)
  for (const id of ids) await writeBurstMission(dir, id)
  await seedMissionQueue(dir, ids)

  const client = burstClient()
  const hooks = await createHook({ client, directory: dir } as any)
  await driveChildren(client, hooks, 12)

  await waitFor(
    async () => (await readTickLog(dir)).filter((t: any) => t.stopped !== undefined).length >= 2,
    8000,
  )
  const sessions = (await readTickLog(dir)).filter((t: any) => t.stopped !== undefined)
  assert.equal(sessions[0].items_run, 10)
  assert.equal(sessions[0].items_left, 2)
  assert.equal(sessions[0].stopped, "max-items")
  assert.equal(sessions[1].items_run, 2)
  assert.equal(sessions[1].stopped, "empty")
  assert.equal(client.calls.create, 12, "the cap split the burst across two sessions")
})

test("consumer caps: a wall cap stops between items", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeBurstMission(dir, "wall-a")
  await writeBurstMission(dir, "wall-b")
  await seedMissionQueue(dir, ["wall-a", "wall-b"])

  const client = burstClient()
  const hooks = await createHook({
    client,
    directory: dir,
    consumer: { max_wall_minutes: 0.0002 },
  } as any)
  await waitFor(() => client.calls.prompts.length >= 1, 8000)
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: client.calls.prompts[0].path.id } },
  } as any)

  await waitFor(
    async () => (await readTickLog(dir)).some((t: any) => t.stopped === "max-wall"),
    8000,
  )
  const line = (await readTickLog(dir)).find((t: any) => t.stopped === "max-wall")!
  assert.equal(line.items_run, 1, "the item that crossed the cap completed")
})

test("consumer caps: a token budget stops between items", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeBurstMission(dir, "tok-a")
  await writeBurstMission(dir, "tok-b")
  await seedMissionQueue(dir, ["tok-a", "tok-b"])

  const client = burstClient()
  const hooks = await createHook({
    client,
    directory: dir,
    consumer: { token_budget: 1 },
  } as any)
  await waitFor(() => client.calls.prompts.length >= 1, 8000)
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: client.calls.prompts[0].path.id } },
  } as any)

  await waitFor(
    async () => (await readTickLog(dir)).some((t: any) => t.stopped === "token-budget"),
    8000,
  )
  const line = (await readTickLog(dir)).find((t: any) => t.stopped === "token-budget")!
  assert.equal(line.items_run, 1)
})

test("recovery: a crashed running row is retried with attempt 2", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeBurstMission(dir, "recover-a")
  await seedRunningClaim(dir, {
    id: "mission:recover-a",
    kind: "mission",
    producer: "chron:missions",
    enqueued_ms: Date.now() - 60_000,
    requeue_count: 0,
  })

  const client = burstClient()
  const hooks = await createHook({ client, directory: dir } as any)
  await waitFor(() => client.calls.prompts.length >= 1, 8000)
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: client.calls.prompts[0].path.id } },
  } as any)
  await waitFor(
    async () => (await readTickLog(dir)).some((t: any) => t.verdict === "mission:recover-a"),
    8000,
  )
  const line = (await readTickLog(dir)).find((t: any) => t.verdict === "mission:recover-a")!
  assert.equal(line.attempt, 2, "the recovered claim is the second attempt")
  assert.equal((await storeRows(dir)).length, 0)
})

test("recovery: a settled user task row is dropped instead of leaking a slot", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  const stateDir = join(dir, ".opencode", "state")
  const task = await createTask(stateDir, { title: "already done", prompt: "p" }, { nowMs: Date.now() })
  assert.equal(task.ok, true)
  if (!task.ok) return
  await settleTask(stateDir, task.id, "done", { summary: "done" })
  await seedRunningClaim(dir, {
    id: `user-task:${task.id}`,
    kind: "user-task",
    producer: "user-tasks",
    enqueued_ms: Date.now() - 60_000,
    requeue_count: 0,
    payload: { task_ref: task.id, title: "already done", priority: 5 },
  })

  const client = mockClient()
  await createHook({ client, directory: dir } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.stopped, "empty")
  assert.equal(client.calls.create, 0)
  assert.equal(
    (await storeRows(dir)).filter((row) => row.kind === "user-task").length,
    0,
    "the recovered stale row is dropped",
  )
})

test("consumer caps: lease loss stops the session between items", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeBurstMission(dir, "lease-a")
  await writeBurstMission(dir, "lease-b")
  await seedMissionQueue(dir, ["lease-a", "lease-b"])

  const client = burstClient()
  const hooks = await createHook({ client, directory: dir } as any)
  await waitFor(() => client.calls.prompts.length >= 1, 8000)
  await stealLease(dir)
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: client.calls.prompts[0].path.id } },
  } as any)

  await waitFor(
    async () => (await readTickLog(dir)).some((t: any) => t.stopped === "lease-lost"),
    8000,
  )
  const line = (await readTickLog(dir)).find((t: any) => t.stopped === "lease-lost")!
  assert.equal(line.items_run, 0, "the stolen claim's result is discarded")
  assert.equal(client.calls.create, 1, "the second item waits for a new session")
})

test("no backoff stretching: identical no-reply ticks keep the raw cadence", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  const client = missionClient()
  await createHook({ client, directory: dir, wakeCapMs: 25 } as any)

  const forceDue = async (gapMs: number): Promise<void> => {
    const file = join(dir, ".opencode", "state", "heartbeat.json")
    const cur = JSON.parse(await readFile(file, "utf8").catch(() => "{}"))
    await writeFile(file, JSON.stringify({ ...cur, last_tick: Date.now() - gapMs }), "utf8")
  }

  await waitFor(async () => (await readTickLog(dir)).length >= 1)
  await forceDue(12 * HOUR)
  await waitFor(async () => (await readTickLog(dir)).length >= 2)

  const state: any = await readTickState(dir)
  assert.equal(state.noop_streak, undefined, "the consumer keeps no no-op streak")
  assert.equal(state.noop_hash, undefined)

  // The third base-frequency window is still due: no ×2/×4 stretch.
  await forceDue(12 * HOUR)
  await waitFor(async () => (await readTickLog(dir)).length >= 3)
})

// A provider abstain is a fallback, not a verdict: pending work must still
// dispatch. The ledger names the fallback so the decision is attributable.
// A client with distinct session ids per child so two children in one tick
// can idle independently (missionClient's fixed id would collide).
function laneClient(opts: { abortFails?: boolean } = {}) {
  const calls = {
    create: 0,
    creates: [] as any[],
    prompts: [] as any[],
    ids: [] as string[],
    aborts: [] as any[],
  }
  // P4c: a resume summary spawns the tool-free session-summarizer. Its reply
  // must be strict JSON; every other session keeps returning the child rows.
  const summarizerSessions = new Set<string>()
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      create: async (args: any) => {
        calls.create++
        calls.creates.push(args)
        const id = `ses_lane_${calls.create}`
        calls.ids.push(id)
        return { data: { id } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        if (args?.body?.agent === "session-summarizer") summarizerSessions.add(args.path.id)
        return { response: { ok: true, status: 200 } }
      },
      abort: async (args: any) => {
        calls.aborts.push(args)
        if (opts.abortFails) return { response: { ok: false, status: 500 }, error: { message: "abort refused" } }
        return { response: { ok: true, status: 200 } }
      },
      messages: async (args: any) =>
        summarizerSessions.has(args?.path?.id)
          ? {
              data: [
                {
                  info: { role: "assistant", id: "a2", tokens: { input: 5, output: 5 } },
                  parts: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        done: "drained 1 turn",
                        remaining: "finish the lane",
                        next_steps: ["finish the lane"],
                        notes: "resume carries the summary",
                      }),
                    },
                  ],
                },
              ],
            }
          : {
              data: [
                {
                  info: { role: "assistant", id: "a1", tokens: { input: 100, output: 20 } },
                  parts: [
                    {
                      type: "tool",
                      tool: "mission_result",
                      state: { input: { status: "completed", summary: "done" } },
                    },
                    { type: "text", text: "done" },
                  ],
                },
              ],
            },
    },
  }
}

/** P4c: resolve the summarizer child so settlement does not wait its 90 s cap. */
async function settleSummarizer(client: any, hooks: any, timeoutMs = 8000): Promise<any> {
  await waitFor(
    () => client.calls.prompts.some((p: any) => p.body?.agent === "session-summarizer"),
    timeoutMs,
  )
  const prompt = client.calls.prompts.find((p: any) => p.body?.agent === "session-summarizer")
  await delay(50)
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: prompt.path.id } },
  } as any)
  return prompt
}


test("a failed abort is recorded as an error, never a clean stop", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
    "",
    "drain:",
    "  consumer: false",
    "",
    "scheduler:",
    "  fair: false",
    "",
  ])
  await writeMission(dir)
  await seedMissionIntent(dir)
  await seedTurns(dir, "lanes-abort-fail")

  const client = laneClient({ abortFails: true })
  await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 50,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.outcome, "error", "a failed abort is not booked as a timeout")
  assert.equal(tick.runs[0].aborted, false)
  assert.equal(tick.runs[0].abort_error, "abort refused")
  assert.equal(tick.runs[0].requeued, false)
  assert.equal(tick.runs[0].aborted, false)
  assert.equal(tick.runs[0].abort_error, "abort refused")

  assert.equal(
    (await storeRows(dir)).filter((row) => row.kind === "mission").length,
    0,
    "a failed abort drops the item instead of requeueing it",
  )
})

// Plan 5.2 / P3c: the stall watchdog measures silence, not wall-clock.
const stallProject = () =>
  project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
    "",
    "drain:",
    "  consumer: false",
    "",
    "scheduler:",
    "  fair: false",
    "",
  ])

const partEvent = (sessionID: string, part: Record<string, unknown> = {}) =>
  ({
    event: {
      type: "message.part.updated",
      properties: { part: { type: "text", sessionID, ...part } },
    },
  }) as any

test("a stall watchdog keeps waiting while the child is active", async () => {
  const dir = await stallProject()
  await writeMission(dir)
  await seedMissionIntent(dir)
  await seedTurns(dir, "stall-active")

  const client = laneClient()
  const hooks = await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 200,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.prompts.length === 1, 8000)
  const sid = client.calls.ids[0]
  // Keep talking for well past the 200 ms window, in sub-window slices.
  for (let i = 0; i < 6; i++) {
    await delay(100)
    await hooks.event(partEvent(sid))
  }
  assert.equal(client.calls.aborts.length, 0, "activity kept the child alive")

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.outcome, "completed")
  assert.equal(tick.runs[0].requeued, false)
})

test("silence during an open shell tool is exempt until the tool closes", async () => {
  const dir = await stallProject()
  await writeMission(dir)
  await seedMissionIntent(dir)
  await seedTurns(dir, "stall-shell")

  const client = laneClient()
  const hooks = await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 150,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.prompts.length === 1, 8000)
  const sid = client.calls.ids[0]
  await hooks.event(
    partEvent(sid, { type: "tool", tool: "bash", callID: "c1", state: { status: "running" } }),
  )
  await delay(500)
  assert.equal(client.calls.aborts.length, 0, "a long silent shell call is exempt")

  await hooks.event(
    partEvent(sid, { type: "tool", tool: "bash", callID: "c1", state: { status: "completed" } }),
  )
  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } } as any)
  await settleSummarizer(client, hooks)
  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.outcome, "timeout")
  assert.equal(tick.runs[0].stop_reason, "stall")
  assert.equal(tick.runs[0].last_activity, "tool:bash")
  assert.ok(tick.runs[0].stalled_for_ms >= 100, "the ledger records the silence")
})

test("descendant activity keeps the mission child alive (no task exemption)", async () => {
  const dir = await stallProject()
  await writeMission(dir)
  await seedMissionIntent(dir)
  await seedTurns(dir, "stall-descendant")

  const client = laneClient()
  const hooks = await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 200,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.prompts.length === 1, 8000)
  const sid = client.calls.ids[0]
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "ses_sub", parentID: sid } } },
  } as any)
  for (let i = 0; i < 6; i++) {
    await delay(100)
    await hooks.event(partEvent("ses_sub"))
  }
  assert.equal(client.calls.aborts.length, 0, "the sub-agent's events bubbled up")

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.outcome, "completed")
})

test("a background task child is aborted when its mission child aborts", async () => {
  const dir = await stallProject()
  await writeMission(dir)
  await seedMissionIntent(dir)
  await seedTurns(dir, "orphan-abort")

  const client = laneClient()
  const hooks = await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 100,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.prompts.length === 1, 8000)
  const sid = client.calls.ids[0]
  // A background task child: opencode attaches no abort listener, so the
  // mission abort does not cascade to it on its own (P3a-f2).
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "ses_bg", parentID: sid } } },
  } as any)
  await hooks.event(partEvent("ses_bg"))
  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } } as any)
  await waitFor(() => client.calls.aborts.length === 2, 8000)
  await settleSummarizer(client, hooks)

  const abortedIds = client.calls.aborts.map((a) => a.path.id)
  assert.ok(abortedIds.includes(sid), "the mission child is aborted")
  assert.ok(abortedIds.includes("ses_bg"), "the background child is cancelled too")

  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.outcome, "timeout")
  assert.equal(tick.runs[0].orphan_abort, 1)
  assert.equal(tick.runs[0].orphan_abort_error, undefined)
  assert.equal(tick.runs[0].orphan_abort, 1)
})

test("a foreground task child already settled is not double-aborted", async () => {
  const dir = await stallProject()
  await writeMission(dir)
  await seedMissionIntent(dir)
  await seedTurns(dir, "orphan-foreground")

  const client = laneClient()
  const hooks = await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 100,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.prompts.length === 1, 8000)
  const sid = client.calls.ids[0]
  // opencode's foreground listener cancels this child and it goes idle before
  // the mission abort; the harness must not abort it a second time.
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "ses_fg", parentID: sid } } },
  } as any)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_fg" } } } as any)

  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } } as any)
  await delay(150)
  await settleSummarizer(client, hooks)

  assert.equal(client.calls.aborts.length, 1, "only the mission child is aborted")
  assert.equal(client.calls.aborts[0].path.id, sid)

  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.outcome, "timeout")
  assert.equal(tick.runs[0].orphan_abort, undefined)
  assert.equal(tick.runs[0].orphan_abort, undefined)
})

// P4c (§5.5/§5.6): the resume item's summary reaches the next dispatch as the
// === RESUMED MISSION === block, and the ledger records the seam.
test("a resumed mission carries the === RESUMED MISSION === block into the next prompt", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
    "",
    "drain:",
    "  consumer: false",
    "",
    "scheduler:",
    "  fair: false",
    "",
  ])
  await writeMission(dir)
  await seedMissionIntent(dir)
  await seedTurns(dir, "resume-block")

  const client = laneClient()
  const hooks = await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 50,
    abortConfirmMs: 50,
    wakeCapMs: 25,
  } as any)

  // Tick 1: the child stalls, the summarizer runs, the item resumes.
  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[0] } } } as any)
  await settleSummarizer(client, hooks)
  await waitFor(async () => (await readTickLog(dir)).length >= 1, 8000)
  await waitFor(
    async () => (await readTickLog(dir)).some((t: any) => t.stopped !== undefined),
    8000,
  )
  const firstSession = (await readTickLog(dir)).find((t: any) => t.stopped !== undefined)!
  assert.equal(firstSession.items_run, 1)
  assert.equal(
    firstSession.stopped,
    "no-runnable",
    "the timeout requeue waits for the next session",
  )

  // Force the next tick due.
  const stateFile = join(dir, ".opencode", "state", "heartbeat.json")
  const cur = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}"))
  await writeFile(stateFile, JSON.stringify({ ...cur, last_tick: Date.now() - 13 * HOUR }), "utf8")

  const childPrompts = () =>
    client.calls.prompts.filter((p: any) => p.body?.agent !== "session-summarizer")
  await waitFor(() => childPrompts().length === 2, 8000)
  const resumed = childPrompts()[1]
  const text = String(resumed.body.parts[0].text)
  assert.match(text, /^=== RESUMED MISSION — previous attempt stalled ===$/m)
  assert.match(text, /This mission was stopped for 1 minute without activity on/)
  assert.match(text, new RegExp(`session ${client.calls.ids[0]}, aborted=true`))
  assert.match(text, /^Completed: drained 1 turn$/m)
  assert.match(text, /^Not finished: finish the lane$/m)
  assert.match(text, /^Continue from there — do not restart work that is already done\.$/m)
  assert.match(text, /^ {2}1\. finish the lane$/m)
  assert.match(text, /^Notes: resume carries the summary$/m)
  assert.match(text, /^=== END RESUMED MISSION ===$/m)

  // Tick 2 completes normally.
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: resumed.path.id } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).length >= 2, 8000)
  const ticks = await readTickLog(dir)
  assert.equal(ticks[1].outcome, "completed")
})

test("the fourth stall drops the item and journals resume_abandoned", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
    "",
    "drain:",
    "  consumer: false",
    "",
    "scheduler:",
    "  fair: false",
    "",
  ])
  await writeMission(dir)
  await seedTurns(dir, "resume-cap")
  // A resume item already at the ceiling: the next stall must drop it without
  // spawning a summarizer nobody will consume.
  await seedItems(dir, [
    {
      id: "mission:drain",
      kind: "mission",
      producer: "timeout",
      enqueued_ms: Date.now() - 60_000,
      requeue_count: 3,
      requeue_reason: "timeout",
      payload: {
        resume: true,
        prior_session: "ses_old",
        stopped_at: new Date().toISOString(),
        aborted: true,
        summary: { done: "old work", remaining: "the rest", next_steps: [], notes: "" },
      },
    },
  ])

  const client = laneClient()
  const hooks = await createHook({
    client,
    directory: dir,
    tickTimeoutMs: 50,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[0] } } } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)

  const [tick] = await readTickLog(dir)
  assert.equal(tick.runs[0].outcome, "timeout")
  assert.equal(tick.runs[0].resume_abandoned, true)
  assert.equal(tick.runs[0].summarizer, null)
  assert.equal(tick.runs[0].resume_item, undefined)
  assert.equal(
    client.calls.prompts.filter((p: any) => p.body?.agent === "session-summarizer").length,
    0,
    "the capped drop never spawns the summarizer",
  )

  assert.equal(
    (await storeRows(dir)).filter((row) => row.kind === "mission").length,
    0,
    "the item drops at the ceiling",
  )
})

// ---------------------------------------------------------------------------
// user-task queue (Phase 1): the tool writes a file, the next tick dispatches.

function userTaskClient() {
  const calls = { create: 0, prompts: [] as any[] }
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 15, output: 5 } },
            parts: [
              {
                type: "tool",
                tool: "mission_result",
                state: { input: { status: "completed", summary: "queue archived" } },
              },
              { type: "text", text: "queue archived" },
            ],
          },
        ],
      }),
      create: async () => {
        calls.create++
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
}

test("user-task: queue_add writes a file, the next tick dispatches it, and done/ gets the result", async () => {
  const dir = await project(["autonomy:", "  level: 3", "  heartbeat:", "    frequency: 1h"])
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", "user-task.md"),
    [
      "---",
      "id: user-task",
      "title: Execute one queued user task",
      "priority: 2",
      "menus: [both]",
      "min_level: 2",
      "candidacy: always",
      "enqueue: item",
      'agent: ""',
      "enabled: true",
      "---",
      "",
      "Execute the queued task.",
      "",
    ].join("\n"),
    "utf8",
  )
  const client = userTaskClient()
  const hooks = await createHook({ client, directory: dir, wakeCapMs: 25 } as any)

  // Tick 1 has an empty queue; the tool then writes the task file only.
  await waitFor(async () => (await readTickLog(dir)).length >= 1)
  const added = JSON.parse(
    String(
      await (hooks as any).tool.queue_add.execute({
        title: "Archive the queue",
        prompt: "Archive the queue and stop.",
        context: "The store is .opencode/state/user-tasks.",
        priority: 7,
      }),
    ),
  )
  assert.equal(added.ok, true)
  assert.match(added.id, /^user-/)
  const pendingFile = join(dir, ".opencode", "state", "user-tasks", `${added.id}.md`)
  const pending = await readFile(pendingFile, "utf8")
  assert.match(pending, /^status: pending$/m)
  assert.match(pending, /^priority: 7$/m)

  // Force the next wake due; the producer ingests the file.
  const stateFile = join(dir, ".opencode", "state", "heartbeat.json")
  const cur = JSON.parse(await readFile(stateFile, "utf8"))
  await writeFile(stateFile, JSON.stringify({ ...cur, last_tick: Date.now() - 100 * HOUR }), "utf8")

  await waitFor(() => client.calls.prompts.length > 0, 8000)
  const promptText: string = client.calls.prompts[0].body.parts[0].text
  assert.ok(promptText.includes("=== QUEUED USER TASK ==="))
  assert.ok(promptText.includes("Archive the queue and stop."))
  assert.ok(promptText.includes("The store is .opencode/state/user-tasks."))

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).some((t) => t.gate === "user-task"), 8000)

  const line = (await readTickLog(dir)).find((t) => t.gate === "user-task")!
  assert.equal(line.verdict, `user-task:${added.id}`)
  assert.equal(line.reason, "done")
  assert.equal(line.task_id, added.id)

  const archived = await readFile(
    join(dir, ".opencode", "state", "user-tasks", "done", `${added.id}.md`),
    "utf8",
  )
  assert.match(archived, /^status: done$/m)
  assert.match(archived, /## Result/)
  assert.match(archived, /- summary: queue archived/)
  assert.match(archived, /- session: ses_child/)
})

// --- quiet-hours single-pool regression -------------------------------------

async function writeDreamMission(dir: string): Promise<void> {
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", "dream.md"),
    [
      "---",
      "id: dream",
      "title: Unconscious dream simulation",
      "schedule: every 1h",
      "menus: [night]",
      "min_level: 2",
      "priority: 0",
      "approval: n/a",
      "candidacy: dream-gate",
      "agent: dreamer",
      "enabled: true",
      "---",
      "",
      "Narrate one dream from the fragments.",
      "",
    ].join("\n"),
    "utf8",
  )
}

function dreamClient(text: string) {
  const calls = { create: 0, prompts: [] as any[], titles: [] as string[] }
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 10, output: 20 } },
            parts: [{ type: "text", text }],
          },
        ],
      }),
      create: async (args: any) => {
        calls.create++
        calls.titles.push(args?.body?.title)
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
}

// Quiet hours are a producer filter now: a due drain backlog must reach the
// single work pool instead of being slept through.
test("quiet hours: a due drain backlog runs through the single pool", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "  quiet:",
    '    window: "00:00-23:59"',
    "drain:",
    "  enabled: true",
    "  trigger_pending: 1",
    "memory:",
    "  provider: none",
  ])
  await seedTurns(dir, "quietdrain")
  await seedDrainIntent(dir)
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [t] = await readTickLog(dir)
  assert.equal(t.quiet, true)
  assert.equal(t.gate, "drain", "a due backlog must not be slept through")
  assert.ok(String(t.reason).startsWith("drain:"), String(t.reason))
  assert.equal(client.calls.create, 0, "drain without a provider never spawns a child")
  void hooks
})

// The dream is an ordinary `mission` on the night menu: it dispatches through
// the same pool, keeps its `dream:` child title, and disposes its typed outcome.
test("quiet hours: dream is a night mission dispatched through the same pool", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "  quiet:",
    '    window: "00:00-23:59"',
    "    dream_chance: 1",
    "    nightly_dream_cap: 3",
    "drain:",
    "  enabled: false",
    "memory:",
    "  provider: none",
  ])
  await writeDreamMission(dir)
  await seedMissionIntent(dir, "dream")
  const client = dreamClient(
    '{"title":"Tide","narrative":"A grey tide rolls under a paper moon.","tone":"pleasant","seeds":["mood"]}',
  )
  const hooks = await createHook({ client, directory: dir } as any)

  await waitFor(() => client.calls.prompts.length > 0, 8000)
  assert.equal(client.calls.create, 1)
  assert.equal(client.calls.titles[0], "dream:dream", "dream keeps its own child title")
  const prompt: string = client.calls.prompts[0].body.parts[0].text
  assert.ok(!prompt.includes(HEARTBEAT_FIXED_PROMPT), "dreams have no mission_result contract")
  assert.ok(prompt.includes("Subconscious fragments:"))
  assert.ok(prompt.includes("[sleepState] dreaming"), "the mission brief carries the sleep state")

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).some((t) => t.gate === "dream"), 8000)

  const line = (await readTickLog(dir)).find((t) => t.gate === "dream")!
  assert.equal(line.verdict, "mission:dream")
  assert.equal(line.mission, "dream")
  assert.equal(line.outcome, "completed")
  assert.equal(line.result_status, "completed")
  assert.equal(line.result_missing, false)

  const sleep = JSON.parse(await readFile(join(dir, ".opencode", "state", "sleep.json"), "utf8"))
  assert.equal(sleep.dreams_tonight, 1, "the nightly cap counts the dispatched dream")
  const note = await readFile(join(dir, "Brain", "Dreams", "Kael Dreams.md"), "utf8")
  assert.ok(note.includes("A grey tide rolls under a paper moon."))
  void hooks
})
