import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { mockClient, tempDir, tempHome } from "./test-utils.ts"
import { HEARTBEAT_FIXED_PROMPT } from "./heartbeat.ts"

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
      "frequency: high",
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
      "frequency: high",
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
  assert.equal(t.gate, "pre-gate")
  assert.equal(t.reason, "all-quiet")

  // Zero LLM calls: no child session was ever created or prompted.
  assert.equal(client.calls.create, 0)
  assert.equal(client.calls.prompts.length, 0)

  const state = await readTickState(dir)
  assert.equal(state.ticks, 1)
  assert.ok((state.last_tick ?? 0) > 0)

  // The lock was released after the tick.
  await waitFor(async () => {
    try {
      await readFile(join(dir, ".opencode", "state", "ownership.lock"), "utf8")
      return false
    } catch {
      return true
    }
  })
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
test("lock-held skip: a fresh live ownership lease skips the tick and is not stolen", async () => {
  const dir = await project(["autonomy:", "  level: 2"])
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const lockFile = join(stateDir, "ownership.lock")
  const foreign = {
    pid: process.ppid,
    acquired_ms: Date.now() - 1_000,
    heartbeat_ms: Date.now(),
  }
  await writeFile(lockFile, JSON.stringify(foreign), "utf8")

  const client = mockClient()
  await createHook({ client, directory: dir } as any)

  await delay(250)
  assert.deepEqual(await readTickLog(dir), [])
  assert.equal(client.calls.create, 0)
  const state = await readTickState(dir)
  assert.ok((state.ticks ?? 0) === 0)
  // The foreign lock stands untouched.
  const held = JSON.parse(await readFile(lockFile, "utf8"))
  assert.equal(held.pid, process.ppid)
})

// §5.1 execution lock: a foreign mission.lock means another agent is working.
// The tick skips dispatch, journals gate:lock, creates no session, and leaves
// lanes.json byte-identical (no enqueue/prune write reaches disk).
test("mission-lock-held skip: dispatch is skipped and the lane queues are untouched", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeMission(dir)
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const queueText = JSON.stringify({ primary: [], side: [] })
  await writeFile(join(stateDir, "lanes.json"), queueText, "utf8")
  await writeFile(
    join(stateDir, "heartbeat.json"),
    JSON.stringify({ last_tick: Date.now() - 13 * HOUR, ticks: 0 }),
    "utf8",
  )
  const foreign = {
    pid: process.ppid,
    acquired_ms: Date.now(),
    heartbeat_ms: Date.now(),
  }
  await writeFile(join(stateDir, "mission.lock"), JSON.stringify(foreign), "utf8")

  const client = mockClient()
  await createHook({ client, directory: dir } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [t] = await readTickLog(dir)
  assert.equal(t.gate, "lock")
  assert.equal(t.reason, "mission-lock-held")
  assert.equal(t.outcome, "silent")
  assert.equal(client.calls.create, 0, "no child is dispatched while the lock is held")
  assert.equal(
    await readFile(join(stateDir, "lanes.json"), "utf8"),
    queueText,
    "the queues are byte-identical",
  )
  const held = JSON.parse(await readFile(join(stateDir, "mission.lock"), "utf8"))
  assert.equal(held.pid, process.ppid, "the foreign lock is not stolen")
})

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
  const client = missionClient()
  const hooks = await createHook({ client, directory: dir, spawner: missionSpawner } as any)

  // 1. The tick creates exactly one child and prompts the fixed brief.
  await waitFor(() => client.calls.prompts.length > 0)
  assert.equal(client.calls.create, 1)
  const body = client.calls.prompts[0].body
  const text: string = body.parts[0].text
  assert.ok(text.includes(HEARTBEAT_FIXED_PROMPT))
  assert.ok(text.includes("Verdict: mission:drain — Drain conversation backlog into the vault"))
  assert.ok(text.includes("Do the drain thing."))
  assert.ok(text.includes("~50 tokens"), "the child is told the configured budget")

  // §5.1: mission.lock is held across the child dispatch.
  const held = JSON.parse(
    await readFile(join(dir, ".opencode", "state", "mission.lock"), "utf8"),
  )
  assert.equal(held.pid, process.pid)

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
  assert.ok(t.candidates.some((c: string) => /^drain:1\.\d\d$/.test(c)), String(t.candidates))

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
  await waitFor(async () => {
    try {
      await readFile(join(dir, ".opencode", "state", "ownership.lock"), "utf8")
      return false
    } catch {
      return true
    }
  })
  await waitFor(async () => {
    try {
      await readFile(join(dir, ".opencode", "state", "mission.lock"), "utf8")
      return false
    } catch {
      return true
    }
  })
})

