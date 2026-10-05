// Per-turn Self-RAG-style retrieval gate (docs/jev-decision-provider-plan.md
// adjacent; Brain-first protocol, AGENTS.md §0).
//
// Every user turn is asked one `noul` question — "this message is self-contained
// and needs no vault search" — through the same typed-decision provider the
// drain/profile gates use (lib/decisions.ts). A confident, non-failure "true"
// suppresses the Brain-First rag-search delegation for that turn and injects an
// authoritative [brain-first] directive into the system prompt.
//
// Polarity + failure policy are the whole design:
//
//   value === true  && pTrue >= threshold   -> SKIP   (retrieval unnecessary)
//   value === false                         -> RETRIEVE
//   error | abstain | non-boolean           -> SKIP   (FAIL-CLOSED)
//
// Fail-closed is the deliberate inversion of the drain gate (`isGateSkip`, which
// fail-opens so knowledge is never lost). Here the resource being protected is
// tokens, not notes, so an outage degrades to "answer from scratch". The
// deterministic `hasRetrievalIntent` override runs first and always retrieves,
// so an explicit "search my notes" can never be mis-skipped by the model.
//
// The prose prior (the assertion in `retrieval-prompts.json`) is weighted toward
// "do not retrieve"; it is externalized so the economy/accuracy balance is
// tunable without touching the TS.
//
// Loaded via relative import only (same convention as the other lib files).
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { expandHome } from "./paths.ts"
import type { DecisionRequest, DecisionResult } from "./decisions.ts"

// ---------------------------------------------------------------------------
// Config

export type RetrievalConfig = {
  enabled: boolean
  gate: boolean
  noul_threshold: number
  timeout_ms: number
  max_bytes: number
  force_intent: boolean
  inject: boolean
  prompts_file: string
  log: string
  log_rotate_bytes: number
  log_keep_generations: number
  log_retention_days: number
  log_compress: boolean
  log_compress_after: number
  log_compress_level: number
  log_rotate_by: string
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  enabled: true,
  gate: true,
  noul_threshold: 0.8,
  timeout_ms: 30000,
  max_bytes: 4000,
  force_intent: true,
  inject: true,
  prompts_file: ".opencode/retrieval-prompts.json",
  log: "retrieval.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_RETRIEVAL))
const BOOL_KEYS = new Set(["enabled", "gate", "force_intent", "inject", "log_compress"])
const INT_KEYS = new Set([
  "timeout_ms",
  "max_bytes",
  "log_rotate_bytes",
  "log_keep_generations",
  "log_retention_days",
  "log_compress_after",
  "log_compress_level",
])
const FLOAT_KEYS = new Set(["noul_threshold"])

const RETRIEVAL_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  floats: FLOAT_KEYS,
  stringMode: "pair-quotes",
})

// Parse a `retrieval:` block out of sysop-config.yaml text. Only flat `key:
// value` scalars are supported. Unrecognized keys are ignored.
export function parseRetrievalConfig(yamlText: string): Partial<RetrievalConfig> {
  return parseFlatBlock(yamlText, "retrieval", {
    knownKeys: KNOWN_KEYS,
    coerce: RETRIEVAL_COERCE,
  }) as Partial<RetrievalConfig>
}

// Read the effective `retrieval:` config for a project directory, overlaying the
// block on the defaults. Never throws: a missing or malformed config yields the
// defaults.
export async function readRetrievalConfig(directory: string): Promise<RetrievalConfig> {
  const cfg = await readSection(directory, "retrieval", DEFAULT_RETRIEVAL, {
    coerce: RETRIEVAL_COERCE,
  })
  if (!Number.isFinite(cfg.noul_threshold) || cfg.noul_threshold < 0 || cfg.noul_threshold > 1) {
    cfg.noul_threshold = DEFAULT_RETRIEVAL.noul_threshold
  }
  if (!Number.isFinite(cfg.timeout_ms) || cfg.timeout_ms <= 0) {
    cfg.timeout_ms = DEFAULT_RETRIEVAL.timeout_ms
  }
  if (!Number.isFinite(cfg.max_bytes) || cfg.max_bytes <= 0) {
    cfg.max_bytes = DEFAULT_RETRIEVAL.max_bytes
  }
  if (typeof cfg.prompts_file !== "string" || !cfg.prompts_file.trim()) {
    cfg.prompts_file = DEFAULT_RETRIEVAL.prompts_file
  }
  if (typeof cfg.log !== "string" || !cfg.log.trim()) cfg.log = DEFAULT_RETRIEVAL.log
  return cfg
}

// ---------------------------------------------------------------------------
// Externalized prose prior (`.opencode/retrieval-prompts.json`)

// Built-in fallback. TRUE = no retrieval needed. Weighted toward TRUE on
// purpose: the mandate is inverted (retrieval is opt-in, not default), so the
// model must be pushed off the "always search" prior the old protocol taught.
export const DEFAULT_RETRIEVAL_ASSERTION =
  "The user's message is self-contained and does NOT require a search of the " +
  "vault: it needs no stored note, procedure, configuration, preference, past " +
  "decision, remembered fact, or prior session context. The default is TRUE. " +
  "Answer FALSE only when the message clearly refers to something previously " +
  "documented or remembered, builds on earlier vault knowledge, or explicitly " +
  "asks to search, recall, or remember. When in any doubt, answer TRUE."

export type RetrievalPrompts = { assertion: string }

export const DEFAULT_RETRIEVAL_PROMPTS: RetrievalPrompts = { assertion: DEFAULT_RETRIEVAL_ASSERTION }

