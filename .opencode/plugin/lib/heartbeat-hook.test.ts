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
      await readFile(join(dir, ".opencode", "state", "heartbeat.lock"), "utf8")
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
test("lock-held skip: a fresh heartbeat.lock skips the tick and is not stolen", async () => {
  const dir = await project(["autonomy:", "  level: 2"])
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const lockFile = join(stateDir, "heartbeat.lock")
  const foreign = {
    pid: 4242,
    acquired_ms: Date.now() - 1_000,
    acquired_at: new Date().toISOString(),
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
  assert.equal(held.pid, 4242)
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

  // 6. Single-flight released: exactly one session, lock gone.
  assert.equal(client.calls.create, 1)
  await waitFor(async () => {
    try {
      await readFile(join(dir, ".opencode", "state", "heartbeat.lock"), "utf8")
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
// frequency feeds `long_silence` through the shared feed; with decisions
// disabled the verdict is no_reply and `reason` says why (no silent guessing).
test("long_silence: a 36h gap feeds the mood event; decisions-disabled no_reply is labelled", async () => {
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
  assert.equal(t.reason, "decisions-disabled")
  assert.equal(t.gate, "digest")

  // The shared feed persisted the arousal dip (0.3 → 0.2).
  const mood = await readMood(dir)
  assert.ok((mood.arousal ?? 1) < 0.3)
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
  assert.equal(client.calls.create, 1, "exactly one mission child across the whole test")
})
