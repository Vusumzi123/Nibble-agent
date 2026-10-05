import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { createDiagnostics, getLogger, logSettingsFrom } from "./lib/logging.ts"
import { readResolvedPaths, SYSCONFIG } from "./lib/paths.ts"
import { createSessionTools, textOf } from "./lib/sessions.ts"
import { automationChildSessions } from "./lib/automation.ts"
import { createDecisionProvider, readDecisionsConfig, type DecisionResult } from "./lib/decisions.ts"
import {
  DEFAULT_RETRIEVAL_PROMPTS,
  buildRetrievalDirective,
  buildRetrievalLogEntry,
  buildRetrievalRequest,
  evaluateRetrieval,
  hasRetrievalIntent,
  readRetrievalConfig,
  readRetrievalPrompts,
  resolveRetrievalPrompts,
  type RetrievalGate,
  type RetrievalPrompts,
} from "./lib/retrieval.ts"

// Per-turn Brain-First retrieval gate (docs/jev-decision-provider-plan.md
// adjacent; AGENTS.md §0). The economy half of a Self-RAG-style loop: instead of
// always delegating a rag-search on the first turn, every user turn is judged by
// one `noul` decision ("this message needs no vault search") and the verdict is
// injected into the system prompt as an authoritative [brain-first] directive.
//
//   gate: true   — a confident skip suppresses the Brain-First search this turn.
//   gate: false  — shadow: verdicts are logged but every turn retrieves.
//
// FAIL-CLOSED: error / abstain / non-boolean -> SKIP (lib/retrieval.ts
// `evaluateRetrieval`). The deterministic `hasRetrievalIntent` override always
// retrieves first, so "search my notes" can never be mis-skipped.
//
// The decision is awaited inside `chat.message` so `system.transform` (which
// runs before the model request) can inject the block; it is cleared at
// `session.idle`. One subprocess per turn — the same bridge the drain and
// profile gates use. All work is best-effort: any failure yields a fail-closed
// skip and a logged reason, never a thrown session.
export default (async ({ client, directory }) => {
  const resolved = await readResolvedPaths(directory ?? process.cwd(), homedir())
  const sysopDir = resolved.sysopDir
  const config = await readRetrievalConfig(directory ?? process.cwd())
  if (!config.enabled) return {}

  const decisions = await readDecisionsConfig(directory ?? process.cwd())
  // No provider configured means no gate (rather than silently skipping every
  // turn, which the fail-closed predicate would otherwise do).
  if (!decisions.enabled) return {}

  const logger = getLogger(logSettingsFrom(config, "log", "log_"), {
    sysopDir,
    home: homedir(),
    channel: "retrieval-hook",
  })
  const diag = createDiagnostics({ sysopDir, home: homedir(), channel: "retrieval-hook" })

  const promptsFile = resolveRetrievalPrompts(directory ?? process.cwd(), config.prompts_file)
  const prompts: RetrievalPrompts = (await readRetrievalPrompts(promptsFile)) ?? DEFAULT_RETRIEVAL_PROMPTS
  if (prompts === DEFAULT_RETRIEVAL_PROMPTS) {
    await logger.append({ ts: new Date().toISOString(), event: "retrieval-prompts-fallback", file: promptsFile })
  }

  // The retrieval gate owns its own per-decision budget; overlay it on the
  // shared provider config so `retrieval.timeout_ms` actually governs.
  const provider = createDecisionProvider(
    { ...decisions, timeout_ms: config.timeout_ms },
    { configPath: join(directory ?? process.cwd(), SYSCONFIG) },
  )

  const sessions = createSessionTools(client, directory ?? process.cwd())

  // sessionID -> the directive to inject for the current turn. Overwritten on
  // each user message, dropped at idle.
  const pending = new Map<string, string>()

  const decideTurn = async (text: string): Promise<{ gate: RetrievalGate; result: DecisionResult | null }> => {
    const intent = config.force_intent && hasRetrievalIntent(text)
    if (intent) return { gate: { skip: false, reason: "intent" }, result: null }
    try {
      const result = await provider.decide(buildRetrievalRequest(text, prompts.assertion, config.max_bytes))
      return { gate: evaluateRetrieval(result, config.noul_threshold), result }
    } catch (err) {
      void diag.error("[retrieval-hook] decision failed:", err)
      return { gate: { skip: true, reason: "error" }, result: null }
    }
  }

  return {
    "chat.message": async (input, output) => {
      const sid = input.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return

      const text = textOf((output as any)?.parts ?? []).trim()
      if (!text) return

      const { gate, result } = await decideTurn(text)
      // Shadow mode logs the raw verdict but never suppresses retrieval.
      const skip = config.gate && gate.skip
      const pTrue = typeof result?.probabilities?.true === "number" ? result.probabilities.true : null
      const reason = config.gate ? gate.reason : "shadow"

      if (config.inject) {
        pending.set(sid, buildRetrievalDirective({ skip, reason, pTrue }))
      } else {
        pending.delete(sid)
      }

      await logger.append(
        buildRetrievalLogEntry({
          session: sid,
          gate,
          result,
          intent: gate.reason === "intent",
          mode: config.gate ? "gate" : "shadow",
        }),
      )
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!config.inject) return
      const block = pending.get(input.sessionID)
      if (block) output.system.push(block)
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (sid) pending.delete(sid)
    },
  }
}) satisfies Plugin
