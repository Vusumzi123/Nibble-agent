// Dashboard backend core (kanban card 8 — autonomy-harness plan §9.2).
//
// The Node/TS backend behind the local web UI. This module holds everything
// that does not need an HTTP socket: schema-validated sysop-config.yaml
// writes (comment-preserving, round-trip-validated through the exact parse
// options the hot readers use), server-side dial-semantics guards, metrics
// reads over the NDJSON ledgers + state files, and the CSRF token store.
//
// Scope of card 8 (auth is card 11): CSRF only — no login/2FA/TLS. Writable
// sections are the Rule-backed ones (autonomy, mood, comms, dashboard,
// heartbeat, drain); every other section is refused `section_readonly` until
// a UI panel needs it and a schema lands with it.
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
  type HeartbeatConfig,
  type HeartbeatCurrent,
} from "./heartbeat.ts"
import { readAll, readBacklogConfig, resolveBacklogFile, type BacklogEntry } from "./backlog.ts"
import { readResolvedPaths } from "./paths.ts"
import { OWNERSHIP_FILE, OWNERSHIP_TTL_MS } from "./ownership.ts"
import { LOG_DEFAULTS, getLogger } from "./logging.ts"
import { readDrainConfig } from "./drain/config.ts"
import { DRAIN_CURRENT_FILE } from "./drain/consumer.ts"
import { loadCursor, resolveCursorFile } from "./drain/cursor.ts"
import { countUnconsumed } from "./drain/db.ts"
import { DRAIN_LEDGER_FILE } from "./drain/ledger.ts"
import { readMemoryConfig } from "./memory/config.ts"
import type { MemoryProfile } from "./memory/types.ts"

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
  // The proxy target receives every session transcript; a non-loopback
  // serve_url would ship them off-box with no auth to gate it (card 11).
  if (section === "dashboard" && leaf.path === "serve_url") {
    // "" = automatic (live pointer / discovery); anything else must be loopback.
    let loopback = typeof leaf.value === "string" && leaf.value.trim() === ""
    if (!loopback && typeof leaf.value === "string") {
      try {
        loopback = isLoopback(new URL(leaf.value).hostname)
      } catch {
        loopback = false
      }
    }
    if (!loopback) {
      return {
        status: 403,
        code: "serve_requires_loopback",
        message: "dashboard.serve_url must be a loopback http(s) URL — the proxy streams session transcripts to it",
      }
    }
  }
  return null
}