// `runner: drain-pipe` is a tool binding, not an execution bypass: the hook
// still spawns a child, and the child's drain_run + mission_result results are
// read from its transcript.
test("runner mission: drain-pipe binds drain_run; the child runs it", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", "drain.md"),
    [
      "---",
      "id: drain",
      "title: Drain conversation backlog into the vault",
      "frequency: high",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: digest",
      "runner: drain-pipe",
      "on_decline: reroll",
      "enabled: true",
      "---",
      "",
      "Run the drain_run tool.",
      "",
    ].join("\n"),
    "utf8",
  )

  const calls = { creates: [] as any[], prompts: [] as any[] }
  const toolResult = {
    status: "completed",
    reason: null,
    outcome: "completed",
    summary: "drain:completed, 1 session(s), 1 item(s), 1 consolidated, 0 skipped",
    tokens: 45,
    session: "ses_writer",
    cursor_before: 0,
    cursor_after: 2000,
    sessions: 1,
    items: 1,
  }
  const client = {
    ...mockClient(),
    session: {
      get: async () => ({ data: {} }),
      create: async (args: any) => {
        calls.creates.push(args)
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 100, output: 20 } },
            parts: [
              {
                type: "tool",
                tool: "drain_run",
                state: { input: {}, output: JSON.stringify(toolResult) },
              },
              {
                type: "tool",
                tool: "mission_result",
                state: { input: { status: "completed", summary: "drain complete" } },
              },
              { type: "text", text: "drain complete" },
            ],
          },
        ],
      }),
    },
  }

  const hooks = await createHook({ client, directory: dir, spawner: missionSpawner } as any)
  await waitFor(() => calls.prompts.length > 0)
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.creates[0].body.title, "heartbeat:drain")
  assert.ok(String(calls.prompts[0].body.parts[0].text).includes("Run the drain_run tool."))

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [tick] = await readTickLog(dir)
  assert.equal(tick.mission, "drain")
  assert.equal(tick.outcome, "completed")
  assert.equal(tick.token_cost, 165, "child 120 + drain tool 45")
  assert.equal(tick.session, "ses_child", "the mission child is the transcript")
  assert.equal(tick.tool_session, "ses_writer")
  assert.equal(tick.tool_status, "completed")
  assert.equal(tick.result_status, "completed")
  assert.equal(tick.result_missing, false)

  const entries = await readBacklog(dir)
  assert.equal(entries[0].status, "done")
  assert.equal(entries[0].result.token_cost, 165)
})

