import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_RETRIEVAL,
  DEFAULT_RETRIEVAL_ASSERTION,
  DEFAULT_RETRIEVAL_PROMPTS,
  RETRIEVAL_INTENT_PATTERNS,
  buildRetrievalDirective,
  buildRetrievalLogEntry,
  buildRetrievalRequest,
  capBytes,
  evaluateRetrieval,
  hasRetrievalIntent,
  parseRetrievalConfig,
  parseRetrievalPrompts,
  readRetrievalConfig,
  readRetrievalPrompts,
} from "./retrieval.ts"
import type { DecisionResult } from "./decisions.ts"
import { writeSection } from "./test-utils.ts"

function result(over: Partial<DecisionResult> = {}): DecisionResult {
  return {
    kind: "noul",
    value: true,
    confidence: 0.95,
    probabilities: { true: 0.95, false: 0.05 },
    abstained: false,
    provider: "openjev",
    backend: "deepseek",
    latencyMs: 12,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Config

test("parseRetrievalConfig reads a full block with typed scalars", () => {
  const cfg = parseRetrievalConfig(
    [
      "retrieval:",
      "  enabled: true",
      "  gate: false",
      "  noul_threshold: 0.9",
      "  timeout_ms: 8000",
      "  max_bytes: 2000",
      "  force_intent: false",
      "  inject: true",
      "  prompts_file: .opencode/custom.json",
      "  log: custom-retrieval.log",
      "  log_rotate_bytes: 2048",
      "",
      "mail:",
      "  enabled: true",
    ].join("\n"),
  )
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.gate, false)
  assert.equal(cfg.noul_threshold, 0.9)
  assert.equal(cfg.timeout_ms, 8000)
  assert.equal(cfg.max_bytes, 2000)
  assert.equal(cfg.force_intent, false)
  assert.equal(cfg.inject, true)
  assert.equal(cfg.prompts_file, ".opencode/custom.json")
  assert.equal(cfg.log, "custom-retrieval.log")
  assert.equal(cfg.log_rotate_bytes, 2048)
})

test("parseRetrievalConfig ignores unknown keys and other sections", () => {
  const cfg = parseRetrievalConfig(
    ["retrieval:", "  nonsense: 1", "  enabled: true  # inline", "browser:", "  enabled: nope"].join("\n"),
  )
  assert.equal(cfg.enabled, true)
  assert.equal((cfg as Record<string, unknown>).nonsense, undefined)
})

test("parseRetrievalConfig returns empty object when section is missing", () => {
  assert.deepEqual(parseRetrievalConfig("mail:\n  enabled: false\n"), {})
})

test("DEFAULT_RETRIEVAL is enabled, gated, and fail-closed-biased", () => {
  assert.equal(DEFAULT_RETRIEVAL.enabled, true)
  assert.equal(DEFAULT_RETRIEVAL.gate, true)
  assert.equal(DEFAULT_RETRIEVAL.force_intent, true)
  assert.equal(DEFAULT_RETRIEVAL.inject, true)
  assert.equal(DEFAULT_RETRIEVAL.log, "retrieval.log")
})

test("readRetrievalConfig overlays the block and clamps a bad threshold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retrieval-cfg-"))
  await writeSection(dir, "retrieval", ["noul_threshold: 4.2", "max_bytes: 1234"])
  const cfg = await readRetrievalConfig(dir)
  assert.equal(cfg.noul_threshold, DEFAULT_RETRIEVAL.noul_threshold)
  assert.equal(cfg.max_bytes, 1234)
})

test("readRetrievalConfig returns defaults for a missing config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retrieval-cfg-none-"))
  const cfg = await readRetrievalConfig(dir)
  assert.deepEqual(cfg, DEFAULT_RETRIEVAL)
})

// ---------------------------------------------------------------------------
// Prose prior (prompts file)

test("parseRetrievalPrompts accepts a non-empty assertion and rejects the rest", () => {
  assert.deepEqual(parseRetrievalPrompts({ assertion: " hello " }), { assertion: " hello " })
  assert.equal(parseRetrievalPrompts({ assertion: "   " }), null)
  assert.equal(parseRetrievalPrompts({}), null)
  assert.equal(parseRetrievalPrompts(null), null)
  assert.equal(parseRetrievalPrompts("assertion"), null)
})

test("readRetrievalPrompts returns null for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retrieval-prompts-"))
  assert.equal(await readRetrievalPrompts(join(dir, "nope.json")), null)
})

test("the built-in assertion is the prose prior and defaults to TRUE", () => {
  assert.match(DEFAULT_RETRIEVAL_ASSERTION, /default is TRUE/i)
  assert.equal(DEFAULT_RETRIEVAL_PROMPTS.assertion, DEFAULT_RETRIEVAL_ASSERTION)
})

// ---------------------------------------------------------------------------
// Deterministic intent override

test("hasRetrievalIntent fires on explicit vault/notes/memory phrasing", () => {
  assert.equal(hasRetrievalIntent("can you search my notes for the WAL setup"), true)
  assert.equal(hasRetrievalIntent("do you remember the himalaya config"), true)
  assert.equal(hasRetrievalIntent("according to my notes we used btrfs"), true)
  assert.equal(hasRetrievalIntent("check the brain for the audit policy"), true)
})