// Cross-field guard for the mission dials. The reader lifts
// mission_lock_stale_ms to at least 3 × mission_lock_refresh_ms, so a write with
// stale ≤ refresh would either be silently rewritten or, worse, let a live
// holder's lock be stolen. The stall watchdog and the hard ceiling are the only
// two stop triggers, so switching both off would let a wedged child run forever.
// Refuse both up front (the per-leaf min:0 rules cannot see the pairs).
export function heartbeatConfigProblems(
  current: Pick<
    HeartbeatConfig,
    | "mission_lock_stale_ms"
    | "mission_lock_refresh_ms"
    | "mission_stall_minutes"
    | "mission_timeout_minutes"
  >,
  requested: Record<string, unknown>,
): RoundTripProblem[] {
  const num = (path: string, fallback: number): number => {
    const value = requested[path]
    return typeof value === "number" ? value : fallback
  }
  const refresh = num("mission_lock_refresh_ms", current.mission_lock_refresh_ms)
  const stale = num("mission_lock_stale_ms", current.mission_lock_stale_ms)
  const stall = num("mission_stall_minutes", current.mission_stall_minutes)
  const ceiling = num("mission_timeout_minutes", current.mission_timeout_minutes)
  const problems: RoundTripProblem[] = []
  if (stale <= refresh) {
    problems.push({
      path: "mission_lock_stale_ms",
      reason: `must be greater than mission_lock_refresh_ms (${refresh}ms)`,
      expected: `> ${refresh}`,
      actual: stale,
    })
  }
  if (stall <= 0 && ceiling <= 0) {
    problems.push({
      path: "mission_stall_minutes",
      reason: "the stall watchdog and the hard ceiling cannot both be off — a wedged child would never stop",
      expected: "> 0 while mission_timeout_minutes is 0",
      actual: stall,
    })
  }
  return problems
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

  if (section === "heartbeat") {
    const problems = heartbeatConfigProblems(await readHeartbeatConfig(directory), requested)
    if (problems.length > 0) {
      throw new DashboardError(400, "invalid_value", "mission-lock settings failed cross-field validation", problems)
    }
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
  drain: Awaited<ReturnType<typeof readDrainConfig>>
}

export async function configSnapshot(directory: string): Promise<ConfigSnapshot> {
  const [autonomy, heartbeat, mood, comms, dashboard, drain] = await Promise.all([
    readAutonomyConfig(directory),
    readHeartbeatConfig(directory),
    readMoodConfig(directory),
    readCommsConfig(directory),
    readDashboardConfig(directory),
    readDrainConfig(directory),
  ])
  return { autonomy, heartbeat, mood, comms, dashboard, drain }
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
    const info = await stat(join(stateDir, OWNERSHIP_FILE))
    heartbeat = { lock: true, lock_stale: Date.now() - info.mtimeMs > OWNERSHIP_TTL_MS }
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
  /** The ownership lease is present (a mission may be in flight). */
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
    const info = await stat(join(stateDir, OWNERSHIP_FILE))
    lock = true
    lock_stale = Date.now() - info.mtimeMs > OWNERSHIP_TTL_MS
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
// Memory consolidation backlog (dashboard indicator)
//
// "Pending" is not a stored queue: it is the drain's unconsumed-turn count —
// eligible text parts newer than the cursor (drain/db.ts). The read is
// read-only and independent of drain.enabled, so a paused lane can still show
// the backlog it is accumulating.

export type MemoryPendingSnapshot = {
  ts: string
  /** drain.enabled — false means the pipe will not run. */
  enabled: boolean
  provider: MemoryProfile
  /** The active provider has a consolidation writer. */
  writer: boolean
  /** !enabled or no writer: the backlog will not drain on its own. */
  paused: boolean
  pending_turns: number | null
  /** Effective lower bound: the cursor, or the initial lookback when seeded. */
  cursor_last_ts: number | null
  cursor_updated_at: string | null
  /** True when the cursor was missing and the lookback window was applied. */
  seeded: boolean
  /** Consumer-loop dials (plan §6.1): trigger and next scheduled wake. */
  consumer: boolean
  trigger_pending: number
  trigger_max_age_hours: number
  next_due: number | null
  oldest_pending_age_ms: number | null
  available: boolean
  error?: string
}

const MEMORY_PENDING_TTL_MS = 5_000
const memoryPendingCache = new Map<string, { at: number; value: MemoryPendingSnapshot }>()
const memoryPendingInflight = new Map<string, Promise<MemoryPendingSnapshot>>()

/** Test seam: drop the per-directory cache. */
export function resetMemoryPendingCache(): void {
  memoryPendingCache.clear()
  memoryPendingInflight.clear()
}

/**
 * Read-only snapshot for the header indicator. The SQLite count can be slow on
 * a cold cursor, so results are cached for 5 s and concurrent polls share one
 * read. Every failure degrades to `available: false` — never a silent 0.
 */
export async function memoryPendingSnapshot(
  directory: string,
  opts: { dbFile?: string; now?: number; ttlMs?: number } = {},
): Promise<MemoryPendingSnapshot> {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? MEMORY_PENDING_TTL_MS
  const cacheable = opts.dbFile === undefined
  const cached = memoryPendingCache.get(directory)
  if (cacheable && cached && now - cached.at < ttl) return cached.value

  const inflight = memoryPendingInflight.get(directory)
  if (cacheable && inflight) return inflight

  const run = (async (): Promise<MemoryPendingSnapshot> => {
    const ts = new Date(now).toISOString()
    const drain = await readDrainConfig(directory)
    const memory = await readMemoryConfig(directory)
    const writer = memory.provider === "rag-brain" || memory.provider === "both"
    const base = {
      ts,
      enabled: drain.enabled,
      provider: memory.provider,
      writer,
      paused: !drain.enabled || !writer,
      consumer: drain.consumer,
      trigger_pending: drain.trigger_pending,
      trigger_max_age_hours: drain.trigger_max_age_hours,
      next_due: null as number | null,
      oldest_pending_age_ms: null as number | null,
    }

    try {
      const { stateDir } = await readResolvedPaths(directory)
      // The consumer's live marker carries next_due and the last observed
      // oldest age (plan §6.1); a missing marker just leaves them null.
      try {
        const marker = JSON.parse(
          await readFile(join(stateDir, DRAIN_CURRENT_FILE), "utf8"),
        ) as { next_due?: unknown; oldest_pending_age_ms?: unknown }
        if (typeof marker.next_due === "number" && Number.isFinite(marker.next_due)) {
          base.next_due = marker.next_due
        }
        if (
          typeof marker.oldest_pending_age_ms === "number" &&
          Number.isFinite(marker.oldest_pending_age_ms)
        ) {
          base.oldest_pending_age_ms = marker.oldest_pending_age_ms
        }
      } catch {
        /* no marker yet */
      }
      const cursor = await loadCursor(resolveCursorFile(stateDir, drain.cursor_file))
      let lastTs = cursor.watermark_ts
      let seeded = false
      if (lastTs <= 0 && drain.initial_lookback_hours > 0) {
        lastTs = now - drain.initial_lookback_hours * 3_600_000
        seeded = true
      }
      const pending_turns = await countUnconsumed({
        projectDir: directory,
        lastTs,
        ...(opts.dbFile === undefined ? {} : { dbFile: opts.dbFile }),
        excludeMissions: drain.exclude_missions,
      })
      return {
        ...base,
        pending_turns,
        cursor_last_ts: lastTs,
        cursor_updated_at: cursor.watermark_ts > 0 ? cursor.updated_at : null,
        seeded,
        available: true,
      }
    } catch (err) {
      return {
        ...base,
        pending_turns: null,
        cursor_last_ts: null,
        cursor_updated_at: null,
        seeded: false,
        available: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })()

  if (!cacheable) return run

  memoryPendingInflight.set(directory, run)
  try {
    const value = await run
    memoryPendingCache.set(directory, { at: now, value })
    return value
  } finally {
    memoryPendingInflight.delete(directory)
  }
}

// ---------------------------------------------------------------------------
// Drain consumer (plan §6.1): the live marker (state/drain.current.json) +
// the last consumer/pipe ledger lines, so the queues page shows the loop
// without reading drain.log. Cached for 5 s like /api/queues.

export type DrainSnapshot = {
  ts: string
  enabled: boolean
  consumer: boolean
  state: "idle" | "running" | "unknown"
  trigger: string | null
  pass: number
  pending: number | null
  oldest_pending_age_ms: number | null
  trigger_pending: number
  trigger_max_age_hours: number
  next_due: number | null
  wake: { passes: number; wake_tokens: number; wall_ms: number; stopped: string | null } | null
  last_pass: {
    ts: string
    wall_ms: number
    tokens: number
    sessions: number
    items: number
    outcome: string
  } | null
  available: boolean
  error?: string
}

const DRAIN_TTL_MS = 5_000
const drainCache = new Map<string, { at: number; value: DrainSnapshot }>()

/** Test seam: drop the per-directory drain cache. */
export function resetDrainCache(): void {
  drainCache.clear()
}

/** Last NDJSON line in a ledger matching `pred` (newest file tail). */
function lastLedgerLine(
  body: string,
  pred: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const lines = body.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === "") continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (pred(parsed)) return parsed
    } catch {
      /* torn tail — keep walking back */
    }
  }
  return null
}

export async function drainSnapshot(
  directory: string,
  now: number = Date.now(),
): Promise<DrainSnapshot> {
  const cached = drainCache.get(directory)
  if (cached && now - cached.at < DRAIN_TTL_MS) return cached.value

  const ts = new Date(now).toISOString()
  const base = {
    ts,
    enabled: false,
    consumer: false,
    state: "unknown" as const,
    trigger: null,
    pass: 0,
    pending: null,
    oldest_pending_age_ms: null,
    trigger_pending: 0,
    trigger_max_age_hours: 0,
    next_due: null,
    wake: null,
    last_pass: null,
  }

  let value: DrainSnapshot
  try {
    const cfg = await readDrainConfig(directory)
    const { stateDir, logDir } = await readResolvedPaths(directory)
    base.enabled = cfg.enabled
    base.consumer = cfg.consumer
    base.trigger_pending = cfg.trigger_pending
    base.trigger_max_age_hours = cfg.trigger_max_age_hours

    try {
      const marker = JSON.parse(
        await readFile(join(stateDir, DRAIN_CURRENT_FILE), "utf8"),
      ) as Record<string, unknown>
      const state = marker.state === "running" || marker.state === "idle" ? marker.state : "unknown"
      value = {
        ...base,
        state,
        trigger: typeof marker.trigger === "string" ? marker.trigger : null,
        pass: typeof marker.pass === "number" ? marker.pass : 0,
        pending: typeof marker.pending === "number" ? marker.pending : null,
        oldest_pending_age_ms:
          typeof marker.oldest_pending_age_ms === "number" ? marker.oldest_pending_age_ms : null,
        next_due: typeof marker.next_due === "number" ? marker.next_due : null,
        available: true,
      }
    } catch {
      value = { ...base, available: true }
    }

    try {
      const body = await readFile(join(logDir, DRAIN_LEDGER_FILE), "utf8")
      const wake = lastLedgerLine(body, (row) => row.source === "consumer")
      if (wake) {
        value = {
          ...value,
          wake: {
            passes: typeof wake.passes === "number" ? wake.passes : 0,
            wake_tokens: typeof wake.wake_tokens === "number" ? wake.wake_tokens : 0,
            wall_ms: typeof wake.wall_ms === "number" ? wake.wall_ms : 0,
            stopped: typeof wake.stopped === "string" ? wake.stopped : null,
          },
        }
      }
      const pass = lastLedgerLine(body, (row) => row.source === "pipe")
      if (pass) {
        value = {
          ...value,
          last_pass: {
            ts: typeof pass.ts === "string" ? pass.ts : "",
            wall_ms: typeof pass.wall_ms === "number" ? pass.wall_ms : 0,
            tokens: typeof pass.tokens === "number" ? pass.tokens : 0,
            sessions: typeof pass.sessions === "number" ? pass.sessions : 0,
            items: typeof pass.items === "number" ? pass.items : 0,
            outcome: typeof pass.outcome === "string" ? pass.outcome : "unknown",
          },
        }
      }
    } catch {
      /* no ledger yet */
    }
  } catch (err) {
    value = {
      ...base,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  drainCache.set(directory, { at: now, value })
  return value
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
// Lane queues, recent runs, token series (queue-monitoring plan)
//
// Read-only views over `state/lanes.json` + `logs/heartbeat.log`. Every reader
// degrades to an empty payload (`available: false`) instead of failing the
// request: an old backend/project simply has no queues or `runs[]` yet.

type LaneName = "primary" | "side" | "drain"

export type QueueItemView = {
  id: string
  title: string | null
  kind: string
  lane: LaneName
  producer: string
  enqueued_ms: number | null
  age_ms: number | null
  expires_ms: number | null
  ttl_ms: number | null
  requeue_count: number
  requeue_reason: string | null
}

export type QueuesSnapshot = {
  ts: string
  primary: QueueItemView[]
  side: QueueItemView[]
  running: {
    mission: string | null
    mission_title: string | null
    side_mission: string | null
    side_mission_title: string | null
  }
  /** Drain consumer pointer (plan §6.1): the loop's live state, not a queue. */
  drain: {
    consumer: boolean
    state: "idle" | "running" | "unknown"
    pending: number | null
    next_due: number | null
  } | null
  available: boolean
  error?: string
}

const QUEUES_TTL_MS = 2_000
const queuesCache = new Map<string, { at: number; value: QueuesSnapshot }>()

/** Test seam: drop the per-directory queues cache. */
export function resetQueuesCache(): void {
  queuesCache.clear()
}

function toQueueItemView(raw: Record<string, unknown>, lane: LaneName, now: number, titles: Map<string, string>): QueueItemView {
  const enqueued = typeof raw.enqueued_ms === "number" && Number.isFinite(raw.enqueued_ms) ? raw.enqueued_ms : null
  const expires = typeof raw.expires_ms === "number" && Number.isFinite(raw.expires_ms) ? raw.expires_ms : null
  const id = typeof raw.id === "string" ? raw.id : "unknown"
  const missionId = id.startsWith("mission:") ? id.slice("mission:".length) : id
  return {
    id,
    title: titles.get(missionId) ?? (typeof raw.title === "string" ? raw.title : null),
    kind: typeof raw.kind === "string" ? raw.kind : "unknown",
    lane,
    producer: typeof raw.producer === "string" ? raw.producer : "unknown",
    enqueued_ms: enqueued,
    age_ms: enqueued === null ? null : Math.max(0, now - enqueued),
    expires_ms: expires,
    ttl_ms: expires === null ? null : Math.max(0, expires - now),
    requeue_count: typeof raw.requeue_count === "number" ? raw.requeue_count : 0,
    requeue_reason: typeof raw.requeue_reason === "string" ? raw.requeue_reason : null,
  }
}

/** Compact drain pointer for the queues widget (plan §6.1) — projects the
 *  drain snapshot down to what the queues page shows beside the lanes. */
async function drainPointer(
  directory: string,
): Promise<QueuesSnapshot["drain"]> {
  try {
    const snap = await drainSnapshot(directory)
    return {
      consumer: snap.consumer,
      state: snap.state,
      pending: snap.pending,
      next_due: snap.next_due,
    }
  } catch {
    return null
  }
}

export async function queuesSnapshot(directory: string, now: number = Date.now()): Promise<QueuesSnapshot> {
  const cached = queuesCache.get(directory)
  if (cached && now - cached.at < QUEUES_TTL_MS) return cached.value

  const ts = new Date(now).toISOString()
  const { stateDir } = await readResolvedPaths(directory)
  const titles = new Map<string, string>()
  try {
    for (const m of await loadMissionStates(directory)) titles.set(m.id, m.title)
  } catch {
    // mission list unreadable — ids only
  }

  let running: QueuesSnapshot["running"] = {
    mission: null,
    mission_title: null,
    side_mission: null,
    side_mission_title: null,
  }
  try {
    const current = await readHeartbeatCurrent(join(stateDir, HEARTBEAT_CURRENT_FILE))
    if (current.state === "in-flight") {
      running = {
        mission: current.mission,
        mission_title: current.mission_title,
        side_mission: current.side_mission ?? null,
        side_mission_title: current.side_mission_title ?? null,
      }
    }
  } catch {
    // no marker
  }

  let value: QueuesSnapshot
  const drainPtr = await drainPointer(directory)
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, "lanes.json"), "utf8")) as Record<string, unknown>
    const laneItems = (lane: LaneName): QueueItemView[] => {
      const raw = parsed[lane]
      if (!Array.isArray(raw)) return []
      return raw
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
        .map((item) => toQueueItemView(item, lane, now, titles))
    }
    value = {
      ts,
      primary: laneItems("primary"),
      side: laneItems("side"),
      running,
      drain: drainPtr,
      available: true,
    }
  } catch (err) {
    value = {
      ts,
      primary: [],
      side: [],
      running,
      // The lanes file may be missing while the drain marker is readable —
      // the pointer survives the queue failure (plan §6.1).
      drain: drainPtr,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  queuesCache.set(directory, { at: now, value })
  return value
}

export type RunRow = {
  ts: string
  tick: number | null
  mission: string | null
  mission_title: string | null
  lane: LaneName
  outcome: string | null
  token_cost: number | null
  over_budget: boolean
  result_status: string | null
  result_missing: boolean
  requeued: boolean
  session: string | null
  tool_session: string | null
  tool_outcome: string | null
  duration_ms: number | null
}

export type RunsSnapshot = {
  ts: string
  runs: RunRow[]
  available: boolean
  error?: string
}

export type RunQuery = { limit?: number; mission?: string | null; lane?: string | null; outcome?: string | null }

type HeartbeatLedgerRow = Record<string, unknown>

function parseHeartbeatLedger(body: string): HeartbeatLedgerRow[] {
  const rows: HeartbeatLedgerRow[] = []
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(parsed as HeartbeatLedgerRow)
      }
    } catch {
      // partial/torn line — skip
    }
  }
  return rows
}

