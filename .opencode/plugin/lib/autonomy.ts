// Autonomy-harness config plumbing (docs/autonomy-harness-plan.md §11 — kanban
// card 1). Types, defaults, validation, and hot readers for the four harness
// sections of sysop-config.yaml:
//
//   autonomy:  capability dial + heartbeat/chatter/quiet sub-blocks (§4, §16, §17)
//   mood:      feeling-system dials (§15)
//   comms:     channel selection for notifications/approvals (§7, §16.4)
//   dashboard: local web UI bind + auth mode (§9)
//
// Contract:
//   - Hot-read: every reader re-reads sysop-config.yaml per call — flipping a
//     value takes effect on the next read, no restart (same precedent as
//     decisions.mode and the telegram `enabled` dial).
//   - Never throws: a missing file yields the defaults; an invalid value falls
//     back to its default and is reported once per process to
//     <log>/autonomy-config.log (NDJSON through the shared logging engine,
//     lib/logfile.ts + lib/logging.ts) — unless the caller passes its own
//     `onReject` (tests do).
//   - Nothing consumes these sections yet: autonomy-gate.ts (card 2), lib/
//     mood.ts (card 5), the dashboard backend (card 8), and the comms bridges
//     (card 10) are the future readers.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { homedir } from "node:os"
import {
  isDuration,
  parseInlineList,
  readNestedSection,
  type NestedCoerce,
  type NestedDefaults,
  type NestedReject,
  type NestedSectionOptions,
} from "./config.ts"
import { LOG_DEFAULTS, getLogger } from "./logging.ts"
import { readResolvedPaths } from "./paths.ts"

// ---------------------------------------------------------------------------
// Types + defaults (plan §11, §17.9, §17.11)

export type HeartbeatConfig = {
  /** `off` | `<n>m` | `<n>h` — manual dial, never auto-scaled (§4.2). */
  frequency: string
  in_progress_lock: boolean
}

export type ChatterConfig = {
  enabled: boolean
  max_pokes: number
  daily_budget: number
  /** Duration `12h` — gap between conversations. */
  cooldown: string
  /** Duration `24h` — await window before JEV poke/close triage. */
  reply_window: string
}

export type QuietConfig = {
  /** `"HH:MM-HH:MM"` — isQuietNow() predicate source (§17.1). */
  window: string
  /** Duration — dream timer base interval (§17.2). */
  dream_cadence: string
  /** Duration — woken -> dreaming after this much silence (§17.7). */
  resume_cooldown: string
  /** 0..1 — pre-JEV roll for the dream candidate (§17.3). */
  dream_chance: number
  /** Hard per-tick cap in K tokens (§17.8). */
  dream_token_budget: number
  /** Max dream missions per window (§17.3). */
  nightly_dream_cap: number
  /** 30->60->120m on consecutive no-ops (§17.8). */
  backoff: boolean
  /** Strict night whitelist — subset of NIGHT_MENU (§17.4). */
  dream_missions: string[]
}

export type AutonomyConfig = {
  /** 0..4 capability dial (§4.1). Code default 1; live config ships 2. */
  level: number
  heartbeat: HeartbeatConfig
  /** K-tokens per mission turn, or `unlimited` (§6.4). */
  mission_token_budget: number | "unlimited"
  /** L4 root allowlist — the irreversibility floor applies first (§4.1). */
  root_classes: string[]
  chatter: ChatterConfig
  quiet: QuietConfig
}

export type MoodConfig = {
  /** false = expression only; true adds bounded dispatch weighting (§15.4). */
  dispatch_influence: boolean
  /** Duration — mood decay half-life (§15.1). */
  decay_half_life: string
}

