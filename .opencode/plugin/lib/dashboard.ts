// Dashboard backend core (kanban card 8 — autonomy-harness plan §9.2).
//
// The Node/TS backend behind the local web UI. This module holds everything
// that does not need an HTTP socket: schema-validated sysop-config.yaml
// writes (comment-preserving, round-trip-validated through the exact parse
// options the hot readers use), server-side dial-semantics guards, metrics
// reads over the NDJSON ledgers + state files, and the CSRF token store.
//
// Scope of card 8 (auth is card 11): CSRF only — no login/2FA/TLS. Writable
// sections are the four nested Rule-backed ones (autonomy, mood, comms,
// dashboard); every other section is refused `section_readonly` until a UI
// panel needs it and a schema lands with it.
//
// Security posture (plan §9.2 + §14 "Dashboard API becomes security-critical"):
//   - loopback bind only (non-loopback refused while auth is card 11),
//   - all mutations CSRF-token-checked (Host/Origin checks in the server),
//   - server-side dial semantics: level raise needs login+2fa, floor-class
//     key patterns are refused unconditionally, auth.* writes are card 11,
//   - every accepted config write is journaled to <log>/dashboard.log (NDJSON
//     through the shared logging engine) before the write returns.
import { randomBytes } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { SYSCONFIG, parseNestedSection } from "./config.ts"
import {
  isNestedWritableSection,
  nestedSectionOpts,
  parseMissionOverlay,
  readAutonomyConfig,
  readCommsConfig,
  readDashboardConfig,
  readMissionOverlay,
  readMoodConfig,
  type MissionOverlay,
} from "./autonomy.ts"
import { loadMissionStates } from "./missions.ts"
import { atomicWrite } from "./fsx.ts"
import { readMoodState } from "./mood.ts"
import {
  HEARTBEAT_CURRENT_FILE,
  HEARTBEAT_STATE_FILE,
  effectiveFrequencyMs,
  frequencyToMs,
  readHeartbeatConfig,
  readHeartbeatCurrent,
  type HeartbeatCurrent,
} from "./heartbeat.ts"
import { readAll, readBacklogConfig, resolveBacklogFile, type BacklogEntry } from "./backlog.ts"
import { readResolvedPaths } from "./paths.ts"
import { LOG_DEFAULTS, getLogger } from "./logging.ts"

// ---------------------------------------------------------------------------
// Errors — one shape for the server to map onto HTTP

export class DashboardError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: unknown
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message)
    this.name = "DashboardError"
    this.status = status
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// Flattening + YAML scalar rendering

export type Leaf = { path: string; value: unknown }

// Flatten `{ "heartbeat": { "frequency": "12h" } }` (and dotted keys) into
// `[{ path: "heartbeat.frequency", value: "12h" }]`. Arrays and scalars are
// leaves; nested plain objects recurse; null/undefined are refused.
export function flattenValues(values: unknown, prefix = ""): Leaf[] {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new DashboardError(400, "invalid_values", "values must be an object", { path: prefix || "(root)" })
  }
  const out: Leaf[] = []
  const keyOk = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(k)
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!keyOk(key)) {
      throw new DashboardError(400, "invalid_values", `invalid key: ${key}`)
    }
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenValues(value, path))
    } else if (value === undefined || value === null) {
      throw new DashboardError(400, "invalid_values", `null value: ${path}`)
    } else {
      out.push({ path, value })
    }
  }
  return out
}

const WORDLIKE_RE = /^[A-Za-z0-9_./:@+\-]+$/

// Render a JSON scalar/array as the raw YAML scalar that parses back to the
// same value (the round-trip check enforces it). Refuses anything else.
export function renderYamlScalar(value: unknown, path = ""): string {
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DashboardError(400, "invalid_value", `not finite: ${path}`)
    return String(value)
  }
  if (typeof value === "string") {
    if (value === "") return '""'
    if (WORDLIKE_RE.test(value) && !value.includes("#")) return value
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => {
      if (typeof v === "string" && WORDLIKE_RE.test(v)) return v
      if (typeof v === "string") return JSON.stringify(v)
      throw new DashboardError(400, "invalid_value", `list members must be strings: ${path}`)
    })
    return `[${items.join(", ")}]`
  }
  throw new DashboardError(400, "invalid_value", `unsupported value type: ${path}`)
}