function flattenRuns(ticks: HeartbeatLedgerRow[]): RunRow[] {
  const out: RunRow[] = []
  for (const tick of ticks) {
    const ts = typeof tick.ts === "string" ? tick.ts : ""
    const tickNo = typeof tick.tick === "number" ? tick.tick : null
    const duration = typeof tick.duration_ms === "number" ? tick.duration_ms : null
    const rawRuns = Array.isArray(tick.runs) ? tick.runs : null
    if (rawRuns && rawRuns.length > 0) {
      for (const entry of rawRuns) {
        if (entry === null || typeof entry !== "object") continue
        const r = entry as Record<string, unknown>
        const lane = r.lane === "side" ? "side" : "primary"
        out.push({
          ts,
          tick: tickNo,
          mission: typeof r.mission === "string" ? r.mission : null,
          mission_title: null,
          lane,
          outcome: typeof r.outcome === "string" ? r.outcome : null,
          token_cost: typeof r.token_cost === "number" ? r.token_cost : null,
          over_budget: r.over_budget === true,
          result_status: typeof r.result_status === "string" ? r.result_status : null,
          result_missing: r.result_missing === true,
          requeued: r.requeued === true,
          session: typeof r.session === "string" ? r.session : null,
          tool_session: typeof r.tool_session === "string" ? r.tool_session : null,
          tool_outcome: typeof r.tool_outcome === "string" ? r.tool_outcome : null,
          duration_ms: duration,
        })
      }
      continue
    }
    // Legacy tick: synthesize one primary row; legacy side-only ticks do not exist.
    if (typeof tick.mission !== "string" || tick.mission === "") continue
    out.push({
      ts,
      tick: tickNo,
      mission: tick.mission,
      mission_title: null,
      lane: "primary",
      outcome: typeof tick.outcome === "string" ? tick.outcome : null,
      token_cost: typeof tick.token_cost === "number" ? tick.token_cost : null,
      over_budget: tick.over_budget === true,
      result_status: typeof tick.result_status === "string" ? tick.result_status : null,
      result_missing: tick.result_missing === true,
      requeued: false,
      session: typeof tick.session === "string" ? tick.session : null,
      tool_session: typeof tick.tool_session === "string" ? tick.tool_session : null,
      tool_outcome: typeof tick.tool_outcome === "string" ? tick.tool_outcome : null,
      duration_ms: duration,
    })
  }
  return out
}

