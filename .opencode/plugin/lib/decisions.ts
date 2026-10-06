// Config-driven "System 1" decision provider (docs/jev-decision-provider-plan.md).
//
// The TS side only ever speaks `decide(request) → result`; backend swapping is
// Python + YAML only (plan §4). This module owns the config parsing, the
// DecisionProvider registry, the in-process RulesProvider (the current
// `classifyTranscript` behavior), and the subprocess bridge provider that shells
// out to scripts/decisions_bridge.py — a stateless stdin→stdout subprocess, not
// a daemon (plan §5).
//
// Model output is untrusted data: the bridge result is schema-validated and
// never executed. On timeout / error / non-candidate output the provider
// fail-opens to the RulesProvider (plan §10), so the deterministic locks stay
// authoritative.
//
// Loaded via relative import only (same convention as the other lib files).
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import {
  classifyTranscript,
  DEFAULT_CONFIG as DEFAULT_KNOWLEDGE_CONFIG,
  type TriageVerdict,
} from "./knowledge.ts"

export type DecisionKind = "choice" | "noul" | "score"

// Bridge contract (plan §5). `triage` and `maxBytes` are TS-only routing fields
// stripped before the request crosses the subprocess boundary.
export type DecisionRequest = {
  kind: DecisionKind
  state: unknown
  candidates?: string[]
  criteria?: string
  assertion?: string
  allow_abstain?: boolean
  prompt?: string
  instructions?: string
  triage?: boolean
  maxBytes?: number
}

// Backend-agnostic token/timing counters, normalized from the bridge's
// `usage` object (llama.cpp now, DeepSeek / hosted-Jev later — same
// OpenAI-compatible shape). Absent when the backend exposes nothing usable.
export type DecisionUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  promptMs?: number
  promptTokensPerSecond?: number
  usageKnown: boolean
}

export type DecisionResult = {
  kind: DecisionKind
  value: unknown
  confidence: number
  probabilities: Record<string, number>
  abstained: boolean
  provider: string
  backend: string
  latencyMs: number
  model?: string
  usage?: DecisionUsage
  wallMs?: number
  error?: string
}

export interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResult>
}

// ---------------------------------------------------------------------------
// Config

export type DecisionsConfig = {
  enabled: boolean
  mode: "shadow" | "gate"
  provider: string
  backend: string
  transport: string
  base_url: string
  model: string
  api_key_file: string
  temperature_scaling: number
  abstain_threshold: number
  noul_threshold: number
  timeout_ms: number
  n_probs: number
  fallback: string
  ledger: string
  log_rotate_bytes: number
  log_keep_generations: number
  log_retention_days: number
  log_compress: boolean
  log_compress_after: number
  log_compress_level: number
  log_rotate_by: string
}

export const DEFAULT_DECISIONS: DecisionsConfig = {
  enabled: false,
  mode: "shadow",
  provider: "openjev",
  backend: "llamacpp",
  transport: "chat",
  base_url: "http://127.0.0.1:8090",
  model: "",
  api_key_file: "",
  temperature_scaling: 1.0,
  abstain_threshold: 0.45,
  noul_threshold: 0.8,
  timeout_ms: 30000,
  n_probs: 20,
  fallback: "rules",
  ledger: "decisions.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_DECISIONS))
const BOOL_KEYS = new Set(["enabled", "log_compress"])
const INT_KEYS = new Set([
  "timeout_ms",
  "n_probs",
  "log_rotate_bytes",
  "log_keep_generations",
  "log_retention_days",
  "log_compress_after",
  "log_compress_level",
])
const FLOAT_KEYS = new Set(["temperature_scaling", "abstain_threshold", "noul_threshold"])

const DECISIONS_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  floats: FLOAT_KEYS,
  stringMode: "pair-quotes",
})

// Parse a `decisions:` block out of sysop-config.yaml text. Only flat `key:
// value` scalars are supported. Unrecognized keys are ignored.
export function parseDecisionsConfig(yamlText: string): Partial<DecisionsConfig> {
  return parseFlatBlock(yamlText, "decisions", {
    knownKeys: KNOWN_KEYS,
    coerce: DECISIONS_COERCE,
  }) as Partial<DecisionsConfig>
}