// ---------------------------------------------------------------------------
// Comment-preserving line surgery on sysop-config.yaml

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

// `key:` opener for `key` at exactly `indent`, value empty (block opener) or
// a scalar line — both match; callers narrow via what they expect.
function keyLineRe(key: string): RegExp {
  return new RegExp(`^${key}:[ \\t]*(#.*)?$`)
}

// Splice `edits` (path -> rendered raw scalar) into the section's lines.
// Every edit re-derives the section bounds on the current array, so inserts
// shift later lookups safely. Comments and formatting outside the touched
// lines are preserved byte-for-byte. Throws DashboardError(400).
export function applySectionEdits(text: string, section: string, edits: Record<string, string>): string {
  const lines = text.split("\n")
  const sectionRe = new RegExp(`^${section}:[ \\t]*(?:#.*)?$`)

  let start = lines.findIndex((l) => sectionRe.test(l))
  if (start === -1) {
    // Section absent — append a fresh block at EOF (rare; the shipped config
    // has all four writable sections).
    lines.push(`${section}:`)
    start = lines.length - 1
  }

  const sectionEnd = (): number => {
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]
      if (l.trim() === "" || l.trimStart().startsWith("#")) continue
      if (indentOf(l) === 0 && /^[A-Za-z_][A-Za-z0-9_]*[ \t]*:/.test(l)) return i
    }
    return lines.length
  }

  const end = sectionEnd()
  let blockStart = start + 1
  let blockEnd = end
  let childIndent = indentOf(lines[start]) + 2

  for (const [path, raw] of Object.entries(edits)) {
    const segments = path.split(".")
    let bs = blockStart
    let be = blockEnd
    let ci = childIndent

    // Walk/create parent block openers.
    for (let d = 0; d < segments.length - 1; d++) {
      const key = segments[d]
      let opener = -1
      for (let i = bs; i < be; i++) {
        if (indentOf(lines[i]) === ci && keyLineRe(key).test(lines[i].trim())) {
          opener = i
          break
        }
      }
      if (opener === -1) {
        // First line at a shallower indent terminates the current block.
        let insertAt = be
        for (let i = bs; i < be; i++) {
          if (lines[i].trim() !== "" && indentOf(lines[i]) < ci) {
            insertAt = i
            break
          }
        }
        lines.splice(insertAt, 0, " ".repeat(ci) + key + ":")
        bs = insertAt + 1
        be = insertAt + 1
        ci += 2
        continue
      }
      bs = opener + 1
      // Body: lines indented deeper than the opener (blank/comment lines at
      // shallower indent terminate it — they belong to the outer block).
      let bodyEnd = lines.length
      for (let i = bs; i < lines.length; i++) {
        if (lines[i].trim() === "") continue
        if (indentOf(lines[i]) <= ci) {
          bodyEnd = i
          break
        }
      }
      be = bodyEnd
      // Child indent: the first real line's indent, else opener indent + 2.
      let real = -1
      for (let i = bs; i < be; i++) {
        if (lines[i].trim() !== "" && !lines[i].trimStart().startsWith("#")) {
          real = i
          break
        }
      }
      ci = real === -1 ? ci + 2 : indentOf(lines[real])
    }

    const key = segments[segments.length - 1]
    const scalarRe = new RegExp(`^${key}:[ \\t]*`)
    let target = -1
    for (let i = bs; i < be; i++) {
      if (indentOf(lines[i]) === ci && scalarRe.test(lines[i].trimStart())) {
        target = i
        break
      }
    }
    if (target === -1) {
      // Insert at the end of the block (before the terminator line).
      lines.splice(be, 0, " ".repeat(ci) + key + ": " + raw)
    } else {
      const line = lines[target]
      const rest = line.slice(indentOf(line) + key.length + 1) // after `key:`
      const commentMatch = rest.match(/(\s+#.*)$/)
      const comment = commentMatch ? commentMatch[1] : ""
      lines[target] = " ".repeat(ci) + key + ": " + raw + comment
    }
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Round-trip validation — the file we write must parse back to what was asked

type RoundTripProblem = { path?: string; reason: string; expected?: unknown; actual?: unknown }

function getSectionValue(parsed: { scalars: Record<string, unknown>; blocks: Record<string, Record<string, unknown>> }, path: string): unknown {
  const dot = path.indexOf(".")
  if (dot === -1) return parsed.scalars[path]
  return parsed.blocks[path.slice(0, dot)]?.[path.slice(dot + 1)]
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Parse `text` with the section's real options; fail only on rejects that
// touch a requested path (pre-existing file rejects are not this write's
// problem) or on any requested path that does not parse back equal.
export function validateRoundTrip(text: string, section: string, requested: Record<string, unknown>): RoundTripProblem[] {
  const opts = nestedSectionOpts(section)
  if (!opts) return [{ reason: `no schema for section: ${section}` }]
  const parsed = parseNestedSection(text, section, opts)
  const problems: RoundTripProblem[] = []
  for (const r of parsed.rejects) {
    if (r.path in requested) problems.push({ path: r.path, reason: r.reason, expected: requested[r.path] })
  }
  for (const [path, expected] of Object.entries(requested)) {
    const actual = getSectionValue(parsed, path)
    if (!same(actual, expected)) {
      problems.push({ path, reason: "value did not round-trip", expected, actual })
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Server-side dial semantics (plan §9.2; Phase-4 subset)

export type GuardContext = {
  /** Current effective `autonomy.level`. */
  autonomyLevel: number
  /** Current `dashboard.auth.mode`. */
  authMode: string
}

export function isLoopback(bind: string): boolean {
  return bind === "localhost" || bind === "::1" || bind === "[::1]" || /^127\./.test(bind)
}

// Refusals are `{ status, code, message }`; null = allowed. The irreversibility
// floor itself is hard-coded in autonomy-gate.ts — no config key can disable
// it — so this guard refuses floor-class key patterns outright (future-proof)
// plus the Phase-4 rules below.
export function guardLeaf(section: string, leaf: Leaf, ctx: GuardContext): { status: number; code: string; message: string } | null {
  if (/(^|[._-])(floor|irreversib)/i.test(leaf.path)) {
    return { status: 403, code: "floor", message: `the irreversibility floor is not configurable: ${leaf.path}` }
  }
  if (section === "autonomy" && leaf.path === "level") {
    if (typeof leaf.value === "number" && leaf.value > ctx.autonomyLevel && ctx.authMode !== "login+2fa") {
      return {
        status: 403,
        code: "2fa_required",
        message: `raising autonomy.level above ${ctx.autonomyLevel} requires dashboard auth mode login+2fa (§9.2; login/2FA is card 11)`,
      }
    }
  }
  if (section === "dashboard" && (leaf.path === "auth" || leaf.path.startsWith("auth."))) {
    return { status: 403, code: "auth_card_11", message: "dashboard.auth.* is owned by card 11 (login/2FA/TLS)" }
  }
  if (section === "dashboard" && leaf.path === "bind_address") {
    if (typeof leaf.value !== "string" || !isLoopback(leaf.value)) {
      return {
        status: 403,
        code: "bind_requires_auth",
        message: "non-loopback bind_address requires auth + TLS (§10) — auth is card 11; loopback only",
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The write path

export type WriteConfigOpts = {
  /** Origin/IP of the caller — journaled, never trusted for the decision. */
  origin?: string
  ip?: string
}

export type WriteConfigResult = {
  section: string
  applied: Record<string, unknown>
}

// Schema-validated, guarded, comment-preserving write of one section. All or
// nothing: any guard refusal or round-trip problem leaves the file untouched.
export async function writeConfig(
  directory: string,
  section: string,
  values: unknown,
  opts: WriteConfigOpts = {},
): Promise<WriteConfigResult> {
  if (!isNestedWritableSection(section)) {
    throw new DashboardError(403, "section_readonly", `section not writable via the dashboard: ${section}`)
  }
  const leaves = flattenValues(values)
  if (leaves.length === 0) {
    throw new DashboardError(400, "invalid_values", "no values supplied")
  }

  const [autonomy, dashboard] = await Promise.all([readAutonomyConfig(directory), readDashboardConfig(directory)])
  const ctx: GuardContext = { autonomyLevel: autonomy.level, authMode: dashboard.auth.mode }
  for (const leaf of leaves) {
    const refusal = guardLeaf(section, leaf, ctx)
    if (refusal) throw new DashboardError(refusal.status, refusal.code, refusal.message, { path: leaf.path })
  }

  const edits: Record<string, string> = {}
  const requested: Record<string, unknown> = {}
  for (const leaf of leaves) {
    edits[leaf.path] = renderYamlScalar(leaf.value, leaf.path)
    requested[leaf.path] = leaf.value
  }

  const file = join(directory, SYSCONFIG)
  const prev = await readFile(file, "utf8")
  const next = applySectionEdits(prev, section, edits)
  const problems = validateRoundTrip(next, section, requested)
  if (problems.length > 0) {
    throw new DashboardError(400, "invalid_value", "config value failed schema validation", problems)
  }

  await atomicWrite(file, next)
  await logDashboardEvent(directory, "config-write", {
    section,
    paths: Object.keys(requested),
    origin: opts.origin ?? null,
    ip: opts.ip ?? null,
  })

  const applied: Record<string, unknown> = {}
  for (const leaf of leaves) applied[leaf.path] = leaf.value
  return { section, applied }
}

// Journal every accepted write to <log>/dashboard.log (NDJSON, shared logging
// engine). Best-effort: a log failure must not fail the write (the write is
// already validated; hooks read the config live).
export async function logDashboardEvent(directory: string, event: string, fields: Record<string, unknown>): Promise<void> {
  try {
    const { logDir } = await readResolvedPaths(directory)
    const logger = getLogger({ ...LOG_DEFAULTS, file: "dashboard.log" }, { logDir, channel: "dashboard", hook: "dashboard" })
    await logger.append({ ts: new Date().toISOString(), event, ...fields })
    await logger.flush()
  } catch {
    // never break the caller
  }
}

// ---------------------------------------------------------------------------
// Reads — config snapshot, metrics, ledgers

export type ConfigSnapshot = {
  autonomy: Awaited<ReturnType<typeof readAutonomyConfig>>
  heartbeat: Awaited<ReturnType<typeof readHeartbeatConfig>>
  mood: Awaited<ReturnType<typeof readMoodConfig>>
  comms: Awaited<ReturnType<typeof readCommsConfig>>
  dashboard: Awaited<ReturnType<typeof readDashboardConfig>>
}

export async function configSnapshot(directory: string): Promise<ConfigSnapshot> {
  const [autonomy, heartbeat, mood, comms, dashboard] = await Promise.all([
    readAutonomyConfig(directory),
    readHeartbeatConfig(directory),
    readMoodConfig(directory),
    readCommsConfig(directory),
    readDashboardConfig(directory),
  ])
  return { autonomy, heartbeat, mood, comms, dashboard }
}

export type LedgerInfo = { name: string; bytes: number; lines: number }

const LEDGER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isLedgerName(name: string): boolean {
  return LEDGER_NAME_RE.test(name) && !name.includes("..") && (name.endsWith(".log") || name.endsWith(".ndjson"))
}

export async function listLedgers(logDir: string): Promise<LedgerInfo[]> {
  let names: string[]
  try {
    names = (await readdir(logDir)).filter((n) => isLedgerName(n)).sort()
  } catch {
    return []
  }
  const out: LedgerInfo[] = []
  for (const name of names) {
    try {
      const file = join(logDir, name)
      const info = await stat(file)
      if (!info.isFile()) continue
      const body = await readFile(file, "utf8")
      const lines = body === "" ? 0 : body.endsWith("\n") ? body.split("\n").length - 1 : body.split("\n").length
      out.push({ name, bytes: info.size, lines })
    } catch {
      // raced with rotation — skip
    }
  }
  return out
}

// Tail a whitelisted ledger: last `limit` lines, JSON-parsed where possible.
// The name is checked against LEDGER_NAME_RE (no separators, .log/.ndjson
// only) so `..`/`/` traversal is impossible.
export async function tailLedger(logDir: string, name: string, limit: number): Promise<Array<Record<string, unknown>>> {
  if (!isLedgerName(name)) throw new DashboardError(400, "bad_ledger", `not a ledger name: ${name}`)
  const capped = Math.max(1, Math.min(limit, 1000))
  let body = ""
  try {
    body = await readFile(join(logDir, name), "utf8")
  } catch {
    throw new DashboardError(404, "no_ledger", `no such ledger: ${name}`)
  }
  const all = body === "" ? [] : body.split("\n")
  if (all[all.length - 1] === "") all.pop()
  const tail = all.slice(-capped)
  return tail.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return { raw: line }
    }
  })
}

export type MetricsSnapshot = {
  ts: string
  config: ConfigSnapshot
  mood: (Record<string, unknown> & { file: string }) | null
  backlog: { total: number; by_status: Record<string, number> } | null
  ledgers: LedgerInfo[]
  heartbeat: { lock: boolean; lock_stale: boolean }
}

export async function metricsSnapshot(directory: string): Promise<MetricsSnapshot> {
  const config = await configSnapshot(directory)
  const { stateDir, logDir } = await readResolvedPaths(directory)

  let mood: MetricsSnapshot["mood"] = null
  try {
    const moodFile = join(stateDir, "mood.json")
    mood = { ...(await readMoodState(moodFile)), file: moodFile }
  } catch {
    // no mood state yet
  }

  let backlog: MetricsSnapshot["backlog"] = null
  try {
    const bcfg = await readBacklogConfig(directory)
    const file = resolveBacklogFile(stateDir, bcfg)
    const entries = await readAll(file)
    const by_status: Record<string, number> = {}
    for (const e of entries as BacklogEntry[]) by_status[e.status] = (by_status[e.status] ?? 0) + 1
    backlog = { total: entries.length, by_status }
  } catch {
    // no backlog yet
  }

  let heartbeat = { lock: false, lock_stale: false }
  try {
    const info = await stat(join(stateDir, "heartbeat.lock"))
    heartbeat = { lock: true, lock_stale: Date.now() - info.mtimeMs > 30 * 60_000 }
  } catch {
    // no lock
  }

  return {
    ts: new Date().toISOString(),
    config,
    mood,
    backlog,
    ledgers: await listLedgers(logDir),
    heartbeat,
  }
}

// Live heartbeat status (card 16 §9.2): the on-flight marker + the lock. The
// dashboard's "flight" widget polls this; history comes from the heartbeat.log
// ledger and the backlog snapshot.
/** Next-tick projection — the hook's own cadence math, read from disk.
 *  `interval_ms` includes the B7 noop backoff (×2 at streak 2, ×4 at 3+). */
export type HeartbeatSchedule = {
  /** heartbeat.enabled kill switch. */
  enabled: boolean
  level: number
  /** Raw `autonomy.heartbeat.frequency` dial. */
  frequency: string
  /** frequencyToMs(frequency) — before backoff; null = off/malformed. */
  base_interval_ms: number | null
  /** Effective cadence: base × noop backoff; null = off. */
  interval_ms: number | null
  noop_streak: number
  /** Last completed tick (ISO), null before the first tick. */
  last_tick: string | null
  /** Projected next tick (ISO); null when off, paused, or first-run due. */
  next_tick: string | null
  /** Milliseconds until next_tick, clamped at 0; null when none scheduled. */
  remaining_ms: number | null
  /** A tick is due now (first run, or the projected time has passed). */
  due: boolean
  /** level 0 or heartbeat.enabled: false — the scheduler sleeps. */
  paused: boolean
  /** frequency off/malformed — the scheduler sleeps. */
  off: boolean
}

export type HeartbeatSnapshot = {
  ts: string
  /** heartbeat.current.json — null when the tick has never run or is idle. */
  current: HeartbeatCurrent | null
  /** heartbeat.lock present (a mission may be in flight). */
  lock: boolean
  /** Lock held longer than the 30-min stale window (presumed dead tick). */
  lock_stale: boolean
  schedule: HeartbeatSchedule
}

type HeartbeatStateFile = { last_tick?: number; ticks?: number; noop_streak?: number }

export async function heartbeatSchedule(
  directory: string,
  nowMs: number = Date.now(),
): Promise<HeartbeatSchedule> {
  const { stateDir } = await readResolvedPaths(directory)
  const [autonomy, hbCfg] = await Promise.all([readAutonomyConfig(directory), readHeartbeatConfig(directory)])
  let state: HeartbeatStateFile = {}
  try {
    state = JSON.parse(await readFile(join(stateDir, HEARTBEAT_STATE_FILE), "utf8")) as HeartbeatStateFile
  } catch {
    // never ticked / unreadable — treated as first run
  }
  const frequency = autonomy.heartbeat.frequency
  const level = autonomy.level
  const noopStreak = Number.isFinite(state.noop_streak) ? Math.max(0, Number(state.noop_streak)) : 0
  const lastTickMs = Number.isFinite(state.last_tick) && Number(state.last_tick) > 0 ? Number(state.last_tick) : null
  const baseMs = frequencyToMs(frequency)
  const intervalMs = effectiveFrequencyMs(baseMs, noopStreak)
  const paused = !hbCfg.enabled || level <= 0
  const off = intervalMs === null
  const active = !paused && !off
  const nextMs = active && lastTickMs !== null && intervalMs !== null ? lastTickMs + intervalMs : null
  const remainingMs = nextMs === null ? null : Math.max(0, nextMs - nowMs)
  return {
    enabled: hbCfg.enabled,
    level,
    frequency,
    base_interval_ms: baseMs,
    interval_ms: intervalMs,
    noop_streak: noopStreak,
    last_tick: lastTickMs === null ? null : new Date(lastTickMs).toISOString(),
    next_tick: nextMs === null ? null : new Date(nextMs).toISOString(),
    remaining_ms: remainingMs,
    due: active && (nextMs === null || remainingMs === 0),
    paused,
    off,
  }
}

export async function heartbeatSnapshot(directory: string): Promise<HeartbeatSnapshot> {
  const { stateDir } = await readResolvedPaths(directory)
  let current: HeartbeatCurrent | null = null
  try {
    current = await readHeartbeatCurrent(join(stateDir, HEARTBEAT_CURRENT_FILE))
  } catch {
    // no marker yet
  }
  let lock = false
  let lock_stale = false
  try {
    const info = await stat(join(stateDir, "heartbeat.lock"))
    lock = true
    lock_stale = Date.now() - info.mtimeMs > 30 * 60_000
  } catch {
    // no lock
  }
  return { ts: new Date().toISOString(), current, lock, lock_stale, schedule: await heartbeatSchedule(directory) }
}

export type BacklogSnapshot = { total: number; entries: BacklogEntry[] }

/** Read-only backlog view — the plugin remains the single writer (§14). */
export async function backlogSnapshot(directory: string): Promise<BacklogSnapshot> {
  try {
    const { stateDir } = await readResolvedPaths(directory)
    const bcfg = await readBacklogConfig(directory)
    const file = resolveBacklogFile(stateDir, bcfg)
    const entries = await readAll(file)
    return { total: entries.length, entries }
  } catch {
    return { total: 0, entries: [] }
  }
}

// ---------------------------------------------------------------------------
// Missions (read + enable/disable toggle)
//
// The filesystem is the mission list (`.opencode/missions/*.md`); the
// restrict-only overlay `autonomy.missions.<id>.*` can disable a mission but
// never re-enable one the file itself disables (missions-plan §6 / D-M5). The
// widget therefore lists the effective missions plus each file's own
// `enabled`, and its toggle either writes `enabled: false` into the overlay or
// removes that key again — the generic config writer cannot be used here
// (hyphenated ids, and the overlay is skipped by the autonomy schema).

export type MissionView = {
  id: string
  title: string
  frequency: string
  menus: string[]
  min_level: number
  approval: string
  candidacy: string
  agent: string
  /** Effective value after the overlay. */
  enabled: boolean
  /** The mission file's own `enabled` — false means the overlay cannot turn it on. */
  file_enabled: boolean
  /** The overlay block for this mission, if any. */
  overlay: MissionOverlay | null
}

export type MissionsSnapshot = { missions: MissionView[] }

export async function missionsSnapshot(directory: string): Promise<MissionsSnapshot> {
  const states = await loadMissionStates(directory)
  let overlay: Record<string, MissionOverlay> = {}
  try {
    overlay = await readMissionOverlay(directory)
  } catch {
    overlay = {}
  }
  return {
    missions: states.map((m) => ({
      id: m.id,
      title: m.title,
      frequency: m.frequency,
      menus: m.menus,
      min_level: m.min_level,
      approval: m.approval,
      candidacy: m.candidacy,
      agent: m.agent,
      enabled: m.enabled,
      file_enabled: m.file_enabled,
      overlay: overlay[m.id] ?? null,
    })),
  }
}

const MISSION_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function indentWidth(line: string): number {
  return line.length - line.trimStart().length
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim()
  return t === "" || t.startsWith("#")
}

// The readers slice a section's body with the same contiguous-indent rule as
// `extractBlock` (lib/config.ts): only the run of indented lines immediately
// after `autonomy:` — a blank line ends it. The overlay toggle must therefore
// insert *inside* that run, not before the next top-level key (which a blank
// line usually separates), or `parseMissionOverlay` would never see it.
function autonomyBodyRange(lines: string[]): { bodyStart: number; bodyEnd: number } | null {
  const opener = lines.findIndex((l) => /^autonomy:[ \t]*(#.*)?$/.test(l))
  if (opener === -1) return null
  const bodyStart = opener + 1
  let bodyEnd = bodyStart
  while (bodyEnd < lines.length && /^[ \t]/.test(lines[bodyEnd])) bodyEnd++
  return { bodyStart, bodyEnd }
}

function firstChildIndent(lines: string[], from: number, to: number): number {
  for (let i = from; i < to; i++) {
    if (isBlankOrComment(lines[i])) continue
    return indentWidth(lines[i])
  }
  return -1
}

function findOpener(lines: string[], from: number, to: number, indent: number, re: RegExp): number {
  for (let i = from; i < to; i++) {
    if (isBlankOrComment(lines[i])) continue
    if (indentWidth(lines[i]) === indent && re.test(lines[i].trim())) return i
  }
  return -1
}

// End of a block opened at `opener`, bounded by `limit`: the first deeper-or-
// equal-indent line (blank/comment lines stay inside).
function childBlockEnd(lines: string[], opener: number, limit: number): number {
  const base = indentWidth(lines[opener])
  for (let i = opener + 1; i < limit; i++) {
    if (isBlankOrComment(lines[i])) continue
    if (indentWidth(lines[i]) <= base) return i
  }
  return limit
}

/**
 * Upsert/remove the overlay key `autonomy.missions.<id>.enabled` on raw YAML
 * text. Disabling writes `enabled: false` (creating the missions/id block path
 * as needed); enabling removes the key and cleans up now-empty blocks. The
 * caller re-parses the result with `parseMissionOverlay` and refuses on any
 * mismatch, so an imperfect edit never lands.
 */
function editMissionOverlayEnabled(text: string, id: string, enabled: boolean): string {
  const lines = text.split("\n")
  const range = autonomyBodyRange(lines)
  if (!range) return text
  const { bodyStart, bodyEnd } = range
  const childIndent = firstChildIndent(lines, bodyStart, bodyEnd)
  if (childIndent === -1) return text

  const missionsRe = /^missions[ \t]*:[ \t]*(#.*)?$/
  const missionsOpener = findOpener(lines, bodyStart, bodyEnd, childIndent, missionsRe)

  if (missionsOpener === -1) {
    if (enabled) return text // already enabled — nothing to remove
    lines.splice(
      bodyEnd,
      0,
      " ".repeat(childIndent) + "missions:",
      " ".repeat(childIndent + 2) + `${id}:`,
      " ".repeat(childIndent + 4) + "enabled: false",
    )
    return lines.join("\n")
  }

  const missionsEnd = childBlockEnd(lines, missionsOpener, bodyEnd)
  const missionsChild = firstChildIndent(lines, missionsOpener + 1, missionsEnd)
  if (missionsChild === -1) {
    if (enabled) return text
    lines.splice(
      missionsOpener + 1,
      0,
      " ".repeat(childIndent + 2) + `${id}:`,
      " ".repeat(childIndent + 4) + "enabled: false",
    )
    return lines.join("\n")
  }

  const idOpener = findOpener(lines, missionsOpener + 1, missionsEnd, missionsChild, new RegExp(`^${escapeRe(id)}[ \\t]*:[ \\t]*(#.*)?$`))
  if (idOpener === -1) {
    if (enabled) return text
    lines.splice(
      missionsEnd,
      0,
      " ".repeat(missionsChild) + `${id}:`,
      " ".repeat(missionsChild + 2) + "enabled: false",
    )
    return lines.join("\n")
  }

  const idEnd = childBlockEnd(lines, idOpener, missionsEnd)
  const idChild = firstChildIndent(lines, idOpener + 1, idEnd)
  let enabledIdx = -1
  if (idChild !== -1) {
    enabledIdx = findOpener(lines, idOpener + 1, idEnd, idChild, /^enabled[ \t]*:[ \t]*/)
  }

  if (!enabled) {
    if (enabledIdx === -1) {
      const indent = idChild === -1 ? missionsChild + 2 : idChild
      lines.splice(idEnd, 0, " ".repeat(indent) + "enabled: false")
    } else {
      const ind = indentWidth(lines[enabledIdx])
      const comment = lines[enabledIdx].slice(ind).match(/(\s+#.*)$/)?.[1] ?? ""
      lines[enabledIdx] = " ".repeat(ind) + "enabled: false" + comment
    }
    return lines.join("\n")
  }

  if (enabledIdx === -1) return text // already enabled

  const out = lines.slice()
  out.splice(enabledIdx, 1)
  const newIdEnd = idEnd - 1
  const idRemaining = out.slice(idOpener + 1, newIdEnd)
  if (idRemaining.every(isBlankOrComment)) {
    out.splice(idOpener, newIdEnd - idOpener)
    const newMissionsEnd = missionsEnd - (newIdEnd - idOpener)
    const missionsRemaining = out.slice(missionsOpener + 1, newMissionsEnd)
    if (missionsRemaining.every(isBlankOrComment)) out.splice(missionsOpener, newMissionsEnd - missionsOpener)
  }
  return out.join("\n")
}

export type MissionToggleResult = { id: string; enabled: boolean }

/**
 * Enable or disable a mission through the restrict-only overlay. Disabling
 * writes `autonomy.missions.<id>.enabled: false` (creating the block if
 * needed); enabling removes that key. Refuses an unknown mission (404) or an
 * enable of a mission the file itself disables (409). All or nothing: the
 * candidate text is re-parsed with parseMissionOverlay and the write is
 * refused if it does not round-trip.
 */
export async function setMissionEnabled(
  directory: string,
  id: unknown,
  enabled: unknown,
  opts: WriteConfigOpts = {},
): Promise<MissionToggleResult> {
  if (typeof id !== "string" || !MISSION_ID_RE.test(id)) {
    throw new DashboardError(400, "invalid_id", "mission id must match [A-Za-z_][A-Za-z0-9_-]*")
  }
  if (typeof enabled !== "boolean") {
    throw new DashboardError(400, "invalid_value", "enabled must be a boolean")
  }

  const target = (await loadMissionStates(directory)).find((m) => m.id === id)
  if (!target) throw new DashboardError(404, "no_mission", `no such mission: ${id}`)
  if (enabled && !target.file_enabled) {
    throw new DashboardError(
      409,
      "mission_file_disabled",
      `${id} is disabled by its mission file; the overlay cannot re-enable it`,
    )
  }

  const file = join(directory, SYSCONFIG)
  const prev = await readFile(file, "utf8")
  const next = editMissionOverlayEnabled(prev, id, enabled)

  const { overlay, rejects } = parseMissionOverlay(next)
  const scoped = rejects.filter((r) => r.path === `missions.${id}` || r.path.startsWith(`missions.${id}.`))
  if (scoped.length > 0) {
    throw new DashboardError(400, "invalid_value", "mission overlay failed validation", scoped)
  }
  const overlayDisabled = overlay[id]?.enabled === false
  if (overlayDisabled !== !enabled) {
    throw new DashboardError(400, "invalid_value", "mission toggle did not round-trip", { id, enabled })
  }

  if (next !== prev) await atomicWrite(file, next)
  await logDashboardEvent(directory, "mission-toggle", {
    id,
    enabled,
    origin: opts.origin ?? null,
    ip: opts.ip ?? null,
  })
  return { id, enabled }
}

// ---------------------------------------------------------------------------
// CSRF token store (auth is card 11 — this is the whole mutation gate today)

export type CsrfIssue = { token: string; cookie: string }
export type CsrfStore = {
  issue(): CsrfIssue
  verify(token: string | null | undefined): boolean
  size(): number
}

export function createCsrfStore(opts: { ttlMs?: number; now?: () => number } = {}): CsrfStore {
  const ttl = opts.ttlMs ?? 30 * 60_000
  const now = opts.now ?? Date.now
  const tokens = new Map<string, number>()
  const sweep = () => {
    const t = now()
    for (const [k, exp] of tokens) if (exp <= t) tokens.delete(k)
  }
  return {
    issue(): CsrfIssue {
      sweep()
      const token = randomBytes(32).toString("hex")
      tokens.set(token, now() + ttl)
      return {
        token,
        cookie: `nibble_csrf=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}`,
      }
    },
    verify(token: string | null | undefined): boolean {
      if (!token) return false
      sweep()
      const exp = tokens.get(token)
      return exp !== undefined && exp > now()
    },
    size(): number {
      return tokens.size
    },
  }
}
