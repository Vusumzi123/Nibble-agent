import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mockClient, tempDir, tempHome } from "./test-utils.ts"

// Isolate HOME before the hook module resolves anything home-scoped.
const TEST_HOME = tempHome("dreamhook-home-")
void TEST_HOME
const { default: createHook } = await import("../dream-hook.ts")
const { DREAM_FIXED_PROMPT, parseDreamBucket } = await import("./dream.ts")
const { HEARTBEAT_FIXED_PROMPT } = await import("./heartbeat.ts")

async function project(extraLines: string[] = []): Promise<string> {
  const dir = await tempDir("dreamhook-proj-")
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    [
      "autonomy:",
      "  level: 3",
      "  quiet:",
      '    window: "00:00-23:59"', // wall-clock-independent open window
      "    dream_cadence: 30m",
      "    resume_cooldown: 60m",
      "    dream_chance: 0.5",
      "    nightly_dream_cap: 3",
      "    backoff: true",
      ...extraLines,
      "",
    ].join("\n"),
    "utf8",
  )
  return dir
}

// Night-menu fixture missions mirroring the shipped frontmatter (temp projects
// never read the repo's real .opencode/missions/).
async function writeNightMissions(dir: string): Promise<void> {
  const mdir = join(dir, ".opencode", "missions")
  await mkdir(mdir, { recursive: true })
  await writeFile(
    join(mdir, "drain.md"),
    [
      "---",
      "id: drain",
      "title: Drain conversation backlog into the vault",
      "frequency: high",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: turns-pending",
      'agent: ""',
      "enabled: true",
      "---",
      "",
      "Do the drain thing.",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(mdir, "dream.md"),
    [
      "---",
      "id: dream",
      "title: Unconscious dream simulation",
      "frequency: low",
      "menus: [night]",
      "min_level: 1",
      "candidacy: dream-gate",
      "agent: dreamer",
      "enabled: true",
      "---",
      "",
      "Narrate one dream; end with the typed JSON outcome.",
      "",
    ].join("\n"),
    "utf8",
  )
}

async function writeSleep(dir: string, over: Record<string, unknown> = {}): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, "sleep.json"),
    JSON.stringify({
      version: 1,
      status: "dreaming",
      since: "2026-10-14T23:30:00.000Z",
      woken_at: null,
      window_opened_at: "2026-10-14T23:00:00.000Z",
      dreams_tonight: 0,
      last_tick: 0,
      ticks: 0,
      noop_streak: 0,
      ...over,
    }),
    "utf8",
  )
}

async function writePendingTurn(dir: string): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, "memory.json"),
    JSON.stringify([
      {
        seq: 1,
        session: "s",
        ts: "2026-10-14T20:00:00.000Z",
        user: "remember the kanban workflow",
        assistant: "noted",
        tags: [],
        salience: null,
        newTag: null,
        hash: "h",
      },
    ]),
    "utf8",
  )
}

async function readDreamLog(dir: string): Promise<any[]> {
  // ALL ledger lines in the shared heartbeat.log (heartbeat + dream ticks) —
  // each test filters by `event` for the scheduler it spawned.
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

async function readSleep(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, ".opencode", "state", "sleep.json"), "utf8"))
}

async function readMood(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, ".opencode", "state", "mood.json"), "utf8"))
}