// A pipe failure is reported by `drain_run` as `status: "completed"` with
// `outcome: "error"`. Even when the child reports mission_result(completed),
// the hook must record a failed mission and a failed backlog entry.
test("drain pipe failure overrides a completed mission result", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", "drain.md"),
    [
      "---",
      "id: drain",
      "title: Drain conversation backlog into the vault",
      "frequency: high",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: digest",
      "runner: drain-pipe",
      "on_decline: reroll",
      "enabled: true",
      "---",
      "",
      "Run the drain_run tool.",
      "",
    ].join("\n"),
    "utf8",
  )

  const calls = { creates: [] as any[], prompts: [] as any[] }
  const toolResult = {
    status: "completed",
    reason: null,
    outcome: "error",
    summary: "drain:error, 3 session(s), 11 item(s), 0 consolidated, 0 skipped, error:invalid report: no report fence",
    tokens: 45,
    session: "ses_writer",
    cursor_before: 1000,
    cursor_after: 1000,
    sessions: 3,
    items: 11,
    error: "invalid report: no report fence",
  }
  const client = {
    ...mockClient(),
    session: {
      get: async () => ({ data: {} }),
      create: async (args: any) => {
        calls.creates.push(args)
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 100, output: 20 } },
            parts: [
              {
                type: "tool",
                tool: "drain_run",
                state: { input: {}, output: JSON.stringify(toolResult) },
              },
              {
                type: "tool",
                tool: "mission_result",
                state: { input: { status: "completed", summary: "drain complete" } },
              },
              { type: "text", text: "drain complete" },
            ],
          },
        ],
      }),
    },
  }

  const hooks = await createHook({ client, directory: dir, spawner: missionSpawner } as any)
  await waitFor(() => calls.prompts.length > 0)
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [tick] = await readTickLog(dir)
  assert.equal(tick.mission, "drain")
  assert.equal(tick.outcome, "completed")
  assert.equal(tick.result_status, "completed")
  assert.equal(tick.tool_status, "completed")
  assert.equal(tick.tool_outcome, "error")
  assert.equal(tick.tool_error, "invalid report: no report fence")
  assert.equal(tick.tool_failed_but_completed, true)
  assert.equal(tick.mood_event, "mission_failure")

  const entries = await readBacklog(dir)
  assert.equal(entries[0].status, "failed")
  assert.equal(entries[0].result.ok, false)
  assert.ok(String(entries[0].result.summary).includes("drain:error"))
})

function sequenceSpawner(values: string[]): { spawner: any; calls: () => number } {
  let i = 0
  return {
    calls: () => i,
    spawner: async () => {
      const value = values[Math.min(i, values.length - 1)]
      i++
      return {
        code: 0,
        stdout: JSON.stringify({
          kind: "choice",
          value,
          confidence: 0.9,
          abstained: false,
          provider: "openjev",
          backend: "test",
          latencyMs: 1,
        }),
        stderr: "",
      }
    },
  }
}

