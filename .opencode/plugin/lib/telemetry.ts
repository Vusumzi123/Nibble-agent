// Phase 0 retrieval telemetry — pure, dependency-free support for the
// telemetry-hook plugin. Config parsing, sub-agent routing, and the NDJSON
// entry builders for the two ledgers:
//
//   brain_log  — one `rag-search` line per Brain-First delegation (0a)
//   web_log    — `web-task` lines per browser delegation + `web-fetch` lines
//                for every inner webfetch/websearch call (0b)
//
// Contract: logging only, zero behavior change, deterministic (no LLM), and
// NO prompt text or full URLs in the ledger — only byte counts, a short task
// description, and a `sanitizeTarget`-capped target. Usage is embedded verbatim
// from `drainAccounting` (lib/autonomy.ts) so its camelCase keys are preserved.
//
// Config lives in the `telemetry:` block of .opencode/sysop-config.yaml. The
// two channels share one rotation policy via the bare keys (audit: pattern).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"

export type TelemetryConfig = {
  enabled: boolean
  /** Comma-separated sub-agent names whose `task` delegations are measured. */
  watch_agents: string
  /** Leaf under <sysop>: 0a Brain-First delegation ledger. */
  brain_log: string
  /** Leaf under <sysop>: 0b browser delegation + inner fetch ledger. */
  web_log: string
  rotate_bytes: number
  keep_generations: number
  retention_days: number
  compress: boolean
  compress_after: number
  compress_level: number
  rotate_by: string
}

export const DEFAULT_TELEMETRY: TelemetryConfig = {
  enabled: true,
  watch_agents: "rag-search,safe-browser,deep-browser",
  brain_log: "rag-search.log",
  web_log: "web-usage.log",
  rotate_bytes: 1048576,
  keep_generations: 5,
  retention_days: 90,
  compress: true,
  compress_after: 1,
  compress_level: 6,
  rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_TELEMETRY))
const BOOL_KEYS = new Set(["enabled", "compress"])
const INT_KEYS = new Set([
  "rotate_bytes",
  "keep_generations",
  "retention_days",
  "compress_after",
  "compress_level",
])

const TELEMETRY_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  stringMode: "pair-quotes",
})

// Parse a `telemetry:` block out of sysop-config.yaml text. Only flat `key:
// value` scalars are supported. Unrecognized keys are ignored.
export function parseTelemetryConfig(yamlText: string): Partial<TelemetryConfig> {
  return parseFlatBlock(yamlText, "telemetry", {
    knownKeys: KNOWN_KEYS,
    coerce: TELEMETRY_COERCE,
  }) as Partial<TelemetryConfig>
}

// Read the effective `telemetry:` config for a project directory, overlaying the
// block on the defaults. Never throws: a missing or malformed config yields the
// defaults.
export async function readTelemetryConfig(directory: string): Promise<TelemetryConfig> {
  const cfg = await readSection(directory, "telemetry", DEFAULT_TELEMETRY, {
    coerce: TELEMETRY_COERCE,
  })
  if (typeof cfg.watch_agents !== "string") cfg.watch_agents = DEFAULT_TELEMETRY.watch_agents
  if (typeof cfg.brain_log !== "string" || !cfg.brain_log.trim()) {
    cfg.brain_log = DEFAULT_TELEMETRY.brain_log
  }
  if (typeof cfg.web_log !== "string" || !cfg.web_log.trim()) {
    cfg.web_log = DEFAULT_TELEMETRY.web_log
  }
  return cfg
}

// Comma-separated watched sub-agent list -> a set. Trimmed; empties dropped.
export function parseWatchAgents(raw: string): Set<string> {
  const out = new Set<string>()
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim()
    if (trimmed) out.add(trimmed)
  }
  return out
}

// Map a sub-agent name to its ledger channel. Unwatched or unknown agents are
// ignored (`null`), so the ledgers only ever gain lines for the measured paths.
export function routeForAgent(agent: string, watch: Set<string>): "brain" | "web" | null {
  if (!agent || !watch.has(agent)) return null
  if (agent === "rag-search") return "brain"
  if (agent === "safe-browser" || agent === "deep-browser") return "web"
  return null
}

// The completion state carried in the task tool's textual envelope
// (`<task id="…" state="…">`). Returns "error" when the envelope reports a
// failure, null otherwise (completed/running/unknown all fall through to ok).
export function taskEnvelopeState(output: unknown): "error" | null {
  if (typeof output !== "string") return null
  const m = output.match(/state="(completed|error|running)"/)
  return m && m[1] === "error" ? "error" : null
}

// Cap a caller-supplied task description to a short, newline-free string. The
// description is already agent-authored (not raw prompt text), but a hard cap
// keeps the ledger bounded and prevents a multi-line value from bloating a line.
export function shortDescription(raw: unknown, max = 200): string {
  if (typeof raw !== "string") return ""
  const flat = raw.replace(/[\r\n\t]+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export type TaskTelemetryInput = {
  ts?: string
  /** `rag-search` for the brain ledger, `web-task` for the web ledger. */
  event: "rag-search" | "web-task"
  parentSession: string
  childSession: string | null
  topSession: string
  delegate: string
  description: string
  promptBytes: number
  model: unknown
  wallMs: number | null
  outcome: "ok" | "error" | "background"
  reason?: string
  /** The exact `drainAccounting` return shape, embedded verbatim. */
  usage?: unknown
}

// Assemble one 0a/`web-task` line. `usage` is spread verbatim (its camelCase
// keys are authoritative); it is omitted entirely on the error/background paths.
export function buildTaskTelemetryEntry(input: TaskTelemetryInput): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ts: input.ts ?? new Date().toISOString(),
    event: input.event,
    parentSession: input.parentSession,
    childSession: input.childSession,
    topSession: input.topSession,
    delegate: input.delegate,
    description: input.description,
    promptBytes: input.promptBytes,
    model: input.model ?? null,
    wallMs: input.wallMs,
    outcome: input.outcome,
  }
  if (input.reason !== undefined) entry.reason = input.reason
  if (input.usage !== undefined) entry.usage = input.usage
  return entry
}
