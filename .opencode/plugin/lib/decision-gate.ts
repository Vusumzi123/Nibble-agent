// Shared JEV decision seam (docs/jev-decision-provider-plan.md, pre-M3
// refactor). One place owns the "read `decisions:` once, build one provider,
// run one decision with an explicit fallback polarity" wiring that knowledge-
// hook, retrieval-hook and profile-hook all need — so no hook carries its own
// copy of the bootstrap.
//
// Two polarities, chosen per call site because the fail direction differs:
//
//   fallback: "open"   run the provider, and on error/abstain/shape fall back
//                      to the deterministic RulesProvider. `reason` is always
//                      set (the ledger wants it even on the happy path).
//   fallback: "closed" the provider's answer stands or the gate fails — there
//                      is NO rules fallback. An error-carrying result is
//                      reported as `reason: "error"` with the result kept for
//                      telemetry; a throw yields `result: null` so the caller
//                      fails closed.
//
// `enabled: false` makes `openDecisionGate` return null; the caller keeps its
// own disabled policy (knowledge-hook registers no hooks, retrieval-hook
// returns {}). Loaded via relative import only.
import { join } from "node:path"
import { SYSCONFIG } from "./paths.ts"
import {
  RulesProvider,
  createDecisionProvider,
  decideWithFallback,
  readDecisionsConfig,
  type BridgeSpawner,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type DecisionsConfig,
  type FallbackReason,
} from "./decisions.ts"

export type DecisionGateOptions = {
  // Overlay on `decisions.timeout_ms` for this gate only (retrieval owns a
  // tighter per-decision budget than the shared drain/tag budget).
  timeoutMs?: number
  // Test-injection seam: replaces the python bridge spawner (the
  // decisions.test.ts convention).
  spawner?: BridgeSpawner
}

// The open polarity always substitutes a rules verdict on failure, so its
// result is never null and `reason` is always set (the ledger reads it).
export type OpenDecisionOutcome = {
  result: DecisionResult
  fallback: boolean
  reason: FallbackReason
}

// The closed polarity has no rules substitute: an unusable provider answer
// either comes back error-marked (kept for telemetry) or as a null result.
export type ClosedDecisionOutcome = {
  result: DecisionResult | null
  fallback: boolean
  reason: FallbackReason
}

export type DecisionOutcome = OpenDecisionOutcome | ClosedDecisionOutcome

export type DecisionGate = {
  // The effective `decisions:` config (mode, noul_threshold, ledger settings).
  config: DecisionsConfig
  decide(request: DecisionRequest, opts: { fallback: "open" }): Promise<OpenDecisionOutcome>
  decide(request: DecisionRequest, opts: { fallback: "closed" }): Promise<ClosedDecisionOutcome>
}

// Read the `decisions:` block once and hand back a bound gate, or null when
// decisions are disabled. Never throws: a missing/malformed config yields the
// defaults, which are disabled.
export async function openDecisionGate(
  directory: string,
  opts: DecisionGateOptions = {},
): Promise<DecisionGate | null> {
  const config = await readDecisionsConfig(directory)
  if (!config.enabled) return null

  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : config.timeout_ms
  const provider: DecisionProvider = createDecisionProvider(
    { ...config, timeout_ms: timeoutMs },
    { configPath: join(directory, SYSCONFIG), spawner: opts.spawner },
  )
  const rules = new RulesProvider()

  async function decide(
    request: DecisionRequest,
    decideOpts: { fallback: "open" },
  ): Promise<OpenDecisionOutcome>
  async function decide(
    request: DecisionRequest,
    decideOpts: { fallback: "closed" },
  ): Promise<ClosedDecisionOutcome>
  async function decide(
    request: DecisionRequest,
    decideOpts: { fallback: "open" | "closed" },
  ): Promise<DecisionOutcome> {
    if (decideOpts.fallback === "open") {
      const { result, fallback, fallbackReason } = await decideWithFallback(provider, request, rules)
      return { result, fallback, reason: fallbackReason }
    }
    try {
      const result = await provider.decide(request)
      if (result.error) return { result, fallback: false, reason: "error" }
      return { result, fallback: false, reason: "none" }
    } catch {
      return { result: null, fallback: true, reason: "error" }
    }
  }

  return { config, decide }
}