export type CommsConfig = {
  /** `telegram` | `email` — channel for approvals/notifications (§7.1). */
  default_channel: string
  /** Duration — lazy chat-session expiry (§16.4 D15). */
  session_ttl: string
  telegram: {
    enabled: boolean
    /** `~`-expanded credential file; secrets never live in the config. */
    bot_token_file: string
    chat_id_file: string
  }
  email: {
    enabled: boolean
    account: string
    reply_window_hours: number
  }
}

export type DashboardConfig = {
  bind_address: string
  auth: {
    /** `off` | `login` | `login+2fa` (§10). */
    mode: string
    require_tls: boolean
  }
}

export const DEFAULT_AUTONOMY: AutonomyConfig = {
  level: 1,
  heartbeat: { frequency: "12h", in_progress_lock: true },
  mission_token_budget: 32000,
  root_classes: [],
  chatter: {
    enabled: false,
    max_pokes: 3,
    daily_budget: 2,
    cooldown: "12h",
    reply_window: "24h",
  },
  quiet: {
    window: "23:00-08:00",
    dream_cadence: "30m",
    resume_cooldown: "60m",
    dream_chance: 0.5,
    dream_token_budget: 8000,
    nightly_dream_cap: 3,
    backoff: true,
    dream_missions: ["drain", "dream"],
  },
}

export const DEFAULT_MOOD: MoodConfig = {
  dispatch_influence: true,
  decay_half_life: "6h",
}

export const DEFAULT_COMMS: CommsConfig = {
  default_channel: "telegram",
  session_ttl: "24h",
  telegram: { enabled: false, bot_token_file: "", chat_id_file: "" },
  email: { enabled: false, account: "", reply_window_hours: 48 },
}

export const DEFAULT_DASHBOARD: DashboardConfig = {
  bind_address: "127.0.0.1",
  auth: { mode: "off", require_tls: false },
}

// Strict night menu (§17.4): the only missions the quiet window admits.
export const NIGHT_MENU = ["drain", "dream"] as const
export const AUTH_MODES = ["off", "login", "login+2fa"] as const
export const COMMS_CHANNELS = ["telegram", "email"] as const

// Fresh nested-default views (never share mutable defaults across reads).
function autonomyDefaults(): NestedDefaults {
  const { level, mission_token_budget, root_classes, heartbeat, chatter, quiet } = DEFAULT_AUTONOMY
  return {
    scalars: { level, mission_token_budget, root_classes },
    blocks: { heartbeat, chatter, quiet },
  }
}

function moodDefaults(): NestedDefaults {
  return { scalars: { ...DEFAULT_MOOD }, blocks: {} }
}

function commsDefaults(): NestedDefaults {
  const { default_channel, session_ttl, telegram, email } = DEFAULT_COMMS
  return {
    scalars: { default_channel, session_ttl },
    blocks: { telegram, email },
  }
}

function dashboardDefaults(): NestedDefaults {
  const { bind_address, auth } = DEFAULT_DASHBOARD
  return { scalars: { bind_address }, blocks: { auth } }
}

// ---------------------------------------------------------------------------
// Validation (schema -> coercion rules)
//
// One rule table per section drives `makeCoerce`: a present-but-invalid value
// returns `{ ok: false }` -> reject -> the default stands and a warning line
// is logged. Absent keys are never coerced (the default stands silently).

type Rule =
  | { t: "bool" }
  | { t: "int"; min?: number; max?: number }
  | { t: "float"; min?: number; max?: number }
  | { t: "string" }
  | { t: "duration" }
  | { t: "freq" } // `off` | duration
  | { t: "window" } // HH:MM-HH:MM
  | { t: "enum"; values: readonly string[] }
  | { t: "list"; members?: readonly string[] }
  | { t: "budget" } // non-negative int | `unlimited`

const INT_RE = /^\d+$/
const SIGNED_INT_RE = /^-?\d+$/
const FLOAT_RE = /^\d+(?:\.\d+)?$/
const WINDOW_RE = /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/

