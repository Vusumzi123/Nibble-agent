import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_DECISIONS,
  BridgeDecisionProvider,
  RulesProvider,
  buildDecisionsLogEntry,
  buildIngestRequest,
  buildTriageRequest,
  createDecisionProvider,
  decideWithFallback,
  isGateSkip,
  parseDecisionsConfig,
  type DecisionResult,
} from "./decisions.ts"

const TRIVIAL =
  "<!-- turn: 1 -->\n\n## User\n\nthanks!\n\n## Assistant\n\nyou're welcome\n"
const DURABLE =
  "<!-- turn: 1 -->\n\n## User\n\nok\n\n## Assistant\n\nWe decided to always use fish\n"

// ---------------------------------------------------------------------------
// Config

test("parseDecisionsConfig reads a full block with typed scalars", () => {
  const cfg = parseDecisionsConfig(
    [
      "decisions:",
      "  enabled: true",
      "  mode: gate",
      "  provider: deepseek",
      "  backend: llamacpp",
      "  temperature_scaling: 1.30",
      "  abstain_threshold: 0.5",
      "  noul_threshold: 0.9",
      "  timeout_ms: 8000",
      "  n_probs: 8",
      "  ledger: custom.log",
      "  log_rotate_bytes: 2048",
      "",
      "mail:",
      "  enabled: true",
    ].join("\n"),
  )
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.mode, "gate")
  assert.equal(cfg.provider, "deepseek")
  assert.equal(cfg.temperature_scaling, 1.3)
  assert.equal(cfg.abstain_threshold, 0.5)
  assert.equal(cfg.timeout_ms, 8000)
  assert.equal(cfg.n_probs, 8)
  assert.equal(cfg.ledger, "custom.log")
  assert.equal(cfg.log_rotate_bytes, 2048)
})

test("parseDecisionsConfig ignores unknown keys, comments and other sections", () => {
  const cfg = parseDecisionsConfig(
    ["decisions:", "  nonsense: 1", "  enabled: true  # inline", "other:", "  enabled: nope"].join("\n"),
  )
  assert.equal(cfg.enabled, true)
  assert.equal((cfg as Record<string, unknown>).nonsense, undefined)
})

test("parseDecisionsConfig returns empty object when section missing", () => {
  assert.deepEqual(parseDecisionsConfig("mail:\n  enabled: false\n"), {})
})

test("DEFAULT_DECISIONS ships shadow-only and disabled", () => {
  assert.equal(DEFAULT_DECISIONS.enabled, false)
  assert.equal(DEFAULT_DECISIONS.mode, "shadow")
  assert.equal(DEFAULT_DECISIONS.provider, "openjev")
  assert.equal(DEFAULT_DECISIONS.fallback, "rules")
  assert.equal(DEFAULT_DECISIONS.ledger, "decisions.log")
  assert.ok(DEFAULT_DECISIONS.log_rotate_bytes > 0)
})

test("parseDecisionsConfig reads the opencode model spec and override keys", () => {
  const cfg = parseDecisionsConfig(
    [
      "decisions:",
      "  provider: openjev",
      "  model: deepseek/deepseek-chat",
      "  api_provider: custom",
      "  auth_file: /tmp/auth.json",
      "  models_file: /tmp/models.json",
      "",
      "retrieval:",
      "  enabled: true",
    ].join("\n"),
  )
  assert.equal(cfg.provider, "openjev")
  assert.equal(cfg.model, "deepseek/deepseek-chat")
  assert.equal(cfg.api_provider, "custom")
  assert.equal(cfg.auth_file, "/tmp/auth.json")
  assert.equal(cfg.models_file, "/tmp/models.json")
})

test("DEFAULT_DECISIONS defaults to the opencode-linked model, no forced backend", () => {
  assert.equal(DEFAULT_DECISIONS.model, "deepseek/deepseek-chat")
  assert.equal(DEFAULT_DECISIONS.backend, "")
  assert.equal(DEFAULT_DECISIONS.base_url, "")
  assert.equal(DEFAULT_DECISIONS.api_provider, "")
  assert.equal(DEFAULT_DECISIONS.auth_file, "")
  assert.equal(DEFAULT_DECISIONS.models_file, "")
})

// ---------------------------------------------------------------------------
// Triage request

