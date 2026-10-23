// Tests for the dashboard backend core (kanban card 8 — plan §9.2).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  DashboardError,
  applySectionEdits,
  backlogSnapshot,
  configSnapshot,
  createCsrfStore,
  drainSnapshot,
  flattenValues,
  guardLeaf,
  heartbeatSchedule,
  heartbeatSnapshot,
  isLoopback,
  listLedgers,
  memoryPendingSnapshot,
  metricsSnapshot,
  missionsSnapshot,
  resetDrainCache,
  resetMemoryPendingCache,
  resetQueuesCache,
  runsSnapshot,
  queuesSnapshot,
  tokenSeriesSnapshot,
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

test("guardLeaf: serve_url must be a loopback http(s) URL", () => {
  const ctx = { autonomyLevel: 3, authMode: "off" }
  assert.equal(guardLeaf("dashboard", { path: "serve_url", value: "http://127.0.0.1:4095" }, ctx), null)
  assert.equal(guardLeaf("dashboard", { path: "serve_url", value: "http://localhost:4096" }, ctx), null)
  assert.equal(guardLeaf("dashboard", { path: "serve_url", value: "http://[::1]:4095" }, ctx), null)
  assert.equal(guardLeaf("dashboard", { path: "serve_url", value: "http://192.168.1.10:4096" }, ctx)?.code, "serve_requires_loopback")
  assert.equal(guardLeaf("dashboard", { path: "serve_url", value: "not a url" }, ctx)?.code, "serve_requires_loopback")
  assert.equal(guardLeaf("dashboard", { path: "serve_url", value: 4096 }, ctx)?.code, "serve_requires_loopback")
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

test("writeConfig: mission-lock dials are writable; stale must exceed refresh", async () => {
  const dir = await project()
  const res = await writeConfig(dir, "heartbeat", {
    mission_stall_minutes: 4,
    mission_timeout_minutes: 20,
    mission_lock_refresh_ms: 30_000,
    mission_lock_stale_ms: 600_000,
    mission_summary_timeout_ms: 45_000,
    mission_max_resumes: 2,
  })
  assert.deepEqual(res.applied, {
    mission_stall_minutes: 4,
    mission_timeout_minutes: 20,
    mission_lock_refresh_ms: 30_000,
    mission_lock_stale_ms: 600_000,
    mission_summary_timeout_ms: 45_000,
    mission_max_resumes: 2,
  })
  const cfg = await configSnapshot(dir)
  assert.equal(cfg.heartbeat.mission_stall_minutes, 4)
  assert.equal(cfg.heartbeat.mission_timeout_minutes, 20)
  assert.equal(cfg.heartbeat.mission_lock_refresh_ms, 30_000)
  assert.equal(cfg.heartbeat.mission_lock_stale_ms, 600_000)
  assert.equal(cfg.heartbeat.mission_summary_timeout_ms, 45_000)
  assert.equal(cfg.heartbeat.mission_max_resumes, 2)

  // stale <= refresh is refused and the file is untouched.
  const before = await readConfig(dir)
  await assert.rejects(
    () => writeConfig(dir, "heartbeat", { mission_lock_stale_ms: 30_000 }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  assert.equal(await readConfig(dir), before)

  // negative values are refused by the per-leaf int rule.
  await assert.rejects(
    () => writeConfig(dir, "heartbeat", { mission_timeout_minutes: -1 }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  await assert.rejects(
    () => writeConfig(dir, "heartbeat", { mission_stall_minutes: -1 }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )

  // a non-int stall is refused; the file is untouched.
  const beforeStall = await readConfig(dir)
  await assert.rejects(
    () => writeConfig(dir, "heartbeat", { mission_stall_minutes: 1.5 }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  assert.equal(await readConfig(dir), beforeStall)

  // stall and the hard ceiling cannot both be off (a flat stall with no ceiling).
  const beforeFlat = await readConfig(dir)
  await assert.rejects(
    () => writeConfig(dir, "heartbeat", { mission_stall_minutes: 0, mission_timeout_minutes: 0 }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  assert.equal(await readConfig(dir), beforeFlat)

  // absent keys fall back to the reader's defaults.
  const snap = await configSnapshot(await project())
  assert.equal(snap.heartbeat.mission_stall_minutes, 10)
  assert.equal(snap.heartbeat.mission_timeout_minutes, 0)
  assert.equal(snap.heartbeat.mission_lock_refresh_ms, 60_000)
  assert.equal(snap.heartbeat.mission_lock_stale_ms, 1_800_000)
  assert.equal(snap.heartbeat.mission_summary_timeout_ms, 90_000)
  assert.equal(snap.heartbeat.mission_max_resumes, 3)
})

test("writeConfig: drain trigger thresholds are writable, validated, hot-read", async () => {
  const dir = await project()
  const res = await writeConfig(dir, "drain", { trigger_pending: 4, trigger_max_age_hours: 1 })
  assert.deepEqual(res.applied, { trigger_pending: 4, trigger_max_age_hours: 1 })
  const cfg = await configSnapshot(dir)
  assert.equal(cfg.drain.trigger_pending, 4)
  assert.equal(cfg.drain.trigger_max_age_hours, 1)
  // all-or-nothing: a below-minimum value never lands
  await assert.rejects(
    () => writeConfig(dir, "drain", { trigger_pending: 0 }),
    (err: DashboardError) => err.status === 400 && err.code === "invalid_value",
  )
  assert.equal((await configSnapshot(dir)).drain.trigger_pending, 4)
  // absent keys fall back to the reader's defaults
  const snap = await configSnapshot(await project())
  assert.equal(snap.drain.trigger_pending, 12)
  assert.equal(snap.drain.trigger_max_age_hours, 2)
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
  assert.equal(snap.drain.trigger_pending, 12)
  assert.equal(snap.drain.trigger_max_age_hours, 2)
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

// --- memory pending snapshot ----------------------------------------------

async function pendingProject(
  opts: { enabled?: boolean; provider?: string; cursor?: number | null } = {},
): Promise<{ dir: string; dbFile: string }> {
  const dir = await project(
    CONFIG +
      `\ndrain:\n  enabled: ${opts.enabled ?? true}\n\nmemory:\n  provider: ${opts.provider ?? "rag-brain"}\n`,
  )
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  if (opts.cursor !== null) {
    await writeFile(
      join(stateDir, "drain-cursor.json"),
      JSON.stringify({ version: 1, last_ts: opts.cursor ?? 1000 }),
      "utf8",
    )
  }
  return { dir, dbFile: join(dir, "opencode.db") }
}

function pendingDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      time_updated INTEGER NOT NULL,
      time_created INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX message_session_time_created_id_idx
      ON message(session_id, time_created, id);
  `)
  return db
}

function addSession(
  db: DatabaseSync,
  id: string,
  directory: string,
  parent: string | null = null,
  title = "",
): void {
  db.prepare(
    "INSERT INTO session (id, parent_id, directory, time_updated, title) VALUES (?, ?, ?, ?, ?)",
  ).run(id, parent, directory, 3_000, title)
}

function addTurn(
  db: DatabaseSync,
  id: string,
  sessionID: string,
  time: number,
  text: string,
  synthetic = false,
): void {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    id,
    sessionID,
    time,
    JSON.stringify({ role: "user" }),
  )
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    `${id}-p`,
    id,
    JSON.stringify({ type: "text", text, synthetic }),
  )
}

function seedPendingDb(file: string, dir: string): void {
  const db = pendingDb(file)
  addSession(db, "top-1", dir)
  addSession(db, "top-drain", dir, null, "knowledge-consolidate")
  addSession(db, "child-1", dir, "top-1")
  addSession(db, "other-1", "/work/other")

  addTurn(db, "m1", "top-1", 2_000, "hello")
  addTurn(db, "m2", "top-1", 500, "too old")
  addTurn(db, "m3", "top-1", 3_000, "synthetic", true)
  addTurn(db, "m4", "top-drain", 3_000, "drain child")
  addTurn(db, "m5", "child-1", 3_000, "subagent")
  addTurn(db, "m6", "other-1", 3_000, "other project")
  addTurn(db, "m7", "top-1", 2_500, "second")
  db.close()
}

test("memoryPendingSnapshot: counts unconsumed turns after the cursor", async () => {
  resetMemoryPendingCache()
  const { dir, dbFile } = await pendingProject()
  seedPendingDb(dbFile, dir)
  const snap = await memoryPendingSnapshot(dir, { dbFile, now: 10_000 })
  assert.equal(snap.available, true)
  assert.equal(snap.pending_turns, 2)
  assert.equal(snap.enabled, true)
  assert.equal(snap.provider, "rag-brain")
  assert.equal(snap.writer, true)
  assert.equal(snap.paused, false)
  assert.equal(snap.cursor_last_ts, 1_000)
  assert.equal(snap.seeded, false)
})

test("memoryPendingSnapshot: disabled drain still reports the backlog as paused", async () => {
  resetMemoryPendingCache()
  const { dir, dbFile } = await pendingProject({ enabled: false })
  seedPendingDb(dbFile, dir)
  const snap = await memoryPendingSnapshot(dir, { dbFile, now: 10_000 })
  assert.equal(snap.pending_turns, 2)
  assert.equal(snap.enabled, false)
  assert.equal(snap.paused, true)
})

test("memoryPendingSnapshot: a provider without a writer is paused", async () => {
  resetMemoryPendingCache()
  const { dir, dbFile } = await pendingProject({ provider: "memory-explorer" })
  seedPendingDb(dbFile, dir)
  const snap = await memoryPendingSnapshot(dir, { dbFile, now: 10_000 })
  assert.equal(snap.writer, false)
  assert.equal(snap.paused, true)
})

test("memoryPendingSnapshot: unavailable database yields null, not 0", async () => {
  resetMemoryPendingCache()
  const { dir } = await pendingProject()
  const snap = await memoryPendingSnapshot(dir, { dbFile: join(dir, "missing.db"), now: 10_000 })
  assert.equal(snap.available, false)
  assert.equal(snap.pending_turns, null)
  assert.ok(snap.error)
})

test("memoryPendingSnapshot: a fresh cursor uses the initial lookback", async () => {
  resetMemoryPendingCache()
  const now = 10_000_000
  const { dir, dbFile } = await pendingProject({ cursor: null })
  const db = pendingDb(dbFile)
  addSession(db, "top-1", dir)
  addTurn(db, "m1", "top-1", now - 3_600_000, "within lookback")
  addTurn(db, "m2", "top-1", now - 30 * 3_600_000, "before lookback")
  db.close()
  const snap = await memoryPendingSnapshot(dir, { dbFile, now })
  assert.equal(snap.seeded, true)
  assert.equal(snap.pending_turns, 1)
  assert.equal(snap.cursor_last_ts, now - 24 * 3_600_000)
})

// --- lane queues, recent runs, token series --------------------------------

test("queuesSnapshot: lane items carry titles, age, TTL and requeue info", async () => {
  const dir = await project()
  await withMissions(dir, { drain: missionFile("drain") })
  await mkdir(join(dir, ".opencode", "state"), { recursive: true })
  const now = Date.parse("2026-10-20T12:00:00Z")
  await writeFile(
    join(dir, ".opencode", "state", "lanes.json"),
    JSON.stringify({
      primary: [
        {
          id: "mission:drain",
          kind: "mission",
          lane: "primary",
          producer: "tick",
          enqueued_ms: now - 60_000,
          expires_ms: now + 3_600_000,
          requeue_count: 0,
        },
      ],
      side: [
        {
          id: "mission:dream",
          kind: "mission",
          producer: "turns-pending",
          enqueued_ms: now - 1_000,
          requeue_count: 2,
          requeue_reason: "timeout",
        },
      ],
    }),
    "utf8",
  )
  resetQueuesCache()
  const snap = await queuesSnapshot(dir, now)
  assert.equal(snap.available, true)
  assert.equal(snap.primary[0].title, "drain mission")
  assert.equal(snap.primary[0].age_ms, 60_000)
  assert.equal(snap.primary[0].ttl_ms, 3_600_000)
  assert.equal(snap.side[0].requeue_count, 2)
  assert.equal(snap.side[0].requeue_reason, "timeout")
  assert.equal(snap.side[0].ttl_ms, null)
})

test("queuesSnapshot: a missing lanes.json degrades to available:false", async () => {
  const dir = await project()
  resetQueuesCache()
  const snap = await queuesSnapshot(dir, Date.now())
  assert.equal(snap.available, false)
  assert.deepEqual(snap.primary, [])
  assert.deepEqual(snap.side, [])
  assert.equal(snap.running.mission, null)
})

test("runsSnapshot: runs[] plus legacy fallback, newest first, filters apply", async () => {
  const dir = await project()
  await withMissions(dir, { drain: missionFile("drain") })
  await mkdir(join(dir, ".opencode", "logs"), { recursive: true })
  const now = Date.now()
  const lines = [
    { ts: new Date(now - 120_000).toISOString(), tick: 1, mission: "drain", outcome: "completed", token_cost: 1000, session: "ses_old" },
    {
      ts: new Date(now - 60_000).toISOString(),
      tick: 2,
      runs: [
        { mission: "drain", lane: "side", outcome: "completed", token_cost: 5000, over_budget: true, session: "ses_side", tool_session: "ses_writer" },
        { mission: "drain", lane: "primary", outcome: "timeout", token_cost: 2000, over_budget: false, session: "ses_primary", requeued: true },
      ],
      duration_ms: 1234,
    },
  ]
  await writeFile(join(dir, ".opencode", "logs", "heartbeat.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8")

  const all = await runsSnapshot(dir, { limit: 10 })
  assert.equal(all.available, true)
  assert.equal(all.runs.length, 3)
  assert.equal(all.runs[0].lane, "primary")
  assert.equal(all.runs[0].tick, 2)
  assert.equal(all.runs[0].mission_title, "drain mission")
  assert.equal(all.runs[0].requeued, true)
  assert.equal(all.runs[0].duration_ms, 1234)
  assert.equal(all.runs[1].lane, "side")
  assert.equal(all.runs[1].over_budget, true)
  assert.equal(all.runs[1].tool_session, "ses_writer")
  assert.equal(all.runs[2].tick, 1)
  assert.equal(all.runs[2].lane, "primary")

  const side = await runsSnapshot(dir, { lane: "side" })
  assert.equal(side.runs.length, 1)
  const timeouts = await runsSnapshot(dir, { outcome: "timeout" })
  assert.equal(timeouts.runs.length, 1)
  assert.equal(timeouts.runs[0].session, "ses_primary")
})

test("tokenSeriesSnapshot: buckets tokens vs budget and counts over-runs", async () => {
  const dir = await project()
  await mkdir(join(dir, ".opencode", "logs"), { recursive: true })
  const now = Date.now()
  const lines = [
    {
      ts: new Date(now - 90_000).toISOString(),
      tick: 1,
      runs: [
        { mission: "drain", lane: "primary", outcome: "completed", token_cost: 40_000, over_budget: true },
        { mission: "drain", lane: "side", outcome: "completed", token_cost: 10_000, over_budget: false },
      ],
    },
  ]
  await writeFile(join(dir, ".opencode", "logs", "heartbeat.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8")

  const hourly = await tokenSeriesSnapshot(dir, { bucket: "hour", hours: 24 })
  assert.equal(hourly.available, true)
  assert.equal(hourly.points.length, 1)
  assert.equal(hourly.points[0].tokens, 50_000)
  assert.equal(hourly.points[0].runs, 2)
  assert.equal(hourly.points[0].over_runs, 1)
  assert.equal(hourly.totals.tokens, 50_000)
  assert.equal(typeof hourly.budget_per_run, "number")

  const primary = await tokenSeriesSnapshot(dir, { bucket: "tick", hours: 24, lane: "primary" })
  assert.equal(primary.totals.tokens, 40_000)
  assert.equal(primary.points[0].tick, 1)
})

// --- drain consumer snapshot (plan §6.1) ----------------------------------

async function drainProject(config = CONFIG): Promise<string> {
  const dir = await project(config)
  const stateDir = join(dir, ".opencode", "state")
  const logDir = join(dir, ".opencode", "logs")
  await mkdir(stateDir, { recursive: true })
  await mkdir(logDir, { recursive: true })
  return dir
}

test("drainSnapshot: a missing marker still reports config dials", async () => {
  resetDrainCache()
  const dir = await drainProject()
  const snap = await drainSnapshot(dir)
  assert.equal(snap.available, true)
  assert.equal(snap.state, "unknown")
  assert.equal(snap.enabled, true)
  assert.equal(snap.consumer, true)
  assert.equal(snap.trigger_pending, 12, "default trigger surfaces")
  assert.equal(snap.wake, null)
  assert.equal(snap.last_pass, null)
})

test("drainSnapshot: marker + ledger lines populate wake and last_pass", async () => {
  resetDrainCache()
  const dir = await drainProject()
  const stateDir = join(dir, ".opencode", "state")
  const logDir = join(dir, ".opencode", "logs")
  await writeFile(
    join(stateDir, "drain.current.json"),
    JSON.stringify({
      state: "idle",
      trigger: "consumer",
      pass: 2,
      pending: 7,
      oldest_pending_age_ms: 90_000,
      started_at: "2026-10-22T00:00:00.000Z",
      updated_at: "2026-10-22T00:05:00.000Z",
      next_due: 1_800_000_000_000,
    }),
    "utf8",
  )
  const ledgerLines = [
    { ts: "2026-10-22T00:04:00.000Z", source: "pipe", outcome: "completed", wall_ms: 1200, tokens: 32_000, sessions: 2, items: 6 },
    { ts: "2026-10-22T00:05:00.000Z", source: "consumer", outcome: "ok", passes: 3, wake_tokens: 96_000, wall_ms: 214_000, stopped: "backlog-below-trigger" },
  ]
  await writeFile(join(logDir, "drain.log"), ledgerLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8")

  const snap = await drainSnapshot(dir)
  assert.equal(snap.state, "idle")
  assert.equal(snap.pass, 2)
  assert.equal(snap.pending, 7)
  assert.equal(snap.oldest_pending_age_ms, 90_000)
  assert.equal(snap.next_due, 1_800_000_000_000)
  assert.deepEqual(snap.wake, {
    passes: 3,
    wake_tokens: 96_000,
    wall_ms: 214_000,
    stopped: "backlog-below-trigger",
  })
  assert.equal(snap.last_pass?.outcome, "completed")
  assert.equal(snap.last_pass?.tokens, 32_000)
  assert.equal(snap.last_pass?.items, 6)
})

test("drainSnapshot: results are cached for 5s and resetDrainCache clears", async () => {
  resetDrainCache()
  const dir = await drainProject()
  const first = await drainSnapshot(dir, 1_000)
  // Marker appears after the cached read: same cache window returns stale data.
  await writeFile(
    join(dir, ".opencode", "state", "drain.current.json"),
    JSON.stringify({ state: "running", pending: 42, updated_at: "2026-10-22T00:00:00.000Z" }),
    "utf8",
  )
  const cached = await drainSnapshot(dir, 2_000)
  assert.equal(cached.state, first.state, "cached within the TTL")
  resetDrainCache()
  const fresh = await drainSnapshot(dir, 3_000)
  assert.equal(fresh.state, "running")
  assert.equal(fresh.pending, 42)
})

test("runsSnapshot: drain pipe lines surface as lane=drain rows", async () => {
  const dir = await project()
  await withMissions(dir, { drain: missionFile("drain") })
  await mkdir(join(dir, ".opencode", "logs"), { recursive: true })
  const now = Date.now()
  await writeFile(
    join(dir, ".opencode", "logs", "heartbeat.log"),
    JSON.stringify({
      ts: new Date(now - 60_000).toISOString(),
      tick: 5,
      runs: [{ mission: "research", lane: "primary", outcome: "completed", token_cost: 100 }],
    }) + "\n",
    "utf8",
  )
  await writeFile(
    join(dir, ".opencode", "logs", "drain.log"),
    JSON.stringify({
      ts: new Date(now - 30_000).toISOString(),
      source: "pipe",
      outcome: "completed",
      tokens: 40_000,
      wall_ms: 900,
      sessions: 2,
      items: 5,
    }) + "\n",
    "utf8",
  )

  const all = await runsSnapshot(dir, { limit: 10 })
  assert.equal(all.runs.length, 2)
  assert.equal(all.runs[0].lane, "drain", "newest first: the drain pass")
  assert.equal(all.runs[0].mission, "drain")
  assert.equal(all.runs[0].token_cost, 40_000)
  assert.equal(all.runs[0].duration_ms, 900)
  assert.equal(all.runs[1].lane, "primary")

  const drainOnly = await runsSnapshot(dir, { lane: "drain" })
  assert.equal(drainOnly.runs.length, 1)

  const tokens = await tokenSeriesSnapshot(dir, { bucket: "tick", hours: 24, lane: "drain" })
  assert.equal(tokens.totals.tokens, 40_000)
})

test("queuesSnapshot: carries a drain consumer pointer", async () => {
  resetQueuesCache()
  resetDrainCache()
  const dir = await project()
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, "drain.current.json"),
    JSON.stringify({ state: "running", pending: 15, next_due: null, updated_at: "2026-10-22T00:00:00.000Z" }),
    "utf8",
  )
  const snap = await queuesSnapshot(dir)
  assert.ok(snap.drain)
  assert.equal(snap.drain!.consumer, true)
  assert.equal(snap.drain!.state, "running")
  assert.equal(snap.drain!.pending, 15)
})