function coerceRule(rule: Rule, raw: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  // Strip a matching pair of quotes first so `"2"`, `'12h'`, `"off"` work.
  const v =
    raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw

  switch (rule.t) {
    case "bool": {
      if (v === "true") return { ok: true, value: true }
      if (v === "false") return { ok: true, value: false }
      return { ok: false, reason: "expected true or false" }
    }
    case "int": {
      if (!SIGNED_INT_RE.test(v)) return { ok: false, reason: "expected an integer" }
      const n = parseInt(v, 10)
      if (rule.min !== undefined && n < rule.min) return { ok: false, reason: `must be >= ${rule.min}` }
      if (rule.max !== undefined && n > rule.max) return { ok: false, reason: `must be <= ${rule.max}` }
      return { ok: true, value: n }
    }
    case "float": {
      if (!FLOAT_RE.test(v)) return { ok: false, reason: "expected a number" }
      const n = parseFloat(v)
      if (rule.min !== undefined && n < rule.min) return { ok: false, reason: `must be >= ${rule.min}` }
      if (rule.max !== undefined && n > rule.max) return { ok: false, reason: `must be <= ${rule.max}` }
      return { ok: true, value: n }
    }
    case "string": {
      // Any text; a quoted empty (`""`) normalizes to "" and is accepted so
      // a cleared path/address does not warn on every read.
      return { ok: true, value: v }
    }
    case "duration": {
      if (isDuration(v)) return { ok: true, value: v }
      return { ok: false, reason: "expected a duration like 12h or 30m" }
    }
    case "freq": {
      if (v === "off" || isDuration(v)) return { ok: true, value: v }
      return { ok: false, reason: "expected off or a duration like 12h" }
    }
    case "window": {
      if (WINDOW_RE.test(v)) return { ok: true, value: v }
      return { ok: false, reason: "expected HH:MM-HH:MM" }
    }
    case "enum": {
      if ((rule.values as readonly string[]).includes(v)) return { ok: true, value: v }
      return { ok: false, reason: `expected one of: ${rule.values.join(", ")}` }
    }
    case "list": {
      const items = parseInlineList(v)
      if (items === undefined) return { ok: false, reason: "expected an inline list like [a, b]" }
      if (rule.members) {
        for (const item of items) {
          if (!(rule.members as readonly string[]).includes(item)) {
            return { ok: false, reason: `not an allowed member: ${item} (allowed: ${rule.members.join(", ")})` }
          }
        }
      }
      return { ok: true, value: items }
    }
    case "budget": {
      if (v === "unlimited") return { ok: true, value: "unlimited" }
      if (INT_RE.test(v)) return { ok: true, value: parseInt(v, 10) }
      return { ok: false, reason: "expected a non-negative integer (K tokens) or unlimited" }
    }
  }
}

// Build a NestedCoerce from a scalar rule table plus per-block rule tables.
function makeCoerce(
  scalars: Record<string, Rule>,
  blocks: Record<string, Record<string, Rule>>,
): NestedCoerce {
  return (path, raw) => {
    const dot = path.indexOf(".")
    if (dot === -1) {
      const rule = scalars[path]
      if (!rule) return undefined
      return coerceRule(rule, raw)
    }
    const block = path.slice(0, dot)
    const key = path.slice(dot + 1)
    const rule = blocks[block]?.[key]
    if (!rule) return undefined
    return coerceRule(rule, raw)
  }
}

function keysOf(rules: Record<string, Rule>): Set<string> {
  return new Set(Object.keys(rules))
}

function listOf(scalars: Record<string, Rule>): Set<string> {
  return new Set(Object.entries(scalars).filter(([, r]) => r.t === "list").map(([k]) => k))
}

function blockListsOf(blocks: Record<string, Record<string, Rule>>): Set<string> {
  return new Set(
    Object.entries(blocks).flatMap(([b, rules]) =>
      Object.entries(rules)
        .filter(([, r]) => r.t === "list")
        .map(([k]) => `${b}.${k}`),
    ),
  )
}