test("declined mission with on_decline: reroll excludes it and runs the next verdict once", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", "drain.md"),
    [
      "---",
      "id: drain",
      "title: Drain",
      "frequency: high",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: digest",
      "runner: drain-pipe",
      "on_decline: reroll",
      "enabled: true",
      "---",
      "",
      "Run the drain_run tool.",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(dir, ".opencode", "missions", "staleness.md"),
    [
      "---",
      "id: staleness",
      "title: Staleness",
      "frequency: mid",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: digest",
      "enabled: true",
      "---",
      "",
      "Refresh the stale notes.",
      "",
    ].join("\n"),
    "utf8",
  )

  const calls = { creates: [] as any[], prompts: [] as any[] }
  const client = {
    ...mockClient(),
    session: {
      get: async () => ({ data: {} }),
      create: async (args: any) => {
        calls.creates.push(args)
        const id = args.body?.title === "heartbeat:drain" ? "ses_drain" : "ses_stale"
        return { data: { id } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
      messages: async ({ path }: any) => {
        if (path.id === "ses_drain") {
          return {
            data: [
              {
                info: { role: "assistant", id: "a1", tokens: { input: 10, output: 5 } },
                parts: [
                  {
                    type: "tool",
                    tool: "mission_result",
                    state: { input: { status: "declined", summary: "nothing to do", reason: "no work" } },
                  },
                  { type: "text", text: "nothing to do" },
                ],
              },
            ],
          }
        }
        return {
          data: [
            {
              info: { role: "assistant", id: "a2", tokens: { input: 20, output: 10 } },
              parts: [
                {
                  type: "tool",
                  tool: "mission_result",
                  state: { input: { status: "completed", summary: "refreshed" } },
                },
                { type: "text", text: "refreshed" },
              ],
            },
          ],
        }
      },
    },
  }

  const seq = sequenceSpawner(["mission:drain", "mission:staleness"])
  const hooks = await createHook({ client, directory: dir, spawner: seq.spawner } as any)

  await waitFor(() => calls.prompts.length === 1)
  assert.equal(calls.creates[0].body.title, "heartbeat:drain")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_drain" } } } as any)

  await waitFor(() => calls.prompts.length === 2)
  assert.equal(calls.creates[1].body.title, "heartbeat:staleness")
  assert.equal(seq.calls(), 2, "the reroll re-runs the JEV once")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_stale" } } } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "mission:staleness")
  assert.equal(tick.mission, "staleness")
  assert.equal(tick.outcome, "completed")
  assert.equal(tick.result_status, "completed")
  assert.equal(tick.token_cost, 45, "declined child 15 + next mission 30")
  assert.deepEqual(tick.declined, ["drain"])
  assert.deepEqual(tick.reroll, { from: "drain", reason: "no work" })
  assert.equal(tick.session, "ses_stale")

  const entries = await readBacklog(dir)
  assert.equal(entries.length, 1, "the declined mission is not backlog-recorded")
  assert.equal(entries[0].payload.title, "Staleness")
})

test("declined mission with on_decline: stop ends the tick silently", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "missions", "drain.md"),
    [
      "---",
      "id: drain",
      "title: Drain",
      "frequency: high",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: digest",
      "on_decline: stop",
      "enabled: true",
      "---",
      "",
      "Run the drain_run tool.",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(dir, ".opencode", "missions", "staleness.md"),
    [
      "---",
      "id: staleness",
      "title: Staleness",
      "frequency: mid",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: digest",
      "enabled: true",
      "---",
      "",
      "Refresh.",
      "",
    ].join("\n"),
    "utf8",
  )

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

  const hooks = await createHook({ client, directory: dir, spawner: missionSpawner } as any)
  await waitFor(() => calls.prompts.length === 1)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0)
  await delay(100)
  assert.equal(calls.creates, 1, "stop does not dispatch a second mission")

  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "no_reply")
  assert.equal(tick.mission, null)
  assert.equal(tick.outcome, "silent")
  assert.equal(tick.reason, "mission-declined")
  assert.equal(tick.result_status, "declined")
  assert.deepEqual(tick.declined, ["drain"])

  const entries = await readBacklog(dir)
  assert.deepEqual(entries, [])
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
test("decisions-disabled no_reply with queued work is labelled", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  await writeMission(dir)
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, "heartbeat.json"),
    JSON.stringify({ last_tick: Date.now() - 13 * HOUR, ticks: 0 }),
    "utf8",
  )

  const client = mockClient()
  await createHook({ client, directory: dir } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [t] = await readTickLog(dir)
  assert.equal(t.verdict, "no_reply")
  assert.equal(t.outcome, "silent")
  assert.equal(t.reason, "decisions-disabled")
  assert.equal(t.gate, "digest")
  // The queued primary item survives the JEV's silence (expiry owns its end).
  const lanes = JSON.parse(await readFile(join(stateDir, "lanes.json"), "utf8"))
  assert.equal(lanes.primary.length, 1)
  assert.equal(lanes.primary[0].id, "mission:drain")
  assert.equal(client.calls.create, 0)
})

