import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_AUTONOMY,
  DEFAULT_COMMS,
  DEFAULT_MOOD,
  clearRejectWarnCache,
  parseMissionOverlay,
  readAutonomyConfig,
  readCommsConfig,
  readMissionOverlay,
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
    "  class_overrides: [tool:my-mcp_*:vault-write, subagent:my-agent:subagent-write]",
    "  batch:",
    "    max_actions: 4",
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
  ])
  const cfg = await readAutonomyConfig(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfg.level, 3)
  assert.deepEqual(cfg.heartbeat, { frequency: "6h", in_progress_lock: false })
  assert.equal(cfg.mission_token_budget, "unlimited")
  assert.deepEqual(cfg.root_classes, ["systemctl restart", "pacman -Syu"])
  assert.deepEqual(cfg.class_overrides, ["tool:my-mcp_*:vault-write", "subagent:my-agent:subagent-write"])
  assert.deepEqual(cfg.batch, { max_actions: 4 })
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
  })
})

test("readAutonomyConfig defaults batch and class_overrides; rejects invalid batch.max_actions", async () => {
  const dir = await configDir([
    "autonomy:",
    "  batch:",
    "    max_actions: -3",
    "  class_overrides: [tool:my_*:vault-write]",
  ])
  const rejects: string[] = []
  const cfg = await readAutonomyConfig(dir, { onReject: (e) => rejects.push(e.path) })
  assert.equal(cfg.batch.max_actions, 8) // invalid -> default
  assert.ok(rejects.includes("batch.max_actions"))
  assert.deepEqual(cfg.class_overrides, ["tool:my_*:vault-write"])
})

test("readMoodConfig / readCommsConfig parse their blocks", async () => {
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
  ])
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
  assert.equal(cfg.quiet.backoff, DEFAULT_AUTONOMY.quiet.backoff)
  assert.equal(cfg.heartbeat.frequency, DEFAULT_AUTONOMY.heartbeat.frequency)
  assert.deepEqual(
    events.map((e) => e.path).sort(),
    ["heartbeat.frequency", "level", "mission_token_budget", "quiet.backoff", "quiet.dream_chance", "quiet.window", "typo_key"],
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
  ])
  const events: string[] = []
  const noRejectPath = (e: { path: string }) => events.push(e.path)
  const comms = await readCommsConfig(dir, { onReject: noRejectPath })
  assert.equal(comms.default_channel, DEFAULT_COMMS.default_channel)
  assert.equal(comms.session_ttl, DEFAULT_COMMS.session_ttl)
  assert.equal(comms.email.reply_window_hours, DEFAULT_COMMS.email.reply_window_hours)
  const mood = await readMoodConfig(dir, { onReject: noRejectPath })
  assert.equal(mood.dispatch_influence, DEFAULT_MOOD.dispatch_influence)
  assert.deepEqual(events.sort(), ["default_channel", "dispatch_influence", "email.reply_window_hours", "session_ttl"])
})

test("missing config dir yields the defaults with no rejects", async () => {
  const dir = join(await tmpDir(), "nope")
  const noReject = { onReject: () => assert.fail("unexpected reject") }
  assert.deepEqual(await readAutonomyConfig(dir, noReject), DEFAULT_AUTONOMY)
  assert.deepEqual(await readMoodConfig(dir, noReject), DEFAULT_MOOD)
  assert.deepEqual(await readCommsConfig(dir, noReject), DEFAULT_COMMS)
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
  let raw: string | null = null
  try {
    raw = await readFile(join(PROJECT_ROOT, ".opencode", "sysop-config.yaml"), "utf8")
  } catch {
    raw = null
  }
  const events: string[] = []
  const cfg = await readAutonomyConfig(PROJECT_ROOT, { onReject: (e) => events.push(e.path) })
  assert.deepEqual(events, [], "the live config must parse without rejects")

  if (raw === null) {
    // Repo checkout without a generated sysop-config.yaml: pure defaults.
    assert.equal(cfg.level, DEFAULT_AUTONOMY.level)
  } else {
    // Live instance: the overlay must agree with the file it came from.
    const fileLevel = Number(/^ {2}level: (\d+)/m.exec(raw)?.[1] ?? NaN)
    assert.equal(cfg.level, fileLevel)
    assert.ok(cfg.level >= 0 && cfg.level <= 4)
    assert.ok(cfg.mission_token_budget === "unlimited" || Number.isFinite(cfg.mission_token_budget))
    assert.ok(typeof cfg.heartbeat.frequency === "string" || cfg.heartbeat.frequency === null)
    assert.ok(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(cfg.quiet.window), cfg.quiet.window)

    const comms = await readCommsConfig(PROJECT_ROOT, { onReject: (e) => events.push(e.path) })
    assert.ok(typeof comms.default_channel === "string" && comms.default_channel.length > 0)
  }
  assert.deepEqual(events, [])
})