// Read the effective `decisions:` config for a project directory, overlaying the
// block on the defaults. Never throws: a missing or malformed config yields the
// defaults.
export async function readDecisionsConfig(directory: string): Promise<DecisionsConfig> {
  const cfg = await readSection(directory, "decisions", DEFAULT_DECISIONS, {
    coerce: DECISIONS_COERCE,
  })
  if (cfg.mode !== "gate") cfg.mode = "shadow"
  if (typeof cfg.provider !== "string" || !cfg.provider.trim()) cfg.provider = DEFAULT_DECISIONS.provider
  if (typeof cfg.backend !== "string" || !cfg.backend.trim()) cfg.backend = DEFAULT_DECISIONS.backend
  if (!Number.isFinite(cfg.timeout_ms) || cfg.timeout_ms <= 0) cfg.timeout_ms = DEFAULT_DECISIONS.timeout_ms
  if (!Number.isFinite(cfg.temperature_scaling) || cfg.temperature_scaling <= 0) {
    cfg.temperature_scaling = DEFAULT_DECISIONS.temperature_scaling
  }
  if (typeof cfg.ledger !== "string" || !cfg.ledger.trim()) cfg.ledger = DEFAULT_DECISIONS.ledger
  return cfg
}

// ---------------------------------------------------------------------------
// Triage decision (the first consumer — knowledge-hook skip-triage, shadow mode)

// The exact noul assertion used by the local model, shared with
// openjevserver.py's selftest cases.
export const TRIAGE_ASSERTION =
  "The transcript is pure filler with no durable signal, decision, config, command, or question."

// Build the noul request the provider answers for skip-triage: "is this
// transcript trivial chatter (safe to skip)?" `state` is the raw transcript
// text; `maxBytes` is the knowledge `skip_triage_max_bytes` the deterministic
// RulesProvider applies.
export function buildTriageRequest(content: string, maxBytes?: number): DecisionRequest {
  return {
    kind: "noul",
    state: content,
    assertion: TRIAGE_ASSERTION,
    allow_abstain: false,
    triage: true,
    maxBytes,
  }
}

// The noul assertion used by the per-turn memory ingestion gate
// (docs/temporal-memory-plan.md §7.3). A turn is dropped only when the model
// confidently answers "true" (no durable knowledge); every other outcome keeps
// it for ingestion — the memory gate is fail-OPEN (the opposite of the
// retrieval gate's fail-closed skip).
export const INGEST_ASSERTION =
  "This turn carries no durable knowledge worth remembering (it is trivial chatter, already documented, or a one-off with no lasting value)."

// Build the noul request for one captured turn's ingest gate. `triage: true`
// routes the deterministic RulesProvider fallback to the conservative
// `classifyTranscript`, which (for a marker-less single turn) keeps the turn.
// `assertion` overrides the question text; the hook passes the value loaded
// from `.opencode/decision-prompts.yaml` (defaults here remain the fallback
// for callers that pass nothing).
export function buildIngestRequest(
  content: string,
  maxBytes?: number,
  assertion: string = INGEST_ASSERTION,
): DecisionRequest {
  return {
    kind: "noul",
    state: content,
    assertion,
    allow_abstain: false,
    triage: true,
    maxBytes,
  }
}

// Build the `choice` request for the capture-time tag gate: pick one candidate
// tag (or NEW when none fit). Moved out of knowledge-hook as part of the
// decision-gate seam so every request literal lives beside the others.
export function buildTagChoiceRequest(
  content: string,
  candidates: string[],
  criteria: string,
): DecisionRequest {
  return {
    kind: "choice",
    state: content,
    candidates,
    criteria,
  }
}

// Build the `score` request for the capture-time salience gate (1-5 ordinal).
export function buildSalienceRequest(content: string, criteria: string): DecisionRequest {
  return {
    kind: "score",
    state: content,
    criteria,
  }
}

// Gate-mode predicate (plan §12 P5). Mirrors eval_decisions.py `gated_skip`:
// a session is skipped by the model only when the provider answered "trivial"
// (value === true) without falling back or abstaining, and its probability of
// "true" clears the noul threshold. Every other outcome falls through to the
// deterministic drain. Fail-open by construction — a fallback/abstain/error
// never skips.
export function isGateSkip(
  result: DecisionResult,
  fallback: boolean,
  noulThreshold: number,
): boolean {
  if (fallback || result.abstained) return false
  if (result.value !== true) return false
  const pTrue = result.probabilities?.true
  return typeof pTrue === "number" && pTrue >= noulThreshold
}

// ---------------------------------------------------------------------------
// RulesProvider (current behavior, in-process)