function readBacklog(dir: string): Promise<any[]> {
  return readFile(join(dir, ".opencode", "state", "backlog.ndjson"), "utf8")
    .then((raw) => raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .catch(() => [])
}

// A child session whose final assistant line is the given text with token usage.
function dreamClient(text: string, tokens = { input: 100, output: 50 }) {
  const calls = { create: 0, prompts: [] as any[] }
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens },
            parts: [{ type: "text", text }],
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

function countingSpawner(answer = "mission:drain") {
  const state = { calls: 0 }
  const spawner = async () => {
    state.calls++
    return {
      code: 0,
      stdout: JSON.stringify({ kind: "choice", value: answer, confidence: 0.9, abstained: false, provider: "openjev", backend: "test", latencyMs: 1 }),
      stderr: "",
    }
  }
  return { state, spawner }
}

function idle(hooks: any, sid = "ses_child"): Promise<void> {
  return hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
}

// §17.12 acceptance #1 (zero-LLM half): a roll-failed tick with NO pending
// turns has zero candidates ⇒ NO_REPLY with NO JEV call and NO child session.
test("roll failed + no pending turns: zero LLM — no JEV call, no dream, no session", async () => {
  const dir = await project()
  await writeNightMissions(dir)
  await writeSleep(dir)
  const client = dreamClient("should never be used")
  const { state, spawner } = countingSpawner()
  const hooks = await createHook({ client, directory: dir, spawner, random: () => 1 } as any)

  const waitFor = async (fn: () => Promise<boolean>, ms = 4000): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("waitFor timeout")
  }
  await waitFor(async () => (await readDreamLog(dir)).filter((l) => l.event === "dream-tick").length > 0)

  const [t] = (await readDreamLog(dir)).filter((l) => l.event === "dream-tick")
  assert.equal(t.event, "dream-tick")
  assert.equal(t.source, "dream")
  assert.equal(t.verdict, "no_reply")
  assert.equal(t.gate, "dream-pre-gate")
  assert.equal(t.reason, "no-candidates")
  assert.equal(t.outcome, "silent")
  assert.equal(t.token_cost, 0)
  assert.deepEqual(t.candidates, [], "failed roll removed dream; no turns removed drain")
  // The roll is journaled with its outcome (§17.3).
  assert.equal(t.dream_gate.length, 1)
  assert.equal(t.dream_gate[0].id, "dream")
  assert.equal(t.dream_gate[0].passed, false)
  assert.equal(t.dream_gate[0].reason, "roll")

  // Zero LLM by construction: no JEV bridge, no child session.
  assert.equal(state.calls, 0, "the JEV spawner never ran")
  assert.equal(client.calls.create, 0)

  const sleep = await readSleep(dir)
  assert.equal(sleep.noop_streak, 1, "a no-op tick steps toward the §17.8 backoff")
  assert.equal(sleep.ticks, 1)
})

// §17.12 acceptance #1 (drain half): roll failed + pending turns ⇒ drain is
// the sole survivor and RUNS (deterministic short-circuit, no JEV call).
test("roll failed + pending turns: drain still runs as the sole candidate, no JEV", async () => {
  const dir = await project(["", "decisions:", "  enabled: true", "  provider: openjev"])
  await writeNightMissions(dir)
  await writeSleep(dir)
  await writePendingTurn(dir)
  const client = dreamClient("drained the turns")
  const { state, spawner } = countingSpawner()
  const hooks = await createHook({ client, directory: dir, spawner, random: () => 1 } as any)

  const waitFor = async (fn: () => Promise<boolean>, ms = 4000): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("waitFor timeout")
  }
  await waitFor(() => Promise.resolve(client.calls.prompts.length > 0))
  assert.equal(state.calls, 0, "sole candidate dispatched without a JEV call (§17.10 short-circuit)")
  assert.equal(client.calls.create, 1)
  const body = client.calls.prompts[0].body
  assert.ok(body.parts[0].text.startsWith(HEARTBEAT_FIXED_PROMPT), "drain uses the maintenance prompt")

  await idle(hooks)
  await waitFor(async () => (await readDreamLog(dir)).filter((l) => l.event === "dream-tick").length > 0)

  const [t] = (await readDreamLog(dir)).filter((l) => l.event === "dream-tick")
  assert.equal(t.verdict, "mission:drain")
  assert.equal(t.mission, "drain")
  assert.equal(t.outcome, "completed")
  assert.equal(t.token_cost, 150)
  assert.equal(t.reason, "sole-candidate")

  const entries = await readBacklog(dir)
  assert.equal(entries.length, 1, "a night drain records like a heartbeat run (§7)")
  assert.equal(entries[0].source, "heartbeat")
  assert.equal(entries[0].result.token_cost, 150)

  const sleep = await readSleep(dir)
  assert.equal(sleep.noop_streak, 0, "an executed mission resets the streak (§17.8)")
})