// B7 day-side adaptive backoff (missions-plan §7, §11 — lands in card 6
// alongside quiet.backoff): repeated NO_REPLY ticks on an IDENTICAL digest
// stretch the day cadence ×2 at streak 2 (the day twin of the §17.8 dream
// ladder); a mission execution resets the streak. The `wakeCapMs` seam
// shrinks the 60 s wake ceiling so the loop re-checks due-ness on a test
// timescale — the due MATH is what is under test.
test("B7 backoff: identical-digest no_reply streaks stretch the cadence; a mission resets", async () => {
  const dir = await project(["autonomy:", "  level: 3"])
  let answer = "no_reply" // switched to mission:drain for the reset leg
  const spawner = async () => ({
    code: 0,
    stdout: JSON.stringify({ kind: "choice", value: answer, confidence: 0.9, abstained: false, provider: "openjev", backend: "test", latencyMs: 1 }),
    stderr: "",
  })
  const client = missionClient()
  const hooks = await createHook({ client, directory: dir, wakeCapMs: 25, spawner } as any)

  const forceDue = async (gapMs: number): Promise<void> => {
    const file = join(dir, ".opencode", "state", "heartbeat.json")
    const cur = JSON.parse(await readFile(file, "utf8").catch(() => "{}"))
    await writeFile(file, JSON.stringify({ ...cur, last_tick: Date.now() - gapMs }), "utf8")
  }

  // Tick 1 (decisions disabled → no_reply, fresh hash) fires at boot.
  await waitFor(async () => (await readTickLog(dir)).length >= 1)
  const [t1] = await readTickLog(dir)
  await waitFor(async () => ((await readTickState(dir)) as any).noop_streak === 1)
  let state: any = await readTickState(dir)
  assert.equal(state.noop_streak, 1, "first no_reply starts the streak")
  assert.equal(state.noop_hash, t1.digest_hash)

  // Tick 2 forced due at the BASE frequency (streak 1 → ×1): same digest →
  // the streak extends to the step boundary.
  await forceDue(12 * HOUR)
  await waitFor(async () => (await readTickLog(dir)).length >= 2)
  await waitFor(async () => ((await readTickState(dir)) as any).noop_streak === 2)
  state = await readTickState(dir)
  assert.equal(state.noop_streak, 2, "identical digest extends the streak")
  assert.equal(state.noop_hash, t1.digest_hash)

  // Tick 3 at the BASE frequency is now refused: the cadence stretched ×2
  // (12h → 24h), so a 12h stamp is no longer due.
  await forceDue(12 * HOUR)
  await delay(400)
  assert.equal((await readTickLog(dir)).length, 2, "stretched cadence rejects the base-frequency due stamp")

  // An executed mission resets the streak: decisions flip on (hot-read), the
  // seam answers mission:drain, and a stamp past the STRETCHED window fires.
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["autonomy:", "  level: 3", "", "decisions:", "  enabled: true", "  provider: openjev", ""].join("\n"),
    "utf8",
  )
  await writeMission(dir)
  answer = "mission:drain"
  await forceDue(48 * HOUR) // stretched ×2 window is 24h → 48h is overdue
  await waitFor(() => client.calls.prompts.length >= 1)
  // The tick completes when its child idles (15 min abandon otherwise).
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).length >= 3)
  const lines = await readTickLog(dir)
  assert.equal(lines[2].verdict, "mission:drain")
  await waitFor(async () => ((await readTickState(dir)) as any).noop_streak === 0)
  state = await readTickState(dir)
  assert.equal(state.noop_streak, 0, "an executed mission resets the B7 streak")
  assert.equal(state.noop_hash, null)
  assert.equal((state as any).last_mission, "drain", "the dispatched mission is recorded")
  assert.equal(client.calls.create, 1, "exactly one mission child across the whole test")
})

// A provider abstain is a fallback, not a verdict: pending work must still
// dispatch. The ledger names the fallback so the decision is attributable.
test("digest fallback: abstain with pending turns dispatches the mission (abstain:pending-work)", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await writeMissionWithCandidacy(dir, "drain", "Drain", "turns-pending")
  await seedTurns(dir, "abstain-pending")

  const client = missionClient()
  const hooks = await createHook({ client, directory: dir, spawner: abstainingSpawner } as any)

  await waitFor(() => client.calls.prompts.length > 0)
  assert.equal(client.calls.create, 1, "pending work dispatches despite the abstain")

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_child" } },
  } as any)
  await waitFor(async () => (await readTickLog(dir)).length > 0)

  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "mission:drain")
  assert.equal(tick.mission, "drain")
  assert.equal(tick.gate, "digest")
  assert.equal(tick.reason, "abstain:pending-work")
})

// No pending-work candidate: the fallback stays out of the way and the tick
// ends silent exactly as before.
test("digest fallback: abstain with only judgment candidates stays no_reply", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await writeMission(dir) // candidacy defaults to digest (judgment)
  await writePendingBacklog(dir) // keeps all-quiet from short-circuiting

  const client = missionClient()
  await createHook({ client, directory: dir, spawner: abstainingSpawner } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "no_reply")
  assert.equal(tick.mission, null)
  assert.equal(tick.reason, "abstain")
  assert.equal(client.calls.create, 0, "no mission was invented")
})