// The deterministic `classifyTranscript` heuristic, surfaced as a
// DecisionProvider. It answers only the triage noul question (the "current
// behavior" it replaces) and abstains on anything else, so `provider: rules`
// and the fallback path behave identically to today's pipeline.
export class RulesProvider implements DecisionProvider {
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (request.triage && request.kind === "noul" && typeof request.state === "string") {
      const maxBytes =
        typeof request.maxBytes === "number"
          ? request.maxBytes
          : DEFAULT_KNOWLEDGE_CONFIG.skip_triage_max_bytes
      const verdict = classifyTranscript(request.state, maxBytes)
      return {
        kind: "noul",
        value: verdict.skip,
        confidence: 1,
        probabilities: { true: verdict.skip ? 1 : 0, false: verdict.skip ? 0 : 1 },
        abstained: false,
        provider: "rules",
        backend: "rules",
        latencyMs: 0,
      }
    }
    return {
      kind: request.kind,
      value: null,
      confidence: 0,
      probabilities: {},
      abstained: true,
      provider: "rules",
      backend: "rules",
      latencyMs: 0,
      error: "RulesProvider only answers the triage noul decision",
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge provider (subprocess)

export type BridgeSpawnResult = { code: number | null; stdout: string; stderr: string }

export type BridgeSpawner = (args: {
  script: string
  configPath: string
  backend: string
  request: string
  timeoutMs: number
}) => Promise<BridgeSpawnResult>

// Default spawner: argv array, no shell, stdin carries the JSON request, hard
// kill on timeout. Mirrors the mail-hook `run` helper.
export function spawnBridge(args: {
  script: string
  configPath: string
  backend: string
  request: string
  timeoutMs: number
}): Promise<BridgeSpawnResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        "python3",
        [args.script, "--config", args.configPath, "--backend", args.backend],
        { stdio: ["pipe", "pipe", "pipe"] },
      )
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err) })
      return
    }
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, args.timeoutMs))
    child.stdout?.on("data", (d) => (stdout += d))
    child.stderr?.on("data", (d) => (stderr += d))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${String(err)}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin?.write(args.request)
    child.stdin?.end()
  })
}

// Strip TS-only routing fields before the request crosses the subprocess
// boundary (the Python side ignores unknown keys, but keep the contract clean).
function serializeRequest(request: DecisionRequest): string {
  const { triage: _triage, maxBytes: _maxBytes, ...rest } = request
  return JSON.stringify(rest)
}

// Normalize a parsed bridge response into a DecisionResult. Unknown keys are
// dropped; missing/ill-typed fields yield a fail-open (abstained) result so the
// caller's fallback can take over.
function normalizeBridgeResult(parsed: unknown): DecisionResult | null {
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const kind = obj.kind === "choice" || obj.kind === "score" || obj.kind === "noul" ? obj.kind : "noul"
  if (!("value" in obj)) return null
  const value = obj.value
  if (
    value !== null &&
    value !== undefined &&
    typeof value !== "boolean" &&
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null
  }
  const confidence = typeof obj.confidence === "number" ? obj.confidence : 0
  const probabilities =
    typeof obj.probabilities === "object" && obj.probabilities !== null
      ? (obj.probabilities as Record<string, number>)
      : {}
  let usage: DecisionUsage | undefined
  if (typeof obj.usage === "object" && obj.usage !== null) {
    const u = obj.usage as Record<string, unknown>
    const prompt = typeof u.promptTokens === "number" ? u.promptTokens : 0
    const completion = typeof u.completionTokens === "number" ? u.completionTokens : 0
    usage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : prompt + completion,
      promptMs: typeof u.promptMs === "number" ? u.promptMs : undefined,
      promptTokensPerSecond:
        typeof u.promptTokensPerSecond === "number" ? u.promptTokensPerSecond : undefined,
      usageKnown: u.usageKnown === true,
    }
  }
  return {
    kind,
    value,
    confidence,
    probabilities,
    abstained: obj.abstained === true,
    provider: typeof obj.provider === "string" ? obj.provider : "openjev",
    backend: typeof obj.backend === "string" ? obj.backend : "llamacpp",
    model: typeof obj.model === "string" ? obj.model : undefined,
    latencyMs: typeof obj.latencyMs === "number" ? obj.latencyMs : 0,
    usage,
    error: typeof obj.error === "string" ? obj.error : undefined,
  }
}

const BRIDGE_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "decisions_bridge.py",
)

// Subprocess-backed provider. One fresh `python3 decisions_bridge.py` per call,
// no daemon, no port (plan §5). On any transport failure it returns an
// abstained result carrying the error; `decideWithFallback` turns that into the
// RulesProvider verdict.
export class BridgeDecisionProvider implements DecisionProvider {
  private readonly opts: {
    configPath: string
    backend: string
    timeoutMs: number
    spawner?: BridgeSpawner
  }