function blocksOf(blocks: Record<string, Record<string, Rule>>): Record<string, Set<string>> {
  return Object.fromEntries(Object.entries(blocks).map(([b, r]) => [b, keysOf(r)]))
}

const AUTONOMY_SCALAR_RULES: Record<string, Rule> = {
  level: { t: "int", min: 0, max: 4 },
  mission_token_budget: { t: "budget" },
  root_classes: { t: "list" },
}

const AUTONOMY_BLOCK_RULES: Record<string, Record<string, Rule>> = {
  heartbeat: {
    frequency: { t: "freq" },
    in_progress_lock: { t: "bool" },
  },
  chatter: {
    enabled: { t: "bool" },
    max_pokes: { t: "int", min: 0 },
    daily_budget: { t: "int", min: 0 },
    cooldown: { t: "duration" },
    reply_window: { t: "duration" },
  },
  quiet: {
    window: { t: "window" },
    dream_cadence: { t: "duration" },
    resume_cooldown: { t: "duration" },
    dream_chance: { t: "float", min: 0, max: 1 },
    dream_token_budget: { t: "int", min: 0 },
    nightly_dream_cap: { t: "int", min: 0 },
    backoff: { t: "bool" },
    dream_missions: { t: "list", members: NIGHT_MENU },
  },
}

const MOOD_SCALAR_RULES: Record<string, Rule> = {
  dispatch_influence: { t: "bool" },
  decay_half_life: { t: "duration" },
}

const COMMS_SCALAR_RULES: Record<string, Rule> = {
  default_channel: { t: "enum", values: COMMS_CHANNELS },
  session_ttl: { t: "duration" },
}

const COMMS_BLOCK_RULES: Record<string, Record<string, Rule>> = {
  telegram: {
    enabled: { t: "bool" },
    bot_token_file: { t: "string" },
    chat_id_file: { t: "string" },
  },
  email: {
    enabled: { t: "bool" },
    account: { t: "string" },
    reply_window_hours: { t: "int", min: 0 },
  },
}

const DASHBOARD_SCALAR_RULES: Record<string, Rule> = {
  bind_address: { t: "string" },
}

const DASHBOARD_BLOCK_RULES: Record<string, Record<string, Rule>> = {
  auth: {
    mode: { t: "enum", values: AUTH_MODES },
    require_tls: { t: "bool" },
  },
}

const AUTONOMY_OPTS: NestedSectionOptions = {
  scalarKeys: keysOf(AUTONOMY_SCALAR_RULES),
  blockKeys: blocksOf(AUTONOMY_BLOCK_RULES),
  listKeys: listOf(AUTONOMY_SCALAR_RULES),
  blockListKeys: blockListsOf(AUTONOMY_BLOCK_RULES),
  coerce: makeCoerce(AUTONOMY_SCALAR_RULES, AUTONOMY_BLOCK_RULES),
}

const MOOD_OPTS: NestedSectionOptions = {
  scalarKeys: keysOf(MOOD_SCALAR_RULES),
  coerce: makeCoerce(MOOD_SCALAR_RULES, {}),
}

const COMMS_OPTS: NestedSectionOptions = {
  scalarKeys: keysOf(COMMS_SCALAR_RULES),
  blockKeys: blocksOf(COMMS_BLOCK_RULES),
  coerce: makeCoerce(COMMS_SCALAR_RULES, COMMS_BLOCK_RULES),
}

const DASHBOARD_OPTS: NestedSectionOptions = {
  scalarKeys: keysOf(DASHBOARD_SCALAR_RULES),
  blockKeys: blocksOf(DASHBOARD_BLOCK_RULES),
  coerce: makeCoerce(DASHBOARD_SCALAR_RULES, DASHBOARD_BLOCK_RULES),
}

// ---------------------------------------------------------------------------
// Reject reporting — fallback + warning (once per process per path)