test("hasRetrievalIntent stays quiet on ordinary requests", () => {
  assert.equal(hasRetrievalIntent("install htop"), false)
  assert.equal(hasRetrievalIntent("what do we need to implement a similar model"), false)
  assert.equal(hasRetrievalIntent("explain how the JEV gate works"), false)
})

test("every intent pattern is a valid global regex", () => {
  for (const re of RETRIEVAL_INTENT_PATTERNS) assert.ok(re instanceof RegExp)
})

// ---------------------------------------------------------------------------
// Request + evaluation (fail-closed)

test("buildRetrievalRequest emits an abstain-able noul with a capped state", () => {
  const req = buildRetrievalRequest("x".repeat(100), "assertion-here", 10)
  assert.equal(req.kind, "noul")
  assert.equal(req.assertion, "assertion-here")
  assert.equal(req.allow_abstain, true)
  assert.equal(req.state, "x".repeat(10))
})

test("evaluateRetrieval skips only on a confident non-failure TRUE", () => {
  assert.deepEqual(evaluateRetrieval(result(), 0.8), { skip: true, reason: "confident-skip" })
})

test("evaluateRetrieval retrieves when the model says retrieval is needed", () => {
  assert.deepEqual(evaluateRetrieval(result({ value: false, probabilities: { true: 0.1, false: 0.9 } }), 0.8), {
    skip: false,
    reason: "retrieve",
  })
})

test("evaluateRetrieval retrieves when a TRUE verdict is below threshold", () => {
  assert.deepEqual(evaluateRetrieval(result({ probabilities: { true: 0.5, false: 0.5 } }), 0.8), {
    skip: false,
    reason: "low-confidence",
  })
})

test("evaluateRetrieval fails closed on error, abstain, and bad shape", () => {
  assert.deepEqual(evaluateRetrieval(result({ error: "boom" }), 0.8), { skip: true, reason: "error" })
  assert.deepEqual(evaluateRetrieval(result({ abstained: true }), 0.8), { skip: true, reason: "abstain" })
  assert.deepEqual(evaluateRetrieval(result({ value: null }), 0.8), { skip: true, reason: "shape" })
  assert.deepEqual(evaluateRetrieval(result({ probabilities: {} }), 0.8), {
    skip: false,
    reason: "low-confidence",
  })
})

// ---------------------------------------------------------------------------
// Directive + ledger

test("buildRetrievalDirective emits an authoritative SKIP or RETRIEVE block", () => {
  const skip = buildRetrievalDirective({ skip: true, reason: "confident-skip", pTrue: 0.93 })
  assert.match(skip, /\[brain-first: SKIP\]/)
  assert.match(skip, /authoritative for this turn/)
  assert.match(skip, /p=0\.930/)

  const retrieve = buildRetrievalDirective({ skip: false, reason: "intent", pTrue: null })
  assert.match(retrieve, /\[brain-first: RETRIEVE\]/)
  assert.match(retrieve, /p=n\/a/)
  // The directive carries the full protocol (template + result handling) so
  // AGENTS.md does not have to (hook-enforced, paid only on RETRIEVE turns).
  assert.match(retrieve, /Delegate with exactly: "rag-search: <user message verbatim>"/)
  assert.match(retrieve, /read <= 3 notes/)
  assert.match(retrieve, /Surface the hits first/)
  assert.match(retrieve, /No relevant vault knowledge found/)
})

test("buildRetrievalLogEntry records the verdict, mode, and usage", () => {
  const entry = buildRetrievalLogEntry({
    session: "ses_1",
    gate: { skip: true, reason: "confident-skip" },
    result: result({ wallMs: 42, usage: { promptTokens: 1500, completionTokens: 2, totalTokens: 1502, usageKnown: true } }),
    intent: false,
    mode: "gate",
  })
  assert.equal(entry.session, "ses_1")
  assert.equal(entry.mode, "gate")
  assert.equal(entry.skip, true)
  assert.equal(entry.retrieve, false)
  assert.equal(entry.reason, "confident-skip")
  assert.equal(entry.pTrue, 0.95)
  assert.equal(entry.promptTokens, 1500)
})

test("buildRetrievalLogEntry marks an intent override as a retrieve", () => {
  const entry = buildRetrievalLogEntry({
    session: "ses_1",
    gate: { skip: false, reason: "intent" },
    result: null,
    intent: true,
    mode: "gate",
  })
  assert.equal(entry.retrieve, true)
  assert.equal(entry.reason, "intent")
  assert.equal(entry.value, null)
})

// ---------------------------------------------------------------------------
// capBytes

test("capBytes truncates to a UTF-8 boundary without replacement characters", () => {
  const text = "á".repeat(10)
  assert.equal(Buffer.byteLength(text, "utf8"), 20)
  const capped = capBytes(text, 5)
  assert.ok(Buffer.byteLength(capped, "utf8") <= 5)
  assert.doesNotMatch(capped, /\uFFFD/)
})

test("capBytes leaves a short string untouched", () => {
  assert.equal(capBytes("hello", 100), "hello")
})