async function readRuns(directory: string): Promise<RunRow[]> {
  const { logDir } = await readResolvedPaths(directory)
  const body = await readFile(join(logDir, "heartbeat.log"), "utf8")
  // Both sources are chronological in file order; reverse each, then merge by
  // ts (descending) so heartbeat and drain rows interleave correctly while
  // same-ts ties keep their within-tick order.
  const heartbeatRuns = flattenRuns(parseHeartbeatLedger(body)).reverse()
  const drainRuns: RunRow[] = []
  // Drain passes (plan §6.1): after drain left the queues, its work is still
  // visible — each `source: "pipe"` line becomes a lane=drain row.
  try {
    const drainBody = await readFile(join(logDir, DRAIN_LEDGER_FILE), "utf8")
    for (const line of drainBody.split("\n")) {
      if (line.trim() === "") continue
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        if (row.source !== "pipe") continue
        drainRuns.push({
          ts: typeof row.ts === "string" ? row.ts : "",
          tick: null,
          mission: "drain",
          mission_title: null,
          lane: "drain",
          outcome: typeof row.outcome === "string" ? row.outcome : null,
          token_cost: typeof row.tokens === "number" ? row.tokens : null,
          over_budget: false,
          result_status: null,
          result_missing: false,
          requeued: false,
          session: typeof row.session === "string" ? row.session : null,
          tool_session: null,
          tool_outcome: null,
          duration_ms: typeof row.wall_ms === "number" ? row.wall_ms : null,
        })
      } catch {
        /* torn line */
      }
    }
  } catch {
    /* no drain ledger */
  }
  drainRuns.reverse()

  const merged: RunRow[] = []
  let i = 0
  let j = 0
  while (i < heartbeatRuns.length && j < drainRuns.length) {
    if (heartbeatRuns[i].ts >= drainRuns[j].ts) merged.push(heartbeatRuns[i++])
    else merged.push(drainRuns[j++])
  }
  while (i < heartbeatRuns.length) merged.push(heartbeatRuns[i++])
  while (j < drainRuns.length) merged.push(drainRuns[j++])
  return merged
}

