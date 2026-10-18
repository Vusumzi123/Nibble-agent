// Tests for the dashboard backend core (kanban card 8 — plan §9.2).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DashboardError,
  applySectionEdits,
  backlogSnapshot,
  configSnapshot,
  createCsrfStore,
  flattenValues,
  guardLeaf,
  heartbeatSchedule,
  heartbeatSnapshot,
  isLoopback,
  listLedgers,
  metricsSnapshot,
  missionsSnapshot,
  renderYamlScalar,
  setMissionEnabled,
  tailLedger,
  validateRoundTrip,
  writeConfig,
} from "./dashboard.ts"

const CONFIG = `paths:
  vault: Brain
  diagrams: diagrams
  log: .opencode/logs
  state: .opencode/state

autonomy:
  level: 1                     # 0..4 capability dial (§4.1)
  gate_scope: main             # main | all
  heartbeat:
    frequency: 12h             # off | <n>m | <n>h
    in_progress_lock: true
  quiet:
    window: "23:00-08:00"
    dream_chance: 0.5
  root_classes: []

mood:
  dispatch_influence: true     # bounded + ledger-journaled
  decay_half_life: 6h

comms:
  default_channel: telegram    # telegram | email
  session_ttl: 24h
  telegram:
    enabled: false
    bot_token_file: ""
    chat_id_file: ""
  email:
    enabled: false
    account: kaelsysop
    reply_window_hours: 48

dashboard:                     # local web UI (§9)
  bind_address: 127.0.0.1      # loopback only
  auth:
    mode: off                  # off | login | login+2fa
    require_tls: false
`

async function project(config = CONFIG): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dash-core-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), config, "utf8")
  return dir
}

async function readConfig(dir: string): Promise<string> {
  return readFile(join(dir, ".opencode", "sysop-config.yaml"), "utf8")
}

// --- flatten + render ------------------------------------------------------

test("flattenValues flattens nested objects and dotted keys", () => {
  assert.deepEqual(flattenValues({ a: 1, "b": { c: true } }), [
    { path: "a", value: 1 },
    { path: "b.c", value: true },
  ])
  assert.deepEqual(flattenValues({ "x.y": "z" }), [{ path: "x.y", value: "z" }])
})

test("flattenValues refuses null, arrays-at-root, and bad keys", () => {
  assert.throws(() => flattenValues({ a: null }), DashboardError)
  assert.throws(() => flattenValues({ "bad key": 1 }), DashboardError)
  assert.throws(() => flattenValues([1, 2]), DashboardError)
})

test("renderYamlScalar round-trippable forms", () => {
  assert.equal(renderYamlScalar(true), "true")
  assert.equal(renderYamlScalar(false), "false")
  assert.equal(renderYamlScalar(0.5), "0.5")
  assert.equal(renderYamlScalar("12h"), "12h")
  assert.equal(renderYamlScalar(""), '""')
  assert.equal(renderYamlScalar("a b"), '"a b"')
  assert.equal(renderYamlScalar([]), "[]")
  assert.equal(renderYamlScalar(["tool:x:vault-write"]), "[tool:x:vault-write]")
  assert.throws(() => renderYamlScalar({ a: 1 }), DashboardError)
  assert.throws(() => renderYamlScalar(Number.NaN), DashboardError)
})

// --- line surgery ----------------------------------------------------------

test("applySectionEdits replaces a scalar and preserves its comment", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { level: "4" })
  const line = next.split("\n").find((l) => l.includes("level:"))!
  assert.match(line, /^ {2}level: 4 +# 0\.\.4 capability dial/)
  // untouched neighbours
  assert.ok(next.includes("gate_scope: main             # main | all"))
  assert.ok(next.includes("decay_half_life: 6h"))
})

test("applySectionEdits replaces a nested scalar inside its block", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { "heartbeat.frequency": "30m" })
  assert.match(next, / {4}frequency: 30m +# off \| <n>m/)
  assert.ok(next.includes("in_progress_lock: true"))
  // section after autonomy untouched
  assert.ok(next.includes("mood:\n  dispatch_influence: true"))
})

