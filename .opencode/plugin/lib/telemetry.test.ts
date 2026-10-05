import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_TELEMETRY,
  buildTaskTelemetryEntry,
  parseTelemetryConfig,
  parseWatchAgents,
  readTelemetryConfig,
  routeForAgent,
  shortDescription,
  taskEnvelopeState,
} from "./telemetry.ts"

// ---------------------------------------------------------------------------
// Config

test("parseTelemetryConfig reads a full block with typed scalars", () => {
  const cfg = parseTelemetryConfig(
    [
      "telemetry:",
      "  enabled: false",
      "  watch_agents: rag-search,safe-browser",
      "  brain_log: custom-brain.log",
      "  web_log: custom-web.log",
      "  rotate_bytes: 2048",
      "  keep_generations: 2",
      "  retention_days: 7",
      "  compress: false",
      "  compress_after: 0",
      "  compress_level: 9",
      "  rotate_by: daily",
      "",
      "browser:",
      "  enabled: true",
    ].join("\n"),
  )
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.watch_agents, "rag-search,safe-browser")
  assert.equal(cfg.brain_log, "custom-brain.log")
  assert.equal(cfg.web_log, "custom-web.log")
  assert.equal(cfg.rotate_bytes, 2048)
  assert.equal(cfg.keep_generations, 2)
  assert.equal(cfg.retention_days, 7)
  assert.equal(cfg.compress, false)
  assert.equal(cfg.compress_after, 0)
  assert.equal(cfg.compress_level, 9)
  assert.equal(cfg.rotate_by, "daily")
})

test("parseTelemetryConfig ignores unknown keys, comments and other sections", () => {
  const cfg = parseTelemetryConfig(
    ["telemetry:", "  nonsense: 1", "  enabled: true  # inline", "other:", "  enabled: nope"].join("\n"),
  )
  assert.equal(cfg.enabled, true)
  assert.equal((cfg as Record<string, unknown>).nonsense, undefined)
})

test("parseTelemetryConfig returns empty object when section missing", () => {
  assert.deepEqual(parseTelemetryConfig("browser:\n  enabled: false\n"), {})
})

test("readTelemetryConfig malformed values fall back to defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tel-cfg-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["telemetry:", "  enabled: nope", "  rotate_bytes: not-a-number", "  brain_log: \"\""].join("\n"),
  )
  const cfg = await readTelemetryConfig(dir)
  assert.equal(cfg.enabled, DEFAULT_TELEMETRY.enabled)
  assert.equal(cfg.rotate_bytes, DEFAULT_TELEMETRY.rotate_bytes)
  assert.equal(cfg.brain_log, DEFAULT_TELEMETRY.brain_log)
  await rm(dir, { recursive: true, force: true })
})

test("readTelemetryConfig missing file yields defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tel-nofile-"))
  const cfg = await readTelemetryConfig(dir)
  assert.deepEqual(cfg, DEFAULT_TELEMETRY)
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Routing

test("parseWatchAgents splits, trims, drops empties", () => {
  const set = parseWatchAgents(" rag-search , safe-browser ,, deep-browser ")
  assert.deepEqual([...set].sort(), ["deep-browser", "rag-search", "safe-browser"])
})

test("routeForAgent maps watched agents to their ledger", () => {
  const watch = parseWatchAgents(DEFAULT_TELEMETRY.watch_agents)
  assert.equal(routeForAgent("rag-search", watch), "brain")
  assert.equal(routeForAgent("safe-browser", watch), "web")
  assert.equal(routeForAgent("deep-browser", watch), "web")
  assert.equal(routeForAgent("general", watch), null)
  assert.equal(routeForAgent("explore", watch), null)
  assert.equal(routeForAgent("", watch), null)
})

test("routeForAgent returns null for an unwatched agent", () => {
  const watch = parseWatchAgents("safe-browser")
  assert.equal(routeForAgent("rag-search", watch), null)
  assert.equal(routeForAgent("safe-browser", watch), "web")
})

// ---------------------------------------------------------------------------
// Entry builders

test("buildTaskTelemetryEntry embeds usage verbatim under camelCase keys", () => {
  const usage = {
    assistantSteps: 2,
    toolCalls: 3,
    inputTokens: 1200,
    outputTokens: 300,
    reasoningTokens: 40,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    cost: 0.004,
    usageKnown: true,
  }
  const entry = buildTaskTelemetryEntry({
    ts: "2026-09-26T00:00:00.000Z",
    event: "rag-search",
    parentSession: "ses_parent",
    childSession: "ses_child",
    topSession: "ses_parent",
    delegate: "rag-search",
    description: "search the vault",
    promptBytes: 812,
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
    wallMs: 4231,
    outcome: "ok",
    usage,
  })
  assert.equal(entry.event, "rag-search")
  assert.equal(entry.childSession, "ses_child")
  assert.equal(entry.promptBytes, 812)
  assert.equal(entry.wallMs, 4231)
  assert.deepEqual(entry.usage, usage)
})

test("buildTaskTelemetryEntry omits usage on error/background and includes reason", () => {
  const base = {
    event: "web-task" as const,
    parentSession: "p",
    childSession: null,
    topSession: "p",
    delegate: "safe-browser",
    description: "",
    promptBytes: 0,
    model: null,
    wallMs: null,
    outcome: "error" as const,
    reason: "no-child",
  }
  const entry = buildTaskTelemetryEntry(base)
  assert.equal(entry.outcome, "error")
  assert.equal(entry.reason, "no-child")
  assert.ok(!("usage" in entry))
})

test("taskEnvelopeState flags only an error envelope", () => {
  assert.equal(taskEnvelopeState('<task id="x" state="error">…</task>'), "error")
  assert.equal(taskEnvelopeState('<task id="x" state="completed">…</task>'), null)
  assert.equal(taskEnvelopeState('<task id="x" state="running">…</task>'), null)
  assert.equal(taskEnvelopeState("plain text"), null)
  assert.equal(taskEnvelopeState(undefined), null)
})

test("shortDescription flattens newlines and caps length", () => {
  assert.equal(shortDescription("a\nb\tc"), "a b c")
  assert.equal(shortDescription("x".repeat(500), 10).length, 11)
  assert.equal(shortDescription(undefined), "")
})