async function missionTitles(directory: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  try {
    for (const m of await loadMissionStates(directory)) titles.set(m.id, m.title)
  } catch {
    // ids only
  }
  return titles
}

export async function runsSnapshot(directory: string, query: RunQuery = {}): Promise<RunsSnapshot> {
  const ts = new Date().toISOString()
  try {
    const titles = await missionTitles(directory)
    const lane =
      query.lane === "primary" || query.lane === "side" || query.lane === "drain"
        ? query.lane
        : null
    const mission = typeof query.mission === "string" && query.mission !== "" ? query.mission : null
    const outcome = typeof query.outcome === "string" && query.outcome !== "" ? query.outcome : null
    const limit = Math.max(1, Math.min(Number.isFinite(query.limit) ? Number(query.limit) : 50, 500))
    const rows = (await readRuns(directory))
      .filter((r) => (lane === null ? true : r.lane === lane))
      .filter((r) => (mission === null ? true : r.mission === mission))
      .filter((r) => (outcome === null ? true : r.outcome === outcome))
      .slice(0, limit)
      .map((r) => ({ ...r, mission_title: r.mission ? titles.get(r.mission) ?? null : null }))
    return { ts, runs: rows, available: true }
  } catch (err) {
    return { ts, runs: [], available: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type TokenBucket = "tick" | "hour" | "day"

export type TokenPoint = {
  bucket: string
  tokens: number
  runs: number
  over_runs: number
  /** Present on bucket=tick only. */
  tick?: number
}

export type TokenSeries = {
  ts: string
  bucket: TokenBucket
  /** autonomy.mission_token_budget; null when unlimited/unknown. */
  budget_per_run: number | null
  points: TokenPoint[]
  totals: { tokens: number; runs: number; over_runs: number }
  available: boolean
  error?: string
}

export type TokenQuery = {
  bucket?: string | null
  hours?: number | null
  mission?: string | null
  lane?: string | null
  /** Mission type — the mission file's `frequency` (day | mid | low | …). */
  type?: string | null
}

function hourKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
}

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function tokenSeriesSnapshot(directory: string, query: TokenQuery = {}): Promise<TokenSeries> {
  const ts = new Date().toISOString()
  const bucket: TokenBucket = query.bucket === "hour" || query.bucket === "day" ? query.bucket : "tick"
  const hours = Number.isFinite(query.hours) && Number(query.hours) > 0 ? Math.min(Number(query.hours), 24 * 90) : 24
  const lane =
    query.lane === "primary" || query.lane === "side" || query.lane === "drain" ? query.lane : null
  const mission = typeof query.mission === "string" && query.mission !== "" ? query.mission : null
  const type = typeof query.type === "string" && query.type !== "" ? query.type : null

  try {
    const autonomy = await readAutonomyConfig(directory)
    const rawBudget = autonomy.mission_token_budget
    const budget = typeof rawBudget === "number" && Number.isFinite(rawBudget) ? rawBudget : null
    const cutoff = Date.now() - hours * 3_600_000

    let typeIds: Set<string> | null = null
    if (type !== null) {
      typeIds = new Set<string>()
      for (const m of await loadMissionStates(directory)) {
        if (m.frequency === type) typeIds.add(m.id)
      }
    }

    const rows = (await readRuns(directory))
      .filter((r) => (lane === null ? true : r.lane === lane))
      .filter((r) => (mission === null ? true : r.mission === mission))
      .filter((r) => (typeIds === null ? true : r.mission !== null && typeIds.has(r.mission)))
      .filter((r) => {
        const t = Date.parse(r.ts)
        return Number.isFinite(t) && t >= cutoff
      })

    const points = new Map<string, TokenPoint>()
    for (const r of rows) {
      const d = new Date(Date.parse(r.ts))
      const key = bucket === "tick" ? `tick:${r.tick ?? r.ts}` : bucket === "hour" ? hourKey(d) : dayKey(d)
      const point =
        points.get(key) ??
        ({ bucket: bucket === "tick" ? key : key, tokens: 0, runs: 0, over_runs: 0 } as TokenPoint)
      if (bucket === "tick") point.tick = r.tick ?? undefined
      point.tokens += r.token_cost ?? 0
      point.runs += 1
      if (r.over_budget) point.over_runs += 1
      points.set(key, point)
    }

    const ordered = [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
    const totals = ordered.reduce(
      (acc, p) => ({ tokens: acc.tokens + p.tokens, runs: acc.runs + p.runs, over_runs: acc.over_runs + p.over_runs }),
      { tokens: 0, runs: 0, over_runs: 0 },
    )
    return { ts, bucket, budget_per_run: budget, points: ordered, totals, available: true }
  } catch (err) {
    return {
      ts,
      bucket,
      budget_per_run: null,
      points: [],
      totals: { tokens: 0, runs: 0, over_runs: 0 },
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
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