test("defaults match the plan §11 / §17.11 tables", () => {
  assert.equal(DEFAULT_AUTONOMY.level, 1) // safe code default; live config ships 3
  assert.deepEqual(DEFAULT_AUTONOMY.quiet.window, "23:00-08:00")
  assert.equal(DEFAULT_MOOD.decay_half_life, "6h")
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

// ---------------------------------------------------------------------------
// session_grant — the session-wide approval dial

test("session_grant defaults to off, parses target/class, and fails closed on invalid", async () => {
  // Missing keys -> opt-in defaults (session grants stay off).
  const missing = await configDir(["autonomy:", "  level: 2"])
  const cfgMissing = await readAutonomyConfig(missing, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgMissing.session_grant, "off")
  assert.equal(cfgMissing.session_grant_ttl, 0)
  assert.equal(DEFAULT_AUTONOMY.session_grant, "off")
  assert.equal(DEFAULT_AUTONOMY.session_grant_ttl, 0)

  // Explicit target/class + a TTL parse.
  const target = await configDir(["autonomy:", "  session_grant: target", "  session_grant_ttl: 15"])
  const cfgTarget = await readAutonomyConfig(target, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgTarget.session_grant, "target")
  assert.equal(cfgTarget.session_grant_ttl, 15)

  const klass = await configDir(["autonomy:", "  session_grant: class"])
  const cfgClass = await readAutonomyConfig(klass, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgClass.session_grant, "class")

  // Invalid enum + negative TTL -> reject + defaults (fail-closed to off).
  const invalid = await configDir(["autonomy:", "  session_grant: always", "  session_grant_ttl: -1"])
  const events: string[] = []
  const cfgInvalid = await readAutonomyConfig(invalid, { onReject: (e) => events.push(e.path) })
  assert.equal(cfgInvalid.session_grant, "off")
  assert.equal(cfgInvalid.session_grant_ttl, 0)
  assert.deepEqual(events.sort(), ["session_grant", "session_grant_ttl"])
})

// ---------------------------------------------------------------------------
// enforcement — per-command vs per-task

test("enforcement defaults to per-task, parses per-command, and fails closed on invalid", async () => {
  const missing = await configDir(["autonomy:", "  level: 2"])
  const cfgMissing = await readAutonomyConfig(missing, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgMissing.enforcement, "per-task")
  assert.equal(DEFAULT_AUTONOMY.enforcement, "per-task")

  const command = await configDir(["autonomy:", "  enforcement: per-command"])
  const cfgCommand = await readAutonomyConfig(command, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(cfgCommand.enforcement, "per-command")

  const invalid = await configDir(["autonomy:", "  enforcement: per-objective"])
  const events: string[] = []
  const cfgInvalid = await readAutonomyConfig(invalid, { onReject: (e) => events.push(e.path) })
  assert.equal(cfgInvalid.enforcement, "per-task") // fail-closed to the default
  assert.deepEqual(events, ["enforcement"])
})

// ---------------------------------------------------------------------------
// missions overlay — autonomy.missions.<id>.* (missions-plan §6, card A)

test("readAutonomyConfig skips the two-level missions block without rejects", async () => {
  const dir = await configDir([
    "autonomy:",
    "  level: 3",
    "  missions:",
    "    staleness:",
    "      enabled: false",
    "      min_level: 4",
    "      bogus: hello",
    "    drain:",
    "      frequency: low",
    "  quiet:",
    '    window: "07:00-09:00"',
  ])
  const cfg = await readAutonomyConfig(dir, { onReject: () => assert.fail("missions block must be skipped") })
  assert.equal(cfg.level, 3)
  assert.equal(cfg.quiet.window, "07:00-09:00")
})

test("parseMissionOverlay parses per-id blocks and reports bad lines", () => {
  const yaml = [
    "autonomy:",
    "  level: 3",
    "  missions:",
    "    staleness:",
    "      enabled: false",
    "      min_level: 3          # raise only",
    "      frequency: low",
    "      menus: [day]",
    "    drain:",
    "      enabled: true",
    "    bad:",
    "      level: 99             # not an overlay key",
    "    strung: nope            # not a block",
    "",
  ].join("\n")
  const { overlay, rejects } = parseMissionOverlay(yaml)
  assert.deepEqual(overlay.staleness, { enabled: false, min_level: 3, frequency: "low", menus: ["day"] })
  assert.deepEqual(overlay.drain, { enabled: true })
  assert.deepEqual(overlay.bad, {})
  assert.equal(overlay.strung, undefined)
  assert.deepEqual(
    rejects.map((r) => r.path).sort(),
    ["missions.bad.level", "missions.strung"],
  )
})

test("parseMissionOverlay rejects invalid values but keeps valid ones", () => {
  const yaml = [
    "autonomy:",
    "  missions:",
    "    staleness:",
    "      min_level: 9",
    "      frequency: sometimes",
    "      menus: [weekend]",
    "      enabled: maybe",
    "      min_level_ok: nope    # unknown",
    "",
  ].join("\n")
  const { overlay, rejects } = parseMissionOverlay(yaml)
  assert.deepEqual(overlay.staleness, {})
  assert.deepEqual(
    rejects.map((r) => r.path).sort(),
    [
      "missions.staleness.enabled",
      "missions.staleness.frequency",
      "missions.staleness.menus",
      "missions.staleness.min_level",
      "missions.staleness.min_level_ok",
    ],
  )
})

test("parseMissionOverlay yields an empty overlay when missions is absent", () => {
  assert.deepEqual(parseMissionOverlay("autonomy:\n  level: 3\n").overlay, {})
  assert.deepEqual(parseMissionOverlay("").overlay, {})
})

test("readMissionOverlay hot-reads the overlay from a config dir", async () => {
  const dir = await configDir([
    "autonomy:",
    "  missions:",
    "    staleness:",
    "      enabled: false",
  ])
  const ov = await readMissionOverlay(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.deepEqual(ov, { staleness: { enabled: false } })

  const missing = join(await tmpDir(), "nope")
  assert.deepEqual(await readMissionOverlay(missing), {})
})
