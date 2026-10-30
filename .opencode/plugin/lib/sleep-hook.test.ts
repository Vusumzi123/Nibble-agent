import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mockClient, tempDir, tempHome } from "./test-utils.ts"

// Isolate HOME before the hook module resolves anything home-scoped.
const TEST_HOME = tempHome("sleephook-home-")
void TEST_HOME
const { default: createHook } = await import("../sleep-hook.ts")

const DREAMING_SINCE = "2026-10-14T23:10:00.000Z"

async function project(
  window: string,
  opts: { injectState?: boolean; promptsFile?: string } = {},
): Promise<string> {
  const dir = await tempDir("sleephook-proj-")
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    [
      "autonomy:",
      "  level: 3",
      "  quiet:",
      `    window: "${window}"`,
      ...(opts.injectState === undefined ? [] : [`    inject_state: ${opts.injectState}`]),
      ...(opts.promptsFile === undefined ? [] : [`    prompts_file: "${opts.promptsFile}"`]),
      "",
    ].join("\n"),
    "utf8",
  )
  return dir
}

async function writeSleep(dir: string, over: Record<string, unknown>): Promise<void> {
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, "sleep.json"),
    JSON.stringify({
      version: 1,
      status: "awake",
      since: DREAMING_SINCE,
      woken_at: null,
      window_opened_at: null,
      dreams_tonight: 0,
      last_tick: 0,
      ticks: 0,
      ...over,
    }),
    "utf8",
  )
}

async function writePrompts(dir: string, file: string, values: Record<string, string>): Promise<void> {
  await writeFile(join(dir, file), JSON.stringify(values), "utf8")
}

async function readSleep(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, ".opencode", "state", "sleep.json"), "utf8"))
}

async function readMood(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, ".opencode", "state", "mood.json"), "utf8"))
}

type Hook = Awaited<ReturnType<typeof createHook>>

function turn(hooks: Hook, sid: string): Promise<void> {
  return (hooks as any)["chat.message"]({ sessionID: sid })
}

async function transform(hooks: Hook, sid: string): Promise<string[]> {
  const out: { system: string[] } = { system: [] }
  await (hooks as any)["experimental.chat.system.transform"]({ sessionID: sid }, out)
  return out.system
}

// §17.12 acceptance #4 (wake half): a user message inside the window flips
// dreaming → woken, stamps woken_at, feeds the `woken` mood event, and the
// same turn's system prompt carries [wake] + the persistent [sleepState].
test("a user turn during the window wakes: status flip + woken mood + [wake] block", async () => {
  const dir = await project("00:00-23:59") // wall-clock-independent open window
  await writeSleep(dir, { status: "dreaming", window_opened_at: DREAMING_SINCE })
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  // Every top-level turn gets the persistent state line.
  const before = await transform(hooks, "s1")
  assert.equal(before.length, 1)
  assert.ok(before[0].startsWith("[sleepState] dreaming"))

  await turn(hooks, "s1")

  const sleep = await readSleep(dir)
  assert.equal(sleep.status, "woken")
  assert.ok(sleep.woken_at, "woken_at stamped once per wake")
  assert.equal(sleep.window_opened_at, DREAMING_SINCE, "window ownership stays with the heartbeat")

  // `woken` mood event landed (arousal +0.4, valence −0.1 from baseline).
  const mood = await readMood(dir)
  assert.ok((mood.arousal ?? 0) > 0.5, `arousal ${mood.arousal}`)
  assert.ok((mood.valence ?? 0) < 0, `valence ${mood.valence}`)

  const blocks = await transform(hooks, "s1")
  assert.equal(blocks.length, 2)
  assert.ok(blocks[0].startsWith("[wake]"))
  assert.ok(blocks[0].includes(`dreaming since ${DREAMING_SINCE}`))
  assert.ok(blocks[0].includes("[mood]"), "the wake block carries the mood snapshot (§17.7)")
  assert.ok(blocks[1].startsWith("[sleepState] woken"))
  assert.ok(blocks[1].includes("groggy"), "the woken directive carries the wake's affect")
})