test("buildTriageRequest emits a noul request with the shared assertion", () => {
  const req = buildTriageRequest(TRIVIAL, 800)
  assert.equal(req.kind, "noul")
  assert.equal(req.state, TRIVIAL)
  assert.equal(req.allow_abstain, false)
  assert.equal(req.triage, true)
  assert.equal(req.maxBytes, 800)
  assert.ok(req.assertion)
})

test("buildIngestRequest emits the per-turn memory-gate noul request", () => {
  const req = buildIngestRequest("just a single turn", 800)
  assert.equal(req.kind, "noul")
  assert.equal(req.state, "just a single turn")
  assert.equal(req.allow_abstain, false)
  assert.equal(req.triage, true)
  assert.equal(req.maxBytes, 800)
  // The memory gate uses the inverted ("no durable knowledge") assertion.
  assert.match(String(req.assertion), /no durable knowledge/i)
})

// ---------------------------------------------------------------------------
// RulesProvider

test("RulesProvider maps the triage noul to classifyTranscript", async () => {
  const rules = new RulesProvider()
  const trivial = await rules.decide(buildTriageRequest(TRIVIAL, 800))
  assert.equal(trivial.value, true)
  assert.equal(trivial.confidence, 1)
  assert.equal(trivial.abstained, false)
  assert.equal(trivial.provider, "rules")

  const durable = await rules.decide(buildTriageRequest(DURABLE, 800))
  assert.equal(durable.value, false)
  assert.equal(durable.probabilities.false, 1)
})

test("RulesProvider abstains on anything but the triage noul", async () => {
  const rules = new RulesProvider()
  const res = await rules.decide({ kind: "choice", state: "x", candidates: ["A", "B"] })
  assert.equal(res.abstained, true)
  assert.equal(res.value, null)
  assert.equal(res.confidence, 0)
})

// ---------------------------------------------------------------------------
// Bridge provider

function bridgeSuccess(result: Record<string, unknown>) {
  return async () => ({ code: 0, stdout: JSON.stringify(result), stderr: "" })
}

test("BridgeDecisionProvider parses a valid result and strips TS-only fields", async () => {
  let received = ""
  const provider = new BridgeDecisionProvider({
    configPath: "/x/sysop-config.yaml",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: async (args) => {
      received = args.request
      return { code: 0, stdout: JSON.stringify({ kind: "noul", value: true, confidence: 0.93, probabilities: { true: 0.93, false: 0.07 }, abstained: false, provider: "openjev", backend: "llamacpp", latencyMs: 128 }), stderr: "" }
    },
  })
  const res = await provider.decide(buildTriageRequest(TRIVIAL, 800))
  assert.equal(res.value, true)
  assert.equal(res.confidence, 0.93)
  assert.equal(res.abstained, false)
  assert.equal(res.provider, "openjev")
  assert.ok(!received.includes("triage"))
  assert.ok(!received.includes("maxBytes"))
  assert.ok(received.includes("assertion"))
})

test("BridgeDecisionProvider fail-opens on non-zero exit", async () => {
  const provider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: async () => ({ code: 1, stdout: "", stderr: "upstream down" }),
  })
  const res = await provider.decide(buildTriageRequest(TRIVIAL))
  assert.equal(res.abstained, true)
  assert.equal(res.value, null)
  assert.ok(res.error)
})

test("BridgeDecisionProvider fail-opens on invalid JSON", async () => {
  const provider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: async () => ({ code: 0, stdout: "not json", stderr: "" }),
  })
  const res = await provider.decide(buildTriageRequest(TRIVIAL))
  assert.equal(res.abstained, true)
  assert.equal(res.value, null)
})

test("BridgeDecisionProvider rejects a null value shape", async () => {
  const provider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: bridgeSuccess({ kind: "noul", value: null, confidence: 0, abstained: true }),
  })
  const res = await provider.decide(buildTriageRequest(TRIVIAL))
  assert.equal(res.abstained, true)
})

// ---------------------------------------------------------------------------
// Fallback

test("decideWithFallback uses a usable provider result without falling back", async () => {
  const provider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: bridgeSuccess({ kind: "noul", value: false, confidence: 0.9, abstained: false, probabilities: { true: 0.1, false: 0.9 } }),
  })
  const { result, fallback } = await decideWithFallback(provider, buildTriageRequest(DURABLE), new RulesProvider())
  assert.equal(fallback, false)
  assert.equal(result.value, false)
  assert.equal(result.backend, "llamacpp")
})

