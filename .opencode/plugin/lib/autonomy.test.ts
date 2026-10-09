import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  AUTH_MODES,
  DEFAULT_AUTONOMY,
  DEFAULT_COMMS,
  DEFAULT_DASHBOARD,
  DEFAULT_MOOD,
  NIGHT_MENU,
  clearRejectWarnCache,
  readAutonomyConfig,
  readCommsConfig,
  readDashboardConfig,
  readMoodConfig,
} from "./autonomy.ts"
import { clearLoggerCache } from "./logging.ts"
import { parseNdjson } from "./test-utils.ts"

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "autonomy-"))
}

async function configDir(lines: string[]): Promise<string> {
  const dir = await tmpDir()
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), lines.join("\n") + "\n", "utf8")
  return dir
}

// ---------------------------------------------------------------------------
// Happy path — full §11 shape

test("readAutonomyConfig parses the full plan-§11 block", async () => {
  const dir = await configDir([
    "autonomy:",
    "  level: 3                             # working dial",
    "  heartbeat:",
    "    frequency: 6h",
    "    in_progress_lock: false",
    "  mission_token_budget: unlimited",
    "  root_classes: [systemctl restart, pacman -Syu]",
    "  chatter:",
    "    enabled: true",
    "    max_pokes: 5",
    "    daily_budget: 1",
    "    cooldown: 4h",
    "    reply_window: 12h",
    "  quiet:",
    '    window: "07:00-09:00"',
    "    dream_cadence: 45m",
    "    resume_cooldown: 30m",
    "    dream_chance: 0.25",
    "    dream_token_budget: 4000",
    "    nightly_dream_cap: 1",
    "    backoff: false",
    "    dream_missions: [dream]",
  ])
  const cfg = await readAutonomyConfig(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfg.level, 3)
  assert.deepEqual(cfg.heartbeat, { frequency: "6h", in_progress_lock: false })
  assert.equal(cfg.mission_token_budget, "unlimited")
  assert.deepEqual(cfg.root_classes, ["systemctl restart", "pacman -Syu"])
  assert.deepEqual(cfg.chatter, {
    enabled: true,
    max_pokes: 5,
    daily_budget: 1,
    cooldown: "4h",
    reply_window: "12h",
  })
  assert.deepEqual(cfg.quiet, {
    window: "07:00-09:00",
    dream_cadence: "45m",
    resume_cooldown: "30m",
    dream_chance: 0.25,
    dream_token_budget: 4000,
    nightly_dream_cap: 1,
    backoff: false,
    dream_missions: ["dream"],
  })
})

test("readMoodConfig / readCommsConfig / readDashboardConfig parse their blocks", async () => {
  const dir = await configDir([
    "mood:",
    "  dispatch_influence: false",
    "  decay_half_life: 12h",
    "comms:",
    "  default_channel: email",
    "  session_ttl: 48h",
    "  telegram:",
    "    enabled: false",
    "    bot_token_file: ~/keys/tok",
    "    chat_id_file: ~/keys/chat",
    "  email:",
    "    enabled: true",
    "    account: someone",
    "    reply_window_hours: 12",
    "dashboard:",
    "  bind_address: 127.0.0.2",
    "  auth:",
    "    mode: login+2fa",
    "    require_tls: true",
  ].join("\n").split("\n"))
  const noReject = { onReject: () => assert.fail("unexpected reject") }
  const mood = await readMoodConfig(dir, noReject)
  assert.deepEqual(mood, { dispatch_influence: false, decay_half_life: "12h" })
  const comms = await readCommsConfig(dir, noReject)
  assert.deepEqual(comms, {
    default_channel: "email",
    session_ttl: "48h",
    telegram: { enabled: false, bot_token_file: "~/keys/tok", chat_id_file: "~/keys/chat" },
    email: { enabled: true, account: "someone", reply_window_hours: 12 },
  })
  const dash = await readDashboardConfig(dir, noReject)
  assert.deepEqual(dash, {
    bind_address: "127.0.0.2",
    auth: { mode: "login+2fa", require_tls: true },
  })
})

// ---------------------------------------------------------------------------
// Invalid values — fallback to default + onReject events