// §17.12 acceptance #3: a passed roll dispatches the dreamer tool-free child;
// the hook parses the typed outcome, appends Brain/Kael Dreams.md with
// parseable metadata, and applies the tone-table mood delta itself.
test("dream run: dreamer child pinned, bucket entry lands, mood delta is the table's", async () => {
  const dir = await project()
  await writeNightMissions(dir)
  await writeSleep(dir)
  const outcome = '{"title":"Glass elevator","narrative":"I rode an elevator made of rain.","tone":"pleasant","seeds":["recent turn"]}'
  const client = dreamClient(outcome)
  const { state } = countingSpawner()
  const hooks = await createHook({ client, directory: dir, random: () => 0 } as any) // roll passes

  const waitFor = async (fn: () => Promise<boolean>, ms = 4000): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("waitFor timeout")
  }
  await waitFor(() => Promise.resolve(client.calls.prompts.length > 0))

  // D-M7: the child runs under the tool-free dreamer agent, with the fixed
  // dream prompt + hook-gathered subconscious fragments (§17.5).
  const prompt = client.calls.prompts[0]
  assert.equal(prompt.body.agent, "dreamer")
  const text: string = prompt.body.parts[0].text
  assert.ok(text.startsWith(DREAM_FIXED_PROMPT))
  assert.ok(text.includes("Subconscious fragments:"), "seed A (recent turn or mood) injected")
  assert.equal(state.calls, 0, "sole dream candidate → no JEV call")

  await idle(hooks)
  await waitFor(async () => (await readDreamLog(dir)).length > 0)

  // The bucket: parseable metadata comment + narrative (§17.6).
  const bucket = await readFile(join(dir, "Brain", "Kael Dreams.md"), "utf8")
  const entries = parseDreamBucket(bucket)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, "Glass elevator")
  assert.ok(entries[0].meta, "metadata comment parses")
  assert.equal(entries[0].meta!.tone, "pleasant")
  assert.equal(entries[0].meta!.hash.length, 16)
  assert.ok(entries[0].narrative.includes("made of rain"))

  // The mood delta equals the tone table (pleasant +0.15 valence) — the
  // hook applied it, not the model.
  const mood = await readMood(dir)
  assert.ok(Math.abs((mood.valence ?? 0) - 0.15) < 0.01, `valence ${mood.valence}`)

  const sleep = await readSleep(dir)
  assert.equal(sleep.dreams_tonight, 1, "nightly cap counts dispatched dreams")
  assert.equal(sleep.noop_streak, 0)

  const [t] = await readDreamLog(dir)
  assert.equal(t.verdict, "mission:dream")
  assert.equal(t.outcome, "completed")
  assert.equal(t.token_cost, 150)
  assert.equal(t.dream_gate[0].passed, true)
  assert.equal(t.mood_event, "dream_pleasant")
})

// §17.12 acceptance #4 (timer half): status woken ⇒ the timer never fires
// (NO_REPLY / zero cost until resume_cooldown silence → dreaming again).
test("woken state: the dream timer stays silent until cooldown, then reconciles to dreaming", async () => {
  // E1 — fresh activity: nothing fires.
  const dirA = await project()
  await writeNightMissions(dirA)
  await writeSleep(dirA, { status: "woken", since: new Date().toISOString(), woken_at: new Date().toISOString() })
  const clientA = dreamClient("unused")
  await createHook({ client: clientA, directory: dirA, random: () => 0 } as any)
  await new Promise((r) => setTimeout(r, 400))
  assert.deepEqual((await readDreamLog(dirA)).filter((l) => l.event === "dream-tick"), [], "woken → no dream tick, zero cost")
  assert.equal(clientA.calls.create, 0)
  assert.equal((await readSleep(dirA)).status, "woken")

  // E2 — cooldown elapsed (a NEW hook instance = the next ≤60s wake): the
  // reconcile flips woken → dreaming and the overdue tick fires once.
  const dirB = await project()
  await writeNightMissions(dirB)
  await writeSleep(dirB, {
    status: "woken",
    since: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    woken_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  })
  const clientB = dreamClient("unused")
  const hooksB = await createHook({ client: clientB, directory: dirB, random: () => 1 } as any)
  const waitFor = async (fn: () => Promise<boolean>, ms = 4000): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("waitFor timeout")
  }
  await waitFor(async () => (await readDreamLog(dirB)).filter((l) => l.event === "dream-tick").length > 0)
  const sleepB = await readSleep(dirB)
  assert.equal(sleepB.status, "dreaming", "resume_cooldown silence → dreaming again (§17.7)")
  assert.equal(sleepB.woken_at, null)
  void hooksB
})