// Validate a parsed prompts file: a single non-empty `assertion` string. Returns
// null on any deviation so the caller falls back to the built-in default.
export function parseRetrievalPrompts(json: unknown): RetrievalPrompts | null {
  if (!json || typeof json !== "object") return null
  const assertion = (json as Record<string, unknown>).assertion
  if (typeof assertion !== "string" || !assertion.trim()) return null
  return { assertion }
}

// Read + parse the prompts file. Never throws: a missing/unreadable/malformed
// file yields null and the caller uses the built-in default.
export async function readRetrievalPrompts(file: string): Promise<RetrievalPrompts | null> {
  try {
    return parseRetrievalPrompts(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return null
  }
}

// Resolve the prompts-file leaf. Absolute paths pass through; a leading `~` is
// home-expanded; anything else is project-relative.
export function resolveRetrievalPrompts(directory: string, leaf: string): string {
  const expanded = expandHome(leaf, homedir())
  return isAbsolute(expanded) ? expanded : join(directory, expanded)
}

// ---------------------------------------------------------------------------
// Decision input + evaluation

// Explicit retrieval intent. A deterministic override that runs before the
// model: when the user names the vault/notes/memory and asks to search or
// recall, retrieval is mandatory regardless of the gate verdict.
export const RETRIEVAL_INTENT_PATTERNS: RegExp[] = [
  /\b(?:search|check|look\s*up|find|consult|recall|remember|remind)\b[^.!?]{0,60}\b(?:vault|brain|notes?|memory|memories|journal|diary)\b/i,
  /\b(?:vault|brain|notes?|memory|memories|journal|diary)\b[^.!?]{0,60}\b(?:search|check|look\s*up|find|consult|recall|remember|remind)\b/i,
  /\b(?:what did (?:we|i)|do you remember|according to (?:my|the) (?:notes|vault|brain)|as documented|from (?:my|the) (?:notes|vault|brain)|in my notes)\b/i,
]

export function hasRetrievalIntent(text: string): boolean {
  return RETRIEVAL_INTENT_PATTERNS.some((re) => re.test(text))
}

// Truncate a string to at most `maxBytes` UTF-8 bytes (never splits a codepoint
// in a way that produces replacement characters).
export function capBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8")
  if (buf.byteLength <= maxBytes) return text
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "")
}

// Build the `noul` request: "is this message self-contained?" `allow_abstain`
// is true so a low-confidence backend surfaces as `abstained`, which the gate
// maps to SKIP (fail-closed).
export function buildRetrievalRequest(
  text: string,
  assertion: string,
  maxBytes: number = DEFAULT_RETRIEVAL.max_bytes,
): DecisionRequest {
  return {
    kind: "noul",
    state: capBytes(text, maxBytes),
    assertion,
    allow_abstain: true,
  }
}

export type RetrievalGate = {
  skip: boolean
  reason:
    | "confident-skip"
    | "retrieve"
    | "intent"
    | "low-confidence"
    | "error"
    | "abstain"
    | "shape"
}

// Fail-closed evaluation of the provider result. Exported for tests.
export function evaluateRetrieval(result: DecisionResult, noulThreshold: number): RetrievalGate {
  if (result.error) return { skip: true, reason: "error" }
  if (result.abstained) return { skip: true, reason: "abstain" }
  if (typeof result.value !== "boolean") return { skip: true, reason: "shape" }
  if (result.value !== true) return { skip: false, reason: "retrieve" }
  const pTrue = result.probabilities?.true
  if (typeof pTrue !== "number" || pTrue < noulThreshold) {
    return { skip: false, reason: "low-confidence" }
  }
  return { skip: true, reason: "confident-skip" }
}

// ---------------------------------------------------------------------------
// System-prompt directive

// The per-turn block appended to the system prompt. `gate: false` (shadow)
// never emits a SKIP block — it still records verdicts but leaves the default
// protocol in force.
export function buildRetrievalDirective(input: {
  skip: boolean
  reason: string
  pTrue: number | null
}): string {
  const stats = `reason=${input.reason}, p=${input.pTrue === null ? "n/a" : input.pTrue.toFixed(3)}`
  if (input.skip) {
    return [
      "[brain-first: SKIP] Retrieval gate (authoritative for this turn): a vault search is NOT required. Do NOT delegate a Brain-First rag-search this turn — answer directly from the conversation. If the user explicitly asks you to search their notes, ignore this skip and retrieve.",
      `(${stats})`,
    ].join("\n")
  }
  return [
    "[brain-first: RETRIEVE] Retrieval gate (authoritative for this turn): perform the Brain-First rag-search (rag-search sub-agent) before answering.",
    `(${stats})`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Ledger entry

export function buildRetrievalLogEntry(input: {
  session: string
  gate: RetrievalGate | null
  result: DecisionResult | null
  intent: boolean
  mode: "gate" | "shadow"
}): Record<string, unknown> {
  const r = input.result
  const usage = r?.usage
  return {
    ts: new Date().toISOString(),
    session: input.session,
    event: "retrieval",
    mode: input.mode,
    retrieve: input.gate ? !input.gate.skip : true,
    skip: input.gate ? input.gate.skip : false,
    reason: input.gate?.reason ?? (input.intent ? "intent" : "disabled"),
    intent: input.intent,
    value: r?.value ?? null,
    pTrue: typeof r?.probabilities?.true === "number" ? r.probabilities.true : null,
    confidence: r?.confidence ?? null,
    abstained: r?.abstained ?? null,
    provider: r?.provider ?? null,
    backend: r?.backend ?? null,
    model: r?.model ?? null,
    latencyMs: r?.latencyMs ?? null,
    wallMs: r?.wallMs ?? null,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    error: r?.error ?? null,
  }
}