test("invalid autonomy values fall back to defaults and report rejects", async () => {
  const dir = await configDir([
    "autonomy:",
    "  level: 7",
    "  mission_token_budget: -5",
    "  typo_key: hello",
    "  quiet:",
    "    window: 25:00-09:00",
    "    dream_chance: 1.5",
    "    dream_missions: [drain, chatter]",
    "    backoff: maybe",
    "  heartbeat:",
    "    frequency: sometimes",
  ])
  const events: Array<{ section: string; path: string; reason: string }> = []
  const cfg = await readAutonomyConfig(dir, { onReject: (e) => events.push(e) })
  // Every invalid value silently becomes its default.
  assert.equal(cfg.level, DEFAULT_AUTONOMY.level)
  assert.equal(cfg.mission_token_budget, DEFAULT_AUTONOMY.mission_token_budget)
  assert.equal(cfg.quiet.window, DEFAULT_AUTONOMY.quiet.window)
  assert.equal(cfg.quiet.dream_chance, DEFAULT_AUTONOMY.quiet.dream_chance)
  assert.deepEqual(cfg.quiet.dream_missions, DEFAULT_AUTONOMY.quiet.dream_missions)
  assert.equal(cfg.quiet.backoff, DEFAULT_AUTONOMY.quiet.backoff)
  assert.equal(cfg.heartbeat.frequency, DEFAULT_AUTONOMY.heartbeat.frequency)
  assert.deepEqual(
    events.map((e) => e.path).sort(),
    ["heartbeat.frequency", "level", "mission_token_budget", "quiet.backoff", "quiet.dream_chance", "quiet.dream_missions", "quiet.window", "typo_key"],
  )
  assert.ok(events.every((e) => e.section === "autonomy"))
  // Absent keys are never rejected — only present-but-invalid ones.
  assert.equal(cfg.chatter.max_pokes, DEFAULT_AUTONOMY.chatter.max_pokes)
})

test("invalid enum/list/duration values fall back per section", async () => {
  const dir = await configDir([
    "comms:",
    "  default_channel: carrier-pigeon",
    "  session_ttl: soon",
    "  email:",
    "    reply_window_hours: -1",
    "mood:",
    "  dispatch_influence: sometimes",
    "dashboard:",
    "  auth:",
    "    mode: root",
    "    require_tls: definitely",
  ])
  const events: string[] = []
  const noRejectPath = (e: { path: string }) => events.push(e.path)
  const comms = await readCommsConfig(dir, { onReject: noRejectPath })
  assert.equal(comms.default_channel, DEFAULT_COMMS.default_channel)
  assert.equal(comms.session_ttl, DEFAULT_COMMS.session_ttl)
  assert.equal(comms.email.reply_window_hours, DEFAULT_COMMS.email.reply_window_hours)
  const mood = await readMoodConfig(dir, { onReject: noRejectPath })
  assert.equal(mood.dispatch_influence, DEFAULT_MOOD.dispatch_influence)
  const dash = await readDashboardConfig(dir, { onReject: noRejectPath })
  assert.equal(dash.auth.mode, DEFAULT_DASHBOARD.auth.mode)
  assert.equal(dash.auth.require_tls, DEFAULT_DASHBOARD.auth.require_tls)
  assert.deepEqual(events.sort(), ["auth.mode", "auth.require_tls", "default_channel", "dispatch_influence", "email.reply_window_hours", "session_ttl"])
})

test("missing config dir yields the defaults with no rejects", async () => {
  const dir = join(await tmpDir(), "nope")
  const noReject = { onReject: () => assert.fail("unexpected reject") }
  assert.deepEqual(await readAutonomyConfig(dir, noReject), DEFAULT_AUTONOMY)
  assert.deepEqual(await readMoodConfig(dir, noReject), DEFAULT_MOOD)
  assert.deepEqual(await readCommsConfig(dir, noReject), DEFAULT_COMMS)
  assert.deepEqual(await readDashboardConfig(dir, noReject), DEFAULT_DASHBOARD)
})

// ---------------------------------------------------------------------------
// Default warning log (no onReject override)

test("rejected values are logged once per process to autonomy-config.log", async () => {
  clearRejectWarnCache()
  clearLoggerCache()
  const dir = await configDir(["autonomy:", "  level: 99"])
  const logPath = join(dir, ".opencode", "logs", "autonomy-config.log")

  const cfg = await readAutonomyConfig(dir)
  assert.equal(cfg.level, DEFAULT_AUTONOMY.level)
  const lines = parseNdjson(await readFile(logPath, "utf8"))
  assert.equal(lines.length, 1)
  const entry = lines[0] as Record<string, unknown>
  assert.equal(entry.event, "config-reject")
  assert.equal(entry.section, "autonomy")
  assert.equal(entry.path, "level")
  assert.equal(entry.action, "default")

  // Second read in the same process: deduped, still one line.
  await readAutonomyConfig(dir)
  const after = parseNdjson(await readFile(logPath, "utf8"))
  assert.equal(after.length, 1)
  clearRejectWarnCache()
})

test("a valid value after a fix stops generating rejects", async () => {
  clearRejectWarnCache()
  const dir = await configDir(["autonomy:", "  level: 4"])
  const events: string[] = []
  const cfg = await readAutonomyConfig(dir, { onReject: (e) => events.push(e.path) })
  assert.equal(cfg.level, 4)
  assert.deepEqual(events, [])
})

// ---------------------------------------------------------------------------
// Live config + invariants