test("decideWithFallback falls back to rules on error", async () => {
  const provider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: async () => ({ code: 1, stdout: "", stderr: "boom" }),
  })
  const { result, fallback } = await decideWithFallback(provider, buildTriageRequest(TRIVIAL), new RulesProvider())
  assert.equal(fallback, true)
  assert.equal(result.provider, "rules")
  assert.equal(result.value, true)
  assert.ok(result.error)
})

test("decideWithFallback falls back to rules when the provider abstains", async () => {
  const provider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: bridgeSuccess({ kind: "noul", value: null, abstained: true, confidence: 0 }),
  })
  const { result, fallback } = await decideWithFallback(provider, buildTriageRequest(TRIVIAL), new RulesProvider())
  assert.equal(fallback, true)
  assert.equal(result.provider, "rules")
})

test("decideWithFallback reports fallbackReason and preserves provider telemetry", async () => {
  const errorProvider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: async () => ({ code: 1, stdout: "", stderr: "down" }),
  })
  const errRes = await decideWithFallback(errorProvider, buildTriageRequest(TRIVIAL), new RulesProvider())
  assert.equal(errRes.fallbackReason, "error")

  const abstainProvider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: bridgeSuccess({ kind: "noul", value: null, abstained: true, confidence: 0, usage: { promptTokens: 7, completionTokens: 1, totalTokens: 8, usageKnown: true } }),
  })
  const absRes = await decideWithFallback(abstainProvider, buildTriageRequest(TRIVIAL), new RulesProvider())
  assert.equal(absRes.fallbackReason, "abstain")
  assert.equal(absRes.result.provider, "rules")
  assert.equal(absRes.result.usage?.totalTokens, 8)
  assert.ok(typeof absRes.result.wallMs === "number")

  const okProvider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: bridgeSuccess({ kind: "noul", value: false, confidence: 0.9, abstained: false }),
  })
  const okRes = await decideWithFallback(okProvider, buildTriageRequest(DURABLE), new RulesProvider())
  assert.equal(okRes.fallbackReason, "none")
})

test("BridgeDecisionProvider preserves model and usage from a valid bridge result", async () => {
  const provider = new BridgeDecisionProvider({
    configPath: "/x",
    backend: "llamacpp",
    timeoutMs: 5000,
    spawner: bridgeSuccess({
      kind: "noul",
      value: true,
      confidence: 0.91,
      abstained: false,
      probabilities: { true: 0.91, false: 0.09 },
      model: "some-model",
      usage: { promptTokens: 40, completionTokens: 1, totalTokens: 41, promptMs: 12.5, usageKnown: true },
      latencyMs: 33,
    }),
  })
  const res = await provider.decide(buildTriageRequest(TRIVIAL))
  assert.equal(res.model, "some-model")
  assert.equal(res.usage?.totalTokens, 41)
  assert.equal(res.usage?.promptMs, 12.5)
  assert.ok(typeof res.wallMs === "number")
})

// ---------------------------------------------------------------------------
// Registry

test("createDecisionProvider returns a RulesProvider for provider: rules", () => {
  const provider = createDecisionProvider({ ...DEFAULT_DECISIONS, provider: "rules" }, { configPath: "/x" })
  assert.ok(provider instanceof RulesProvider)
})

test("createDecisionProvider returns a bridge provider otherwise", () => {
  const provider = createDecisionProvider({ ...DEFAULT_DECISIONS, provider: "openjev" }, { configPath: "/x" })
  assert.ok(provider instanceof BridgeDecisionProvider)
})

// ---------------------------------------------------------------------------
// Gate predicate (P5)

const GATE_RESULT = (over: Partial<DecisionResult>): DecisionResult => ({
  kind: "noul",
  value: true,
  confidence: 0.9,
  probabilities: { true: 0.9, false: 0.1 },
  abstained: false,
  provider: "openjev",
  backend: "llamacpp",
  latencyMs: 10,
  ...over,
})

test("isGateSkip returns true for a confident non-fallback 'trivial' verdict", () => {
  assert.equal(isGateSkip(GATE_RESULT({}), false, 0.8), true)
})