// A confident model no_reply is not a fallback: it must never be overridden
// by pending-work candidacy.
test("digest fallback: confident no_reply still ends no_reply despite pending turns", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
  ])
  await writeMissionWithCandidacy(dir, "drain", "Drain", "turns-pending")
  await seedTurns(dir, "confident-no-reply")

  const confident = async () => ({
    code: 0,
    stdout: JSON.stringify({
      kind: "choice",
      value: "no_reply",
      confidence: 0.9,
      abstained: false,
      provider: "openjev",
      backend: "test",
      latencyMs: 1,
    }),
    stderr: "",
  })

  const client = missionClient()
  await createHook({ client, directory: dir, spawner: confident } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.verdict, "no_reply")
  assert.equal(tick.mission, null)
  assert.equal(tick.reason, "jev-no-reply")
  assert.equal(client.calls.create, 0, "confident silence is respected")
})

// ---------------------------------------------------------------------------
// Lane queues (docs/heartbeat-lanes.md): the side lane runs status-fed
// maintenance next to the JEV-picked primary, in the SAME tick.

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

function writeLaneMission(
  dir: string,
  id: string,
  opts: { lane: string; candidacy: string; menus?: string },
): Promise<void> {
  return mkdir(join(dir, ".opencode", "missions"), { recursive: true }).then(() =>
    writeFile(
      join(dir, ".opencode", "missions", `${id}.md`),
      [
        "---",
        `id: ${id}`,
        `title: ${id}`,
        "frequency: high",
        `menus: ${opts.menus ?? "[day, night]"}`,
        "min_level: 2",
        'agent: ""',
        `candidacy: ${opts.candidacy}`,
        `lane: ${opts.lane}`,
        "enabled: true",
        "---",
        "",
        `Do the ${id} thing.`,
        "",
      ].join("\n"),
      "utf8",
    ),
  )
}

test("side lane and primary both run in one tick", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
    "",
    "# These tests exercise the legacy side-lane drain (the consumer: false",
    "# rollback path of docs/drain-consumer-plan.md §9).",
    "drain:",
    "  consumer: false",
    "",
  ])
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await writeLaneMission(dir, "research", { lane: "primary", candidacy: "digest" })
  await seedTurns(dir, "lanes-together")

  const client = laneClient()
  const { spawner, calls: jevCalls } = sequenceSpawner(["mission:research"])
  const hooks = await createHook({ client, directory: dir, spawner } as any)

  // Side child runs first, to completion…
  await waitFor(() => client.calls.prompts.length === 1)
  assert.match(String(client.calls.prompts[0].body.parts[0].text), /Verdict: mission:drain/)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[0] } } } as any)
  // …then the JEV picks the primary and its child runs.
  await waitFor(() => client.calls.prompts.length === 2)
  assert.match(String(client.calls.prompts[1].body.parts[0].text), /Verdict: mission:research/)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[1] } } } as any)

  await waitFor(async () => (await readTickLog(dir)).length > 0)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.side_mission, "drain")
  assert.equal(tick.side_outcome, "completed")
  assert.equal(tick.mission, "research")
  assert.equal(tick.outcome, "completed")
  assert.equal(tick.token_cost, 240, "both children accounted: 120 + 120")
  assert.equal(tick.over_budget, false)
  assert.equal(tick.runs.length, 2)
  assert.deepEqual(tick.runs.map((r: any) => `${r.lane}:${r.mission}`).sort(), [
    "primary:research",
    "side:drain",
  ])
  assert.equal(tick.side_requeued, false)
  assert.equal(jevCalls(), 1, "one JEV call for the primary pick")

  // Both items left the queues (completed → drop).
  const lanes = JSON.parse(await readFile(join(dir, ".opencode", "state", "lanes.json"), "utf8"))
  assert.deepEqual(lanes, { primary: [], side: [] })
})