test("readAutonomyConfig overlays the real sysop-config.yaml on defaults", async () => {
  const cfg = await readAutonomyConfig(PROJECT_ROOT, { onReject: () => assert.fail("live config rejects") })
  assert.equal(cfg.level, 2)
  assert.equal(cfg.heartbeat.frequency, "12h")
  assert.equal(cfg.mission_token_budget, 32000)
  assert.deepEqual(cfg.root_classes, [])
  assert.equal(cfg.chatter.enabled, false)
  assert.equal(cfg.quiet.window, "23:00-08:00")
  assert.deepEqual(cfg.quiet.dream_missions, ["drain", "dream"])

  const comms = await readCommsConfig(PROJECT_ROOT, { onReject: () => assert.fail("live config rejects") })
  assert.equal(comms.default_channel, "telegram")
  assert.equal(comms.email.account, "kaelsysop")

  const dash = await readDashboardConfig(PROJECT_ROOT, { onReject: () => assert.fail("live config rejects") })
  assert.equal(dash.bind_address, "127.0.0.1")
  assert.equal(dash.auth.mode, "off")
})

test("defaults match the plan §11 / §17.11 tables", () => {
  assert.equal(DEFAULT_AUTONOMY.level, 1) // safe code default; live config ships 2
  assert.deepEqual(DEFAULT_AUTONOMY.quiet.window, "23:00-08:00")
  assert.deepEqual(DEFAULT_AUTONOMY.quiet.dream_missions, [...NIGHT_MENU])
  assert.deepEqual(NIGHT_MENU, ["drain", "dream"]) // §17.4 strict night whitelist
  assert.deepEqual([...AUTH_MODES], ["off", "login", "login+2fa"]) // §10
  assert.equal(DEFAULT_MOOD.decay_half_life, "6h")
  assert.equal(DEFAULT_DASHBOARD.bind_address, "127.0.0.1")
})

test("hot-read: a config edit is visible on the next call, no restart", async () => {
  const dir = await configDir(["autonomy:", "  level: 0"])
  const first = await readAutonomyConfig(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(first.level, 0)
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), "autonomy:\n  level: 4\n", "utf8")
  const second = await readAutonomyConfig(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(second.level, 4)
})

// ---------------------------------------------------------------------------
// gate_mode (card E) — the misbehaviour kill switch

test("gate_mode defaults to gate, parses shadow, and fails closed on invalid", async () => {
  // Missing key -> default `gate` (enforcement on unless opted out).
  const missing = await configDir(["autonomy:", "  level: 2"])
  const cfgMissing = await readAutonomyConfig(missing, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgMissing.gate_mode, "gate")
  assert.equal(DEFAULT_AUTONOMY.gate_mode, "gate")

  // Explicit shadow parses (the kill switch).
  const shadow = await configDir(["autonomy:", "  gate_mode: shadow"])
  const cfgShadow = await readAutonomyConfig(shadow, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgShadow.gate_mode, "shadow")

  // Invalid value -> reject + default `gate` stands (fail-closed).
  const invalid = await configDir(["autonomy:", "  gate_mode: passthrough"])
  const events: string[] = []
  const cfgInvalid = await readAutonomyConfig(invalid, { onReject: (e) => events.push(e.path) })
  assert.equal(cfgInvalid.gate_mode, "gate")
  assert.deepEqual(events, ["gate_mode"])
})

test("gate_mode is hot-read: a flip applies on the next call, no restart", async () => {
  const dir = await configDir(["autonomy:", "  gate_mode: gate"])
  const first = await readAutonomyConfig(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(first.gate_mode, "gate")
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), "autonomy:\n  gate_mode: shadow\n", "utf8")
  const second = await readAutonomyConfig(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(second.gate_scope, "main") // absent key keeps the default
  assert.equal(second.gate_mode, "shadow")
})

// ---------------------------------------------------------------------------
// gate_scope — sub-agent children are floor-only under `main`

test("gate_scope defaults to main, parses all, and fails closed on invalid", async () => {
  // Missing key -> default `main` (dial drives the human session only).
  const missing = await configDir(["autonomy:", "  level: 2"])
  const cfgMissing = await readAutonomyConfig(missing, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgMissing.gate_scope, "main")
  assert.equal(DEFAULT_AUTONOMY.gate_scope, "main")

  // Explicit `all` parses (Phase 1 gate-everything behaviour).
  const all = await configDir(["autonomy:", "  gate_scope: all"])
  const cfgAll = await readAutonomyConfig(all, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgAll.gate_scope, "all")

  // Invalid value -> reject + default `main` stands.
  const invalid = await configDir(["autonomy:", "  gate_scope: everywhere"])
  const events: string[] = []
  const cfgInvalid = await readAutonomyConfig(invalid, { onReject: (e) => events.push(e.path) })
  assert.equal(cfgInvalid.gate_scope, "main")
  assert.deepEqual(events, ["gate_scope"])
})