// The refresh half: a second turn while already woken advances `since` (so
// resume_cooldown measures from the LAST activity) without a second [wake].
test("woken activity refresh advances `since`, keeps woken_at, injects no block", async () => {
  const dir = await project("00:00-23:59")
  await writeSleep(dir, { status: "woken", since: "2026-10-14T01:00:00.000Z", woken_at: "2026-10-14T01:00:00.000Z" })
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  await turn(hooks, "s1")
  const sleep = await readSleep(dir)
  assert.equal(sleep.status, "woken", "already awake-in-window — refresh only")
  assert.equal(sleep.woken_at, "2026-10-14T01:00:00.000Z", "first-wake stamp is stable")
  assert.notEqual(sleep.since, "2026-10-14T01:00:00.000Z", "activity timestamp moved")

  const blocks = await transform(hooks, "s1")
  assert.equal(blocks.length, 1, "no repeated [wake] on refresh turns")
  assert.ok(blocks[0].startsWith("[sleepState] woken"))
})

// A turn outside the quiet window is not a wake at all (§17.7 wake trigger),
// and the stale `dreaming` status does not leak into the state line.
test("a user turn outside the window never wakes", async () => {
  const dir = await project("01:02-01:03") // closed for 1439 of 1440 minutes
  const now = new Date()
  const inWindow = now.getHours() === 1 && now.getMinutes() === 2
  if (inWindow) return // one-minute wall-clock coincidence — skip, not flake

  await writeSleep(dir, { status: "dreaming" })
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  await turn(hooks, "s1")
  const sleep = await readSleep(dir)
  assert.equal(sleep.status, "dreaming", "still dreaming — no wake outside the window")
  const blocks = await transform(hooks, "s1")
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].startsWith("[sleepState] awake"), "the clock wins over the stale status")
})

// Child/automation sessions must never drive the sleep state and never see
// the [sleepState] line (no subagent leakage).
test("child sessions never wake or receive the state line", async () => {
  const dir = await project("00:00-23:59")
  await writeSleep(dir, { status: "dreaming" })
  const client = mockClient({ childParent: { s_child: "s_parent" } })
  const hooks = await createHook({ client, directory: dir } as any)

  await turn(hooks, "s_child")
  const sleep = await readSleep(dir)
  assert.equal(sleep.status, "dreaming")
  assert.deepEqual(await transform(hooks, "s_child"), [])
})

// The kill switch silences [sleepState] everywhere but leaves [wake] intact.
test("inject_state=false suppresses [sleepState] but not [wake]", async () => {
  const dir = await project("00:00-23:59", { injectState: false })
  await writeSleep(dir, { status: "dreaming", window_opened_at: DREAMING_SINCE })
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  assert.deepEqual(await transform(hooks, "s1"), [])
  await turn(hooks, "s1")
  const blocks = await transform(hooks, "s1")
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].startsWith("[wake]"))
})

// The externalized prompt file is honored; a missing file falls back.
test("sleep prompts come from quiet.prompts_file", async () => {
  const dir = await project("00:00-23:59", { promptsFile: ".opencode/custom-sleep.json" })
  await writeSleep(dir, { status: "dreaming" })
  await writePrompts(dir, ".opencode/custom-sleep.json", {
    awake: "SENTINEL-AWAKE",
    dreaming: "SENTINEL-DREAMING",
    woken: "SENTINEL-WOKEN",
    quiet_awake: "SENTINEL-QUIET",
  })
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  const blocks = await transform(hooks, "s1")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0], "[sleepState] SENTINEL-DREAMING")

  await turn(hooks, "s1")
  const after = await transform(hooks, "s1")
  assert.equal(after.length, 2)
  assert.equal(after[1], "[sleepState] SENTINEL-WOKEN")
})

test("a missing prompts file falls back to the compiled defaults", async () => {
  const dir = await project("00:00-23:59", { promptsFile: ".opencode/nope.json" })
  await writeSleep(dir, { status: "dreaming" })
  const client = mockClient()
  const hooks = await createHook({ client, directory: dir } as any)

  const blocks = await transform(hooks, "s1")
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].startsWith("[sleepState] dreaming"))
})