test("isGateSkip rejects a verdict below the noul threshold", () => {
  assert.equal(
    isGateSkip(GATE_RESULT({ confidence: 0.5, probabilities: { true: 0.5, false: 0.5 } }), false, 0.8),
    false,
  )
})

test("isGateSkip rejects a fallback or abstained result (fail-open)", () => {
  assert.equal(isGateSkip(GATE_RESULT({}), true, 0.8), false)
  assert.equal(isGateSkip(GATE_RESULT({ abstained: true, value: null }), false, 0.8), false)
})

test("isGateSkip rejects a 'durable' (value=false) verdict", () => {
  assert.equal(
    isGateSkip(GATE_RESULT({ value: false, probabilities: { true: 0.05, false: 0.95 } }), false, 0.8),
    false,
  )
})

test("isGateSkip rejects when the true probability is absent", () => {
  assert.equal(isGateSkip(GATE_RESULT({ probabilities: {} }), false, 0.8), false)
})

// ---------------------------------------------------------------------------
// Ledger

test("buildDecisionsLogEntry carries the plan §7 schema", () => {
  const entry = buildDecisionsLogEntry({
    session: "ses_abc",
    result: {
      kind: "noul",
      value: true,
      confidence: 0.93,
      probabilities: { true: 0.93, false: 0.07 },
      abstained: false,
      provider: "openjev",
      backend: "llamacpp",
      latencyMs: 128,
    },
    rulesVerdict: { skip: false, reason: "durable-signal" },
    fallback: false,
  })
  assert.equal(entry.session, "ses_abc")
  assert.equal(entry.provider, "openjev")
  assert.equal(entry.backend, "llamacpp")
  assert.equal(entry.kind, "noul")
  assert.equal(entry.value, true)
  assert.equal(entry.confidence, 0.93)
  assert.equal(entry.fallback, false)
  assert.equal(entry.eventualOutcome, null)
  assert.deepEqual(entry.rulesVerdict, { skip: false, reason: "durable-signal" })
  assert.ok(entry.ts)
})

test("buildDecisionsLogEntry carries traceability fields (model/mode/tokens/wallMs/fallbackReason)", () => {
  const entry = buildDecisionsLogEntry({
    session: "ses_xyz",
    result: {
      kind: "noul",
      value: false,
      confidence: 0.88,
      probabilities: { true: 0.12, false: 0.88 },
      abstained: false,
      provider: "openjev",
      backend: "llamacpp",
      latencyMs: 96,
      model: "Ternary-Bonsai-2-27B-PQ2_0",
      usage: {
        promptTokens: 102,
        completionTokens: 1,
        totalTokens: 103,
        promptMs: 84.2,
        promptTokensPerSecond: 1211.4,
        usageKnown: true,
      },
      wallMs: 180,
    },
    rulesVerdict: { skip: false, reason: "durable-signal" },
    fallback: true,
    fallbackReason: "abstain",
    mode: "gate",
  })
  assert.equal(entry.model, "Ternary-Bonsai-2-27B-PQ2_0")
  assert.equal(entry.mode, "gate")
  assert.equal(entry.wallMs, 180)
  assert.equal(entry.promptTokens, 102)
  assert.equal(entry.completionTokens, 1)
  assert.equal(entry.totalTokens, 103)
  assert.equal(entry.promptMs, 84.2)
  assert.equal(entry.promptTokensPerSecond, 1211.4)
  assert.equal(entry.usageKnown, true)
  assert.equal(entry.fallbackReason, "abstain")
})

test("buildDecisionsLogEntry leaves token fields null when usage is absent", () => {
  const entry = buildDecisionsLogEntry({
    session: "ses_abc",
    result: {
      kind: "noul",
      value: true,
      confidence: 1,
      probabilities: { true: 1, false: 0 },
      abstained: false,
      provider: "rules",
      backend: "rules",
      latencyMs: 0,
    },
    rulesVerdict: { skip: true, reason: "trivial-chatter" },
    fallback: false,
  })
  assert.equal(entry.promptTokens, null)
  assert.equal(entry.totalTokens, null)
  assert.equal(entry.usageKnown, false)
  assert.equal(entry.fallbackReason, "none")
})