  constructor(opts: {
    configPath: string
    backend: string
    timeoutMs: number
    spawner?: BridgeSpawner
  }) {
    this.opts = opts
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const spawner = this.opts.spawner ?? spawnBridge
    const started = Date.now()
    let result: BridgeSpawnResult
    try {
      result = await spawner({
        script: BRIDGE_SCRIPT,
        configPath: this.opts.configPath,
        backend: this.opts.backend,
        request: serializeRequest(request),
        timeoutMs: this.opts.timeoutMs,
      })
    } catch (err) {
      return this.abstained(request, `bridge spawn failed: ${err instanceof Error ? err.message : String(err)}`, Date.now() - started)
    }

    if (result.code !== 0 || !result.stdout.trim()) {
      return this.abstained(
        request,
        result.stderr.trim() || `bridge exited ${result.code}`,
        Date.now() - started,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return this.abstained(request, "bridge returned invalid JSON", Date.now() - started)
    }

    const normalized = normalizeBridgeResult(parsed)
    if (!normalized) return this.abstained(request, "bridge returned an unexpected shape", Date.now() - started)
    // `latencyMs` is the backend's own prompt-eval time; `wallMs` is the full
    // subprocess round-trip (python startup + spawn + backend), the number that
    // matters for the hook's scheduling budget.
    normalized.wallMs = Date.now() - started
    return normalized
  }

  private abstained(request: DecisionRequest, error: string, wallMs: number): DecisionResult {
    return {
      kind: request.kind,
      value: null,
      confidence: 0,
      probabilities: {},
      abstained: true,
      provider: "openjev",
      backend: this.opts.backend,
      latencyMs: wallMs,
      wallMs,
      error,
    }
  }
}

// ---------------------------------------------------------------------------
// Registry + fallback

export function createDecisionProvider(
  config: DecisionsConfig,
  opts: { configPath: string; spawner?: BridgeSpawner },
): DecisionProvider {
  if (config.provider === "rules") return new RulesProvider()
  return new BridgeDecisionProvider({
    configPath: opts.configPath,
    backend: config.backend,
    timeoutMs: config.timeout_ms,
    spawner: opts.spawner,
  })
}

// Fail-open orchestration: run the configured provider, and on error / abstain /
// non-candidate output fall back to the deterministic RulesProvider. Returns the
// result, a `fallback` flag, and a `fallbackReason` for the ledger.
export type FallbackReason = "none" | "error" | "abstain" | "shape"

export async function decideWithFallback(
  provider: DecisionProvider,
  request: DecisionRequest,
  rules: RulesProvider,
): Promise<{ result: DecisionResult; fallback: boolean; fallbackReason: FallbackReason }> {
  try {
    const result = await provider.decide(request)
    const usable =
      !result.error &&
      result.abstained === false &&
      result.value !== null &&
      result.value !== undefined
    if (usable) return { result, fallback: false, fallbackReason: "none" }
    const reason: FallbackReason = result.error ? "error" : result.abstained ? "abstain" : "shape"
    const fb = await rules.decide(request)
    // Keep the provider's own telemetry even though the rules verdict wins, so
    // a fallback stays traceable (how long did the failed attempt take?).
    return {
      result: {
        ...fb,
        error: result.error,
        model: result.model,
        usage: result.usage,
        wallMs: result.wallMs,
      },
      fallback: true,
      fallbackReason: reason,
    }
  } catch (err) {
    const fb = await rules.decide(request)
    return {
      result: { ...fb, error: err instanceof Error ? err.message : String(err) },
      fallback: true,
      fallbackReason: "error",
    }
  }
}

// ---------------------------------------------------------------------------
// Shadow ledger (plan §7 + traceability extension)

export function buildDecisionsLogEntry(input: {
  session: string
  result: DecisionResult
  rulesVerdict: TriageVerdict
  fallback: boolean
  fallbackReason?: FallbackReason
  mode?: string
}): Record<string, unknown> {
  const usage = input.result.usage
  return {
    ts: new Date().toISOString(),
    session: input.session,
    provider: input.result.provider,
    backend: input.result.backend,
    model: input.result.model ?? null,
    mode: input.mode ?? "shadow",
    kind: input.result.kind,
    value: input.result.value,
    confidence: input.result.confidence,
    pTrue:
      typeof input.result.probabilities?.true === "number"
        ? input.result.probabilities.true
        : null,
    abstained: input.result.abstained,
    latencyMs: input.result.latencyMs,
    wallMs: input.result.wallMs ?? null,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    promptMs: usage?.promptMs ?? null,
    promptTokensPerSecond: usage?.promptTokensPerSecond ?? null,
    usageKnown: usage?.usageKnown ?? false,
    fallback: input.fallback,
    fallbackReason: input.fallbackReason ?? (input.fallback ? "unknown" : "none"),
    rulesVerdict: { skip: input.rulesVerdict.skip, reason: input.rulesVerdict.reason },
    eventualOutcome: null,
  }
}