test("the side lane dequeues one item per tick; the rest wait", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
    "",
    "# These tests exercise the legacy side-lane drain (the consumer: false",
    "# rollback path of docs/drain-consumer-plan.md §9).",
    "drain:",
    "  consumer: false",
    "",
  ])
  // Two status-fed side missions, no primary work at all.
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await writeLaneMission(dir, "drain2", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "lanes-fifo")

  const client = laneClient()
  let jevCalls = 0
  const spawner = async () => {
    jevCalls++
    return {
      code: 0,
      stdout: JSON.stringify({ kind: "choice", value: "no_reply", confidence: 0.9, abstained: false, provider: "openjev", backend: "test", latencyMs: 1 }),
      stderr: "",
    }
  }
  const hooks = await createHook({ client, directory: dir, wakeCapMs: 25, spawner } as any)

  // Tick 1: exactly one side child, and no JEV call (zero primary candidates).
  await waitFor(() => client.calls.prompts.length === 1)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[0] } } } as any)
  await waitFor(async () => (await readTickLog(dir)).length >= 1)
  const [t1] = await readTickLog(dir)
  assert.ok(["drain", "drain2"].includes(t1.side_mission), `one side mission, got ${t1.side_mission}`)
  assert.equal(t1.mission, null)
  assert.equal(t1.reason, "no-candidates")
  assert.equal(jevCalls, 0, "an empty primary lane never calls the JEV")

  // Tick 2: the other side mission runs; FIFO order is by enqueue time.
  // (Force the clock: the next tick is due one frequency after tick 1.)
  {
    const file = join(dir, ".opencode", "state", "heartbeat.json")
    const cur = JSON.parse(await readFile(file, "utf8").catch(() => "{}"))
    await writeFile(file, JSON.stringify({ ...cur, last_tick: Date.now() - 13 * HOUR }), "utf8")
  }
  await waitFor(() => client.calls.prompts.length === 2)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[1] } } } as any)
  await waitFor(async () => (await readTickLog(dir)).length >= 2)
  const [_, t2] = await readTickLog(dir)
  assert.ok(["drain", "drain2"].includes(t2.side_mission))
  assert.notEqual(t2.side_mission, t1.side_mission, "the second item waited its turn")
  assert.deepEqual([t1.side_mission, t2.side_mission].sort(), ["drain", "drain2"])
  assert.equal(client.calls.create, 2, "one side child per tick")
})

test("a timed-out side run is re-enqueued at the tail with the reason", async () => {
  const dir = await project([
    "autonomy:",
    "  level: 3",
    "",
    "decisions:",
    "  enabled: true",
    "  provider: openjev",
    "",
    "# These tests exercise the legacy side-lane drain (the consumer: false",
    "# rollback path of docs/drain-consumer-plan.md §9).",
    "drain:",
    "  consumer: false",
    "",
  ])
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "lanes-timeout")

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  // 50 ms child budget, and the test never sends session.idle before the
  // timeout → the run aborts the child, then confirms with its own budget.
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
    tickTimeoutMs: 50,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.aborts.length === 1, 8000)
  assert.equal(client.calls.aborts[0].path.id, client.calls.ids[0], "aborts the child session")
  assert.equal(client.calls.aborts[0].query.directory, dir)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[0] } } } as any)
  await settleSummarizer(client, hooks)

  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.side_mission, "drain")
  assert.equal(tick.side_outcome, "timeout")
  assert.equal(tick.side_aborted, true, "the abort was confirmed")
  assert.equal(tick.side_requeued, true)
  assert.equal(tick.runs.length, 1)
  assert.equal(tick.runs[0].requeued, true)
  assert.equal(tick.runs[0].lane, "side")
  assert.equal(tick.runs[0].aborted, true)
  assert.equal(tick.runs[0].abort_error, undefined)

  const lanes = JSON.parse(await readFile(join(dir, ".opencode", "state", "lanes.json"), "utf8"))
  assert.equal(lanes.side.length, 1, "the item is back in the queue")
  assert.equal(lanes.side[0].id, "mission:drain")
  assert.equal(lanes.side[0].requeue_count, 1)
  assert.equal(lanes.side[0].requeue_reason, "timeout")
  assert.ok(lanes.side[0].payload.original_enqueued_ms < lanes.side[0].enqueued_ms, "tail = fresh timestamp")
  assert.equal(lanes.side[0].payload.resume, true)
  assert.equal(lanes.side[0].payload.prior_session, client.calls.ids[0])
  assert.equal(lanes.side[0].payload.summary.done, "drained 1 turn")
  assert.equal(tick.runs[0].timeout_stopped, true)
  assert.equal(tick.runs[0].prior_session, client.calls.ids[0])
  assert.equal(tick.runs[0].resume_item, "mission:drain")
  assert.equal(tick.runs[0].summarizer, "llm")
  assert.equal(tick.runs[0].resume_abandoned, undefined)
})

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
  ])
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "lanes-abort-fail")

  const client = laneClient({ abortFails: true })
  const { spawner } = sequenceSpawner(["no_reply"])
  await createHook({
    client,
    directory: dir,
    spawner,
    tickTimeoutMs: 50,
    abortConfirmMs: 50,
  } as any)

  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await waitFor(async () => (await readTickLog(dir)).length > 0, 8000)
  const [tick] = await readTickLog(dir)
  assert.equal(tick.side_outcome, "error", "a failed abort is not booked as a timeout")
  assert.equal(tick.side_aborted, false)
  assert.equal(tick.side_abort_error, "abort refused")
  assert.equal(tick.side_requeued, false)
  assert.equal(tick.runs[0].aborted, false)
  assert.equal(tick.runs[0].abort_error, "abort refused")

  const lanes = JSON.parse(await readFile(join(dir, ".opencode", "state", "lanes.json"), "utf8"))
  assert.equal(lanes.side.length, 0, "a failed abort drops the item instead of requeueing it")
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
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "stall-active")

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
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
  assert.equal(tick.side_outcome, "completed")
  assert.equal(tick.side_requeued, false)
})