const AUTONOMY_LOG_FILE = "autonomy-config.log"

export type RejectEvent = NestedReject & { section: string }

export type ReadAutonomyOpts = {
  /** Override the default warning-log behaviour (tests inject a collector). */
  onReject?: (event: RejectEvent) => void
}

// Process-scoped dedupe: a permanently invalid value logs once, not once per
// turn — readers are called hot (every turn).
const warned = new Set<string>()

/** Test hook: allow a fresh process-scoped warning pass. */
export function clearRejectWarnCache(): void {
  warned.clear()
}

async function reportRejects(
  directory: string,
  section: string,
  rejects: NestedReject[],
  onReject?: (event: RejectEvent) => void,
): Promise<void> {
  if (rejects.length === 0) return
  if (onReject) {
    for (const r of rejects) onReject({ section, ...r })
    return
  }
  const fresh = rejects.filter((r) => {
    const key = `${directory} ${section} ${r.path} ${r.reason}`
    if (warned.has(key)) return false
    warned.add(key)
    return true
  })
  if (fresh.length === 0) return
  try {
    const { logDir } = await readResolvedPaths(directory)
    const logger = getLogger(
      { ...LOG_DEFAULTS, file: AUTONOMY_LOG_FILE },
      { logDir, home: homedir(), channel: "autonomy-config" },
    )
    const ts = new Date().toISOString()
    for (const r of fresh) {
      await logger.append({
        ts,
        event: "config-reject",
        section,
        path: r.path,
        raw: r.raw.slice(0, 200),
        reason: r.reason,
        action: "default",
      })
    }
    await logger.flush()
  } catch {
    // A log problem must never break a config read.
  }
}

// ---------------------------------------------------------------------------
// Readers (hot — one file read per call)

function typed<T>(defaults: T, scalars: Record<string, unknown>, blocks: Record<string, Record<string, unknown>>): T {
  // Coercion guarantees the value shapes; a spread over the parsed scalars
  // plus per-block merges reconstructs the typed config from its defaults.
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>), ...scalars }
  for (const [name, values] of Object.entries(blocks)) {
    const base = (defaults as Record<string, unknown>)[name]
    if (base && typeof base === "object") out[name] = { ...(base as object), ...values }
  }
  return out as T
}

export async function readAutonomyConfig(
  directory: string,
  opts: ReadAutonomyOpts = {},
): Promise<AutonomyConfig> {
  const parsed = await readNestedSection(directory, "autonomy", autonomyDefaults(), AUTONOMY_OPTS)
  await reportRejects(directory, "autonomy", parsed.rejects, opts.onReject)
  return typed(DEFAULT_AUTONOMY, parsed.scalars, parsed.blocks)
}

export async function readMoodConfig(directory: string, opts: ReadAutonomyOpts = {}): Promise<MoodConfig> {
  const parsed = await readNestedSection(directory, "mood", moodDefaults(), MOOD_OPTS)
  await reportRejects(directory, "mood", parsed.rejects, opts.onReject)
  return typed(DEFAULT_MOOD, parsed.scalars, parsed.blocks)
}

export async function readCommsConfig(directory: string, opts: ReadAutonomyOpts = {}): Promise<CommsConfig> {
  const parsed = await readNestedSection(directory, "comms", commsDefaults(), COMMS_OPTS)
  await reportRejects(directory, "comms", parsed.rejects, opts.onReject)
  return typed(DEFAULT_COMMS, parsed.scalars, parsed.blocks)
}

export async function readDashboardConfig(
  directory: string,
  opts: ReadAutonomyOpts = {},
): Promise<DashboardConfig> {
  const parsed = await readNestedSection(directory, "dashboard", dashboardDefaults(), DASHBOARD_OPTS)
  await reportRejects(directory, "dashboard", parsed.rejects, opts.onReject)
  return typed(DEFAULT_DASHBOARD, parsed.scalars, parsed.blocks)
}

