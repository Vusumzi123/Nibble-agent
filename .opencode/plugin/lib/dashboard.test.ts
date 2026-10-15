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
  heartbeatSnapshot,
  isLoopback,
  listLedgers,
  metricsSnapshot,
  renderYamlScalar,
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