test("silence during an open shell tool is exempt until the tool closes", async () => {
  const dir = await stallProject()
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "stall-shell")

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
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
  assert.equal(tick.side_outcome, "timeout")
  assert.equal(tick.runs[0].stop_reason, "stall")
  assert.equal(tick.runs[0].last_activity, "tool:bash")
  assert.ok(tick.runs[0].stalled_for_ms >= 100, "the ledger records the silence")
})

test("descendant activity keeps the mission child alive (no task exemption)", async () => {
  const dir = await stallProject()
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "stall-descendant")

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
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
  assert.equal(tick.side_outcome, "completed")
})

test("a background task child is aborted when its mission child aborts", async () => {
  const dir = await stallProject()
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "orphan-abort")

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
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
  assert.equal(tick.side_outcome, "timeout")
  assert.equal(tick.runs[0].orphan_abort, 1)
  assert.equal(tick.runs[0].orphan_abort_error, undefined)
  assert.equal(tick.side_orphan_abort, 1)
})

test("a foreground task child already settled is not double-aborted", async () => {
  const dir = await stallProject()
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "orphan-foreground")

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
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
  assert.equal(tick.side_outcome, "timeout")
  assert.equal(tick.runs[0].orphan_abort, undefined)
  assert.equal(tick.side_orphan_abort, undefined)
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
  ])
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "resume-block")

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
    tickTimeoutMs: 50,
    abortConfirmMs: 50,
    wakeCapMs: 25,
  } as any)

  // Tick 1: the child stalls, the summarizer runs, the item resumes.
  await waitFor(() => client.calls.aborts.length === 1, 8000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: client.calls.ids[0] } } } as any)
  await settleSummarizer(client, hooks)
  await waitFor(async () => (await readTickLog(dir)).length >= 1, 8000)

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
  assert.equal(ticks[1].side_outcome, "completed")
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
  ])
  await writeLaneMission(dir, "drain", { lane: "side", candidacy: "turns-pending" })
  await seedTurns(dir, "resume-cap")
  await mkdir(join(dir, ".opencode", "state"), { recursive: true })
  // A resume item already at the ceiling: the next stall must drop it without
  // spawning a summarizer nobody will consume.
  await writeFile(
    join(dir, ".opencode", "state", "lanes.json"),
    JSON.stringify({
      primary: [],
      side: [
        {
          id: "mission:drain",
          kind: "mission",
          lane: "side",
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
      ],
    }),
    "utf8",
  )

  const client = laneClient()
  const { spawner } = sequenceSpawner(["no_reply"])
  const hooks = await createHook({
    client,
    directory: dir,
    spawner,
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

  const lanes = JSON.parse(await readFile(join(dir, ".opencode", "state", "lanes.json"), "utf8"))
  assert.equal(lanes.side.length, 0, "the item drops at the ceiling")
})