test("applySectionEdits inserts a missing scalar at the end of the section", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { enforcement: "per-command" })
  // lands at the end of the autonomy block, before the next section key
  assert.match(next, /\n {2}enforcement: per-command\nmood:/)
  assert.ok(next.includes("root_classes: []"))
})

test("applySectionEdits creates a missing sub-block and key", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { "chatter.enabled": "true" })
  assert.match(next, /\n {2}chatter:\n {4}enabled: true\n/)
  // everything else byte-identical around it
  assert.ok(next.includes('    window: "23:00-08:00"'))
})

test("applySectionEdits leaves unrelated sections byte-identical", () => {
  const next = applySectionEdits(CONFIG, "mood", { decay_half_life: "12h" })
  const before = CONFIG.split("comms:")[1]
  const after = next.split("comms:")[1]
  assert.equal(after, before)
})

test("applySectionEdits appends a section that does not exist yet", () => {
  const next = applySectionEdits("mood:\n  decay_half_life: 6h\n", "autonomy", { level: "2" })
  assert.match(next, /autonomy:\n {2}level: 2/)
})

// --- round-trip validation -------------------------------------------------

test("validateRoundTrip: valid edit passes", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { level: "3", "heartbeat.frequency": "1h" })
  assert.deepEqual(validateRoundTrip(next, "autonomy", { level: 3, "heartbeat.frequency": "1h" }), [])
})

test("validateRoundTrip: unknown key is caught", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { bogus: "1" })
  const problems = validateRoundTrip(next, "autonomy", { bogus: "1" })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].path, "bogus")
})

test("validateRoundTrip: type slip (string where int) is caught", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { level: "3" })
  const problems = validateRoundTrip(next, "autonomy", { level: "3" })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].reason, "value did not round-trip")
})

test("validateRoundTrip: bad enum is caught", () => {
  const next = applySectionEdits(CONFIG, "autonomy", { gate_scope: "everywhere" })
  const problems = validateRoundTrip(next, "autonomy", { gate_scope: "everywhere" })
  assert.ok(problems.some((p) => p.path === "gate_scope"))
})

// --- guards ----------------------------------------------------------------

test("isLoopback", () => {
  assert.ok(isLoopback("127.0.0.1"))
  assert.ok(isLoopback("localhost"))
  assert.ok(isLoopback("::1"))
  assert.ok(!isLoopback("0.0.0.0"))
  assert.ok(!isLoopback("192.168.1.10"))
})

test("guardLeaf: level raise needs login+2fa", () => {
  const ctx = { autonomyLevel: 1, authMode: "off" }
  assert.equal(guardLeaf("autonomy", { path: "level", value: 1 }, ctx), null)
  assert.equal(guardLeaf("autonomy", { path: "level", value: 0 }, ctx), null)
  const refusal = guardLeaf("autonomy", { path: "level", value: 2 }, ctx)
  assert.equal(refusal?.status, 403)
  assert.equal(refusal?.code, "2fa_required")
  assert.equal(guardLeaf("autonomy", { path: "level", value: 2 }, { autonomyLevel: 1, authMode: "login+2fa" }), null)
})

test("guardLeaf: floor patterns refused; auth.* is card 11; bind must stay loopback", () => {
  const ctx = { autonomyLevel: 3, authMode: "off" }
  assert.equal(guardLeaf("autonomy", { path: "floor.enabled", value: false }, ctx)?.code, "floor")
  assert.equal(guardLeaf("mood", { path: "irreversibility_floor", value: true }, ctx)?.code, "floor")
  assert.equal(guardLeaf("dashboard", { path: "auth.mode", value: "login" }, ctx)?.code, "auth_card_11")
  assert.equal(guardLeaf("dashboard", { path: "bind_address", value: "0.0.0.0" }, ctx)?.code, "bind_requires_auth")
  assert.equal(guardLeaf("dashboard", { path: "bind_address", value: "127.0.0.1" }, ctx), null)
})

// --- writeConfig -----------------------------------------------------------