// §17.12 acceptance #6 (lock half): the shared heartbeat.lock excludes the
// dream tick exactly like the heartbeat's — a fresh foreign lock skips it.
test("shared lock: a fresh heartbeat.lock skips the dream tick", async () => {
  const dir = await project()
  await writeNightMissions(dir)
  await writeSleep(dir)
  const stateDir = join(dir, ".opencode", "state")
  await writeFile(
    join(stateDir, "heartbeat.lock"),
    JSON.stringify({ pid: 4242, acquired_ms: Date.now() - 500, acquired_at: new Date().toISOString() }),
    "utf8",
  )
  const client = dreamClient("unused")
  await createHook({ client, directory: dir, random: () => 0 } as any)
  await new Promise((r) => setTimeout(r, 400))
  assert.deepEqual((await readDreamLog(dir)).filter((l) => l.event === "dream-tick"), [], "lock held → tick skipped")
  assert.equal(client.calls.create, 0)
  assert.equal((await readSleep(dir)).last_tick, 0, "a skipped tick never stamps last_tick")
})

// §17.12 acceptance #4 (heartbeat half): inside the window with status
// dreaming the HEARTBEAT itself ends as NO_REPLY with zero LLM — the dream
// timer owns sleeping time (§17.2). Lives here because it is sleep-driven.
test("heartbeat during dreaming: NO_REPLY at the sleep gate, zero LLM", async () => {
  const { default: createHeartbeat } = await import("../heartbeat-hook.ts")
  const dir = await project()
  await writeNightMissions(dir)
  await writeSleep(dir, { status: "dreaming" })
  const client = dreamClient("unused")
  await createHeartbeat({ client, directory: dir } as any)

  const waitFor = async (fn: () => Promise<boolean>, ms = 4000): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("waitFor timeout")
  }
  await waitFor(async () => (await readDreamLog(dir)).filter((l) => l.event === "tick").length > 0)
  const tick = (await readDreamLog(dir)).find((l) => l.event === "tick")
  assert.equal(tick.gate, "sleep")
  assert.equal(tick.reason, "dreaming")
  assert.equal(tick.verdict, "no_reply")
  assert.equal(client.calls.create, 0)
})

// Malformed dream outcome (§17.5): skipped with a logged valence wobble — no
// bucket entry, no tone delta, nothing half-written.
test("malformed dream outcome: skipped, wobbled, bucket untouched", async () => {
  const dir = await project()
  await writeNightMissions(dir)
  await writeSleep(dir)
  const client = dreamClient("I could not decide on a JSON shape, sorry!")
  const hooks = await createHook({ client, directory: dir, random: () => 0 } as any)
  const waitFor = async (fn: () => Promise<boolean>, ms = 4000): Promise<void> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error("waitFor timeout")
  }
  await waitFor(() => Promise.resolve(client.calls.prompts.length > 0))
  await idle(hooks)
  await waitFor(async () => (await readDreamLog(dir)).filter((l) => l.event === "dream-tick").length > 0)

  const [t] = (await readDreamLog(dir)).filter((l) => l.event === "dream-tick")
  assert.equal(t.outcome, "malformed")
  assert.equal(t.mood_event, "mission_failure", "tiny valence wobble like a failed mission (§17.5)")
  const bucket = await readFile(join(dir, "Brain", "Kael Dreams.md"), "utf8").catch(() => "")
  assert.equal(bucket, "", "nothing half-written into the bucket")
  const mood = await readMood(dir)
  assert.ok((mood.valence ?? 0) < 0, "the wobble landed")
  const sleep = await readSleep(dir)
  assert.equal(sleep.noop_streak, 1, "no landed effect counts toward the backoff")
})
