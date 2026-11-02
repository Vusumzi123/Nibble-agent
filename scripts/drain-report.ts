#!/usr/bin/env node
// Read-only rollup for the drain ledger.
//
// Usage:
//   node scripts/drain-report.ts [path/to/drain.log] [--json]
//
// The default path is .opencode/logs/drain.log. The ledger is NDJSON: one line
// per pipe pass, per summarizer call, and per writer chunk. This script groups
// them by pass_id and prints the numbers the optimisation decisions need:
// where the wall time went, and what each agent actually spent.
//
// No writes, no network, no dependencies. Loaded directly by Node's type strip.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

type Entry = Record<string, unknown> & {
  ts?: string
  source?: string
  pass_id?: string
  outcome?: string
  wall_ms?: number | null
  run_ms?: number | null
  queue_ms?: number | null
  model_ms?: number | null
  tool_ms?: number | null
  span_ms?: number | null
  spawn_ms?: number | null
  steps?: number | null
  tokens?: number | null
  items?: number | null
  sessions?: number | null
  consolidated?: number | null
  skipped?: number | null
  phase_ms?: Record<string, number>
  overhead_ms?: number | null
  error?: string | null
  agent?: string | null
}

type AgentStats = {
  calls: number
  errors: number
  run: number[]
  queue: number[]
  model: number[]
  tool: number[]
  span: number[]
  gap: number[]
  steps: number[]
  tokens: number[]
}

const args = process.argv.slice(2)
const json = args.includes("--json")
const fileArg = args.find((arg) => arg !== "--json")
const file = fileArg ?? join(".opencode", "logs", "drain.log")

const raw = await readFile(file, "utf8").catch(() => "")
const entries: Entry[] = raw
  .split("\n")
  .map((line) => {
    try {
      return line.trim() ? (JSON.parse(line) as Entry) : null
    } catch {
      return null
    }
  })
  .filter((entry): entry is Entry => entry !== null)

if (entries.length === 0) {
  console.error(`drain-report: no ledger lines in ${file}`)
  process.exit(1)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function p90(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value)
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const passes = new Map<string, {
  pipe?: Entry
  summarizers: Entry[]
  writers: Entry[]
}>()

for (const entry of entries) {
  const passId = typeof entry.pass_id === "string" ? entry.pass_id : null
  if (!passId) continue
  const bucket = passes.get(passId) ?? { summarizers: [], writers: [] }
  if (entry.source === "pipe") bucket.pipe = entry
  else if (entry.source === "summarizer") bucket.summarizers.push(entry)
  else if (entry.source === "writer") bucket.writers.push(entry)
  passes.set(passId, bucket)
}

const agents: Record<string, AgentStats> = {}
for (const entry of entries) {
  if (entry.source !== "summarizer" && entry.source !== "writer") continue
  const name = entry.source === "summarizer" ? "session-summarizer" : "rag-brain (writer)"
  const stats = (agents[name] ??= {
    calls: 0,
    errors: 0,
    run: [],
    queue: [],
    model: [],
    tool: [],
    span: [],
    gap: [],
    steps: [],
    tokens: [],
  })
  stats.calls++
  if (entry.error || entry.outcome === "error" || entry.outcome === "degraded") stats.errors++
  for (const [key, list] of [
    ["run_ms", stats.run],
    ["queue_ms", stats.queue],
    ["model_ms", stats.model],
    ["tool_ms", stats.tool],
    ["span_ms", stats.span],
    ["steps", stats.steps],
    ["tokens", stats.tokens],
  ] as const) {
    const value = num(entry[key])
    if (value !== null) list.push(value)
  }
  const span = num(entry.span_ms)
  const model = num(entry.model_ms)
  if (span !== null && model !== null) stats.gap.push(Math.max(0, span - model))
}

const summary = [...passes.entries()]
  .map(([passId, bucket]) => {
    const pipe = bucket.pipe
    const phase = pipe?.phase_ms ?? {}
    const pipeWall = num(pipe?.wall_ms)
    return {
      pass_id: passId,
      ts: pipe?.ts ?? null,
      outcome: pipe?.outcome ?? null,
      wall_ms: pipeWall,
      phase_ms: phase,
      overhead_ms: num(pipe?.overhead_ms),
      summarizers: bucket.summarizers.length,
      writer_chunks: bucket.writers.length,
      sessions: num(pipe?.sessions),
      items: num(pipe?.items),
      consolidated: num(pipe?.consolidated),
      skipped: num(pipe?.skipped),
      tokens: num(pipe?.tokens),
      error: pipe?.error ?? null,
    }
  })
  .sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")))

const agentSummary = Object.fromEntries(
  Object.entries(agents).map(([name, stats]) => [
    name,
    {
      calls: stats.calls,
      errors: stats.errors,
      run_p50_ms: round(median(stats.run)),
      run_p90_ms: round(p90(stats.run)),
      queue_p50_ms: round(median(stats.queue)),
      model_p50_ms: round(median(stats.model)),
      tool_p50_ms: round(median(stats.tool)),
      span_p50_ms: round(median(stats.span)),
      gap_p50_ms: round(median(stats.gap)),
      steps_p50: round(median(stats.steps)),
      tokens_p50: round(median(stats.tokens)),
    },
  ]),
)

if (json) {
  console.log(JSON.stringify({ file, lines: entries.length, passes: summary, agents: agentSummary }, null, 2))
  process.exit(0)
}

const fmt = (value: unknown): string => (value === null || value === undefined ? "-" : String(value))

console.log(`drain ledger: ${file}`)
console.log(`${entries.length} lines, ${passes.size} pass(es)\n`)

console.log("Passes")
for (const pass of summary) {
  const phases = Object.entries(pass.phase_ms)
    .map(([key, value]) => `${key}=${Math.round(value)}`)
    .join(" ")
  console.log(
    `  ${fmt(pass.ts)}  ${fmt(pass.outcome)}  wall=${fmt(pass.wall_ms)}ms  ` +
      `${phases || "no phase data"}  overhead=${fmt(pass.overhead_ms)}ms  ` +
      `sessions=${fmt(pass.sessions)} items=${fmt(pass.items)} ` +
      `(consolidated=${fmt(pass.consolidated)}, skipped=${fmt(pass.skipped)}) ` +
      `tokens=${fmt(pass.tokens)} summarizers=${pass.summarizers} writers=${pass.writer_chunks}` +
      (pass.error ? `  error=${pass.error}` : ""),
  )
}

console.log("\nAgents (per call; p50 unless noted)")
for (const [name, stats] of Object.entries(agentSummary)) {
  console.log(
    `  ${name}: calls=${stats.calls} errors=${stats.errors} ` +
      `run p50=${fmt(stats.run_p50_ms)}ms p90=${fmt(stats.run_p90_ms)}ms ` +
      `queue p50=${fmt(stats.queue_p50_ms)}ms ` +
      `model p50=${fmt(stats.model_p50_ms)}ms tool p50=${fmt(stats.tool_p50_ms)}ms ` +
      `span p50=${fmt(stats.span_p50_ms)}ms non-model gap p50=${fmt(stats.gap_p50_ms)}ms ` +
      `steps p50=${fmt(stats.steps_p50)} tokens p50=${fmt(stats.tokens_p50)}`,
  )
}