test("writeConfig: valid write lands, keeps comments, journals to dashboard.log", async () => {
  const dir = await project()
  const result = await writeConfig(dir, "autonomy", { "heartbeat.frequency": "30m", gate_scope: "all" })
  assert.deepEqual(result.applied, { "heartbeat.frequency": "30m", gate_scope: "all" })
  const text = await readConfig(dir)
  assert.match(text, / {4}frequency: 30m +# off/)
  assert.match(text, / {2}gate_scope: all +# main \| all/)
  // hot reader sees it (acceptance: dial changes take effect without restart)
  const cfg = await configSnapshot(dir)
  assert.equal(cfg.autonomy.heartbeat.frequency, "30m")
  assert.equal(cfg.autonomy.gate_scope, "all")
  // journal
  const log = await readFile(join(dir, ".opencode", "logs", "dashboard.log"), "utf8")
  const entry = JSON.parse(log.trim().split("\n").pop()!)
  assert.equal(entry.event, "config-write")
  assert.equal(entry.section, "autonomy")
  assert.deepEqual(entry.paths, ["heartbeat.frequency", "gate_scope"])
})

test("writeConfig: invalid value refused, file untouched", async () => {
  const dir = await project()
  const before = await readConfig(dir)
  await assert.rejects(
    () => writeConfig(dir, "autonomy", { gate_scope: "everywhere" }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  await assert.rejects(
    () => writeConfig(dir, "autonomy", { level: "3" }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  await assert.rejects(
    () => writeConfig(dir, "autonomy", { not_a_key: 1 }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  assert.equal(await readConfig(dir), before)
})

test("writeConfig: level raise without 2FA refused (Phase-4 acceptance)", async () => {
  const dir = await project()
  const before = await readConfig(dir)
  await assert.rejects(
    () => writeConfig(dir, "autonomy", { level: 3 }),
    (err: DashboardError) => err.status === 403 && err.code === "2fa_required",
  )
  assert.equal(await readConfig(dir), before)
  // same raise allowed once auth mode is login+2fa (card 11 semantics)
  const dir2 = await project(CONFIG.replace("mode: off ", "mode: login+2fa"))
  const res = await writeConfig(dir2, "autonomy", { level: 3 })
  assert.equal(res.applied.level, 3)
})

test("writeConfig: non-writable section and loopback bind refusal", async () => {
  const dir = await project()
  const before = await readConfig(dir)
  await assert.rejects(
    () => writeConfig(dir, "audit", { enabled: false }),
    (err: DashboardError) => err.status === 403 && err.code === "section_readonly",
  )
  await assert.rejects(
    () => writeConfig(dir, "dashboard", { bind_address: "0.0.0.0" }),
    (err: DashboardError) => err.status === 403 && err.code === "bind_requires_auth",
  )
  assert.equal(await readConfig(dir), before)
})

test("writeConfig: top-level heartbeat section is writable, validated, hot-read", async () => {
  const dir = await project()
  const res = await writeConfig(dir, "heartbeat", { enabled: false, long_silence_factor: 0 })
  assert.deepEqual(res.applied, { enabled: false, long_silence_factor: 0 })
  const cfg = await configSnapshot(dir)
  assert.equal(cfg.heartbeat.enabled, false)
  assert.equal(cfg.heartbeat.long_silence_factor, 0)
  // an invalid enum is refused (all-or-nothing: the file never changed)
  await assert.rejects(
    () => writeConfig(dir, "heartbeat", { log_rotate_by: "hourly" }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
})

test("writeConfig: journal written with origin metadata", async () => {
  const dir = await project()
  await writeConfig(dir, "mood", { dispatch_influence: false }, { origin: "http://127.0.0.1:4097", ip: "::ffff:127.0.0.1" })
  const log = await readFile(join(dir, ".opencode", "logs", "dashboard.log"), "utf8")
  const entry = JSON.parse(log.trim().split("\n").pop()!)
  assert.equal(entry.origin, "http://127.0.0.1:4097")
  assert.equal(entry.ip, "::ffff:127.0.0.1")
  const cfg = await configSnapshot(dir)
  assert.equal(cfg.mood.dispatch_influence, false)
})

// --- reads -----------------------------------------------------------------

test("configSnapshot overlays defaults for absent keys", async () => {
  const dir = await project()
  const snap = await configSnapshot(dir)
  assert.equal(snap.autonomy.level, 1)
  assert.equal(snap.autonomy.enforcement, "per-task") // absent -> default
  assert.equal(snap.dashboard.auth.mode, "off")
  assert.equal(snap.comms.default_channel, "telegram")
})

test("listLedgers + tailLedger: counts, limit, whitelist", async () => {
  const dir = await project()
  const logDir = join(dir, ".opencode", "logs")
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, "audit.log"), '{"a":1}\n{"a":2}\n{"a":3}\n', "utf8")
  await writeFile(join(logDir, "mood.ndjson"), '{"m":1}\n', "utf8")
  await writeFile(join(logDir, "ignore.txt"), "x\n", "utf8")

  const ledgers = await listLedgers(logDir)
  assert.deepEqual(
    ledgers.map((l) => l.name),
    ["audit.log", "mood.ndjson"],
  )
  assert.equal(ledgers[0].lines, 3)

  const tail = await tailLedger(logDir, "audit.log", 2)
  assert.deepEqual(tail, [{ a: 2 }, { a: 3 }])

  await assert.rejects(() => tailLedger(logDir, "ignore.txt", 1), (e: DashboardError) => e.status === 400)
  await assert.rejects(() => tailLedger(logDir, "nope.log", 1), (e: DashboardError) => e.status === 404)
  await assert.rejects(() => tailLedger(logDir, "../../etc/passwd", 1), (e: DashboardError) => e.status === 400)
})

test("metricsSnapshot: config + mood default + heartbeat lock absence", async () => {
  const dir = await project()
  const snap = await metricsSnapshot(dir)
  assert.equal(snap.config.autonomy.level, 1)
  assert.ok(snap.mood)
  assert.equal(typeof snap.mood!.valence, "number")
  // no backlog file yet — the reader yields an empty snapshot, not null
  assert.deepEqual(snap.backlog, { total: 0, by_status: {} })
  assert.equal(snap.heartbeat.lock, false)
  assert.deepEqual(snap.ledgers, [])
})

test("backlogSnapshot: missing file yields empty, real file yields entries", async () => {
  const dir = await project()
  assert.deepEqual(await backlogSnapshot(dir), { total: 0, entries: [] })

  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const entry = {
    id: "b1",
    created: "2026-10-14T00:00:00.000Z",
    updated: "2026-10-14T00:00:00.000Z",
    source: "conversation",
    kind: "task",
    payload: { title: "t", detail: "", commands: [], files: [] },
    level_required: 0,
    priority: 0,
    status: "pending",
    channel_notified: null,
    awaiting_reply: false,
    jev_decision: null,
    result: null,
    view_ref: null,
    links: [],
  }
  await writeFile(join(stateDir, "backlog.ndjson"), JSON.stringify(entry) + "\n", "utf8")
  const snap = await backlogSnapshot(dir)
  assert.equal(snap.total, 1)
  assert.equal(snap.entries[0].id, "b1")
})

// --- missions: list + toggle ------------------------------------------------

function missionFile(id: string, extra = ""): string {
  return `---\nid: ${id}\ntitle: ${id} mission\nfrequency: mid\nmenus: [day]\n${extra}---\nbody\n`
}

async function withMissions(dir: string, files: Record<string, string>): Promise<void> {
  const mdir = join(dir, ".opencode", "missions")
  await mkdir(mdir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(mdir, `${name}.md`), content, "utf8")
  }
}

test("missionsSnapshot: missing dir yields empty; files report effective + file enabled", async () => {
  const empty = await project()
  assert.deepEqual(await missionsSnapshot(empty), { missions: [] })

  const dir = await project()
  await withMissions(dir, {
    drain: missionFile("drain"),
    dream: missionFile("dream", "enabled: false\n"),
  })
  const snap = await missionsSnapshot(dir)
  assert.deepEqual(
    snap.missions.map((m) => m.id),
    ["drain", "dream"],
  )
  const drain = snap.missions.find((m) => m.id === "drain")!
  assert.equal(drain.enabled, true)
  assert.equal(drain.file_enabled, true)
  assert.equal(drain.overlay, null)
  const dream = snap.missions.find((m) => m.id === "dream")!
  assert.equal(dream.enabled, false)
  assert.equal(dream.file_enabled, false)
})

test("setMissionEnabled: disable writes the overlay, enable removes it (block cleaned up)", async () => {
  const dir = await project()
  await withMissions(dir, { drain: missionFile("drain") })

  const off = await setMissionEnabled(dir, "drain", false)
  assert.deepEqual(off, { id: "drain", enabled: false })
  let text = await readConfig(dir)
  assert.match(text, /missions:\n {4}drain:\n {6}enabled: false/)
  // hot path: the loader sees the disabled mission, file still enabled
  let snap = await missionsSnapshot(dir)
  assert.equal(snap.missions[0].enabled, false)
  assert.equal(snap.missions[0].file_enabled, true)

  const on = await setMissionEnabled(dir, "drain", true)
  assert.deepEqual(on, { id: "drain", enabled: true })
  text = await readConfig(dir)
  assert.ok(!text.includes("missions:"))
  snap = await missionsSnapshot(dir)
  assert.equal(snap.missions[0].enabled, true)

  // journaled
  const log = await readFile(join(dir, ".opencode", "logs", "dashboard.log"), "utf8")
  const entry = JSON.parse(log.trim().split("\n").pop()!)
  assert.equal(entry.event, "mission-toggle")
  assert.equal(entry.id, "drain")
})

test("setMissionEnabled: enable keeps other overlay keys, removing only `enabled`", async () => {
  const dir = await project(
    CONFIG.replace(
      "  root_classes: []\n",
      "  root_classes: []\n  missions:\n    drain:\n      enabled: false\n      min_level: 3\n",
    ),
  )
  await withMissions(dir, { drain: missionFile("drain") })
  assert.equal((await missionsSnapshot(dir)).missions[0].enabled, false)

  await setMissionEnabled(dir, "drain", true)
  const text = await readConfig(dir)
  assert.match(text, /missions:\n {4}drain:\n {6}min_level: 3/)
  const autonomy = text.split("\nmood:")[0] // comms later also has `enabled: false`
  assert.ok(!autonomy.includes("enabled: false"))
  assert.equal((await missionsSnapshot(dir)).missions[0].enabled, true)
})

test("setMissionEnabled: unknown mission, file-disabled enable, and bad input refused", async () => {
  const dir = await project()
  await withMissions(dir, { drain: missionFile("drain"), dream: missionFile("dream", "enabled: false\n") })

  await assert.rejects(
    () => setMissionEnabled(dir, "nope", false),
    (err: DashboardError) => err.status === 404 && err.code === "no_mission",
  )
  await assert.rejects(
    () => setMissionEnabled(dir, "dream", true),
    (err: DashboardError) => err.status === 409 && err.code === "mission_file_disabled",
  )
  await assert.rejects(
    () => setMissionEnabled(dir, "bad id", false),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_id",
  )
  await assert.rejects(
    () => setMissionEnabled(dir, "drain", "off"),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
})

test("heartbeatSchedule: first run is due, then projects from last_tick", async () => {
  const dir = await project()
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })

  const first = await heartbeatSchedule(dir, Date.UTC(2026, 9, 17, 12, 0, 0))
  assert.equal(first.frequency, "12h")
  assert.equal(first.interval_ms, 12 * 3_600_000)
  assert.equal(first.last_tick, null)
  assert.equal(first.next_tick, null)
  assert.equal(first.due, true)
  assert.equal(first.paused, false)
  assert.equal(first.off, false)

  const lastTick = Date.UTC(2026, 9, 17, 11, 0, 0)
  await writeFile(
    join(stateDir, "heartbeat.json"),
    JSON.stringify({ last_tick: lastTick, ticks: 4, noop_hash: "x", noop_streak: 0 }),
    "utf8",
  )
  const upcoming = await heartbeatSchedule(dir, Date.UTC(2026, 9, 17, 12, 0, 0))
  assert.equal(upcoming.last_tick, new Date(lastTick).toISOString())
  assert.equal(upcoming.next_tick, new Date(lastTick + 12 * 3_600_000).toISOString())
  assert.equal(upcoming.remaining_ms, 11 * 3_600_000)
  assert.equal(upcoming.due, false)
})

test("heartbeatSchedule: noop backoff stretches the interval", async () => {
  const dir = await project()
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const now = Date.UTC(2026, 9, 17, 12, 0, 0)
  await writeFile(
    join(stateDir, "heartbeat.json"),
    JSON.stringify({ last_tick: now - 3_600_000, ticks: 9, noop_hash: "x", noop_streak: 2 }),
    "utf8",
  )
  const sched = await heartbeatSchedule(dir, now)
  assert.equal(sched.interval_ms, 24 * 3_600_000)
  assert.equal(sched.next_tick, new Date(now - 3_600_000 + 24 * 3_600_000).toISOString())
})

test("heartbeatSchedule: paused (level 0 / kill switch) and off (frequency)", async () => {
  const dir = await project()
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, "heartbeat.json"), JSON.stringify({ last_tick: Date.now(), noop_streak: 0 }), "utf8")

  const cfgPath = join(dir, ".opencode", "sysop-config.yaml")
  const edit = async (section: string, values: Record<string, string>) =>
    writeFile(cfgPath, applySectionEdits(await readConfig(dir), section, values), "utf8")

  await edit("autonomy", { level: "0" })
  const paused = await heartbeatSchedule(dir)
  assert.equal(paused.paused, true)
  assert.equal(paused.due, false)
  assert.equal(paused.next_tick, null)

  await edit("autonomy", { level: "3", "heartbeat.frequency": "off" })
  const off = await heartbeatSchedule(dir)
  assert.equal(off.off, true)
  assert.equal(off.interval_ms, null)
  assert.equal(off.due, false)

  await edit("heartbeat", { enabled: "false" })
  await edit("autonomy", { "heartbeat.frequency": "30m" })
  const killed = await heartbeatSchedule(dir)
  assert.equal(killed.paused, true)
  assert.equal(killed.next_tick, null)
})

test("heartbeatSnapshot: idle (no marker) vs in-flight marker + lock", async () => {
  const dir = await project()
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })

  const idle = await heartbeatSnapshot(dir)
  assert.equal(idle.current, null)
  assert.equal(idle.lock, false)

  await writeFile(
    join(stateDir, "heartbeat.current.json"),
    JSON.stringify({
      state: "in-flight",
      tick: 3,
      phase: "mission",
      mission: "drain",
      mission_title: "Drain the turn buffer",
      session: "ses_1",
      started_at: "2026-10-15T00:00:00.000Z",
      updated_at: "2026-10-15T00:00:01.000Z",
      level: 3,
    }),
    "utf8",
  )
  await writeFile(join(stateDir, "heartbeat.lock"), JSON.stringify({ pid: 1, acquired_ms: Date.now() }), "utf8")

  const live = await heartbeatSnapshot(dir)
  assert.equal(live.current?.state, "in-flight")
  assert.equal(live.current?.mission, "drain")
  assert.equal(live.current?.session, "ses_1")
  assert.equal(live.lock, true)
  assert.equal(live.lock_stale, false)
})

// --- CSRF store ------------------------------------------------------------

test("createCsrfStore: issue, verify, expiry, sweep", () => {
  let clock = 1_000_000
  const store = createCsrfStore({ ttlMs: 1_000, now: () => clock })
  assert.equal(store.verify(undefined), false)
  assert.equal(store.verify("deadbeef"), false)

  const { token, cookie } = store.issue()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.ok(cookie.startsWith(`nibble_csrf=${token};`))
  assert.ok(cookie.includes("HttpOnly"))
  assert.ok(cookie.includes("SameSite=Strict"))
  assert.equal(store.verify(token), true)
  assert.equal(store.size(), 1)

  clock += 1_001
  assert.equal(store.verify(token), false)
  assert.equal(store.size(), 0)
})
