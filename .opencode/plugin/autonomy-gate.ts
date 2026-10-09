import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { automationChildSessions } from "./lib/automation.ts"
import {
  AUTONOMY_JEV_TIMEOUT_MS,
  approveAsk,
  askMessage,
  autonomyDirective,
  buildAutonomyRequest,
  classifyCall,
  consumeApproved,
  denyMessage,
  fingerprintCall,
  isConfirm,
  jevAllows,
  jevStateSummary,
  recordAsk,
  type AskStore,
  type Classification,
} from "./lib/autonomy-gate.ts"
import { readAutonomyConfig } from "./lib/autonomy.ts"
import { openDecisionGate } from "./lib/decision-gate.ts"
import { readDecisionPrompts } from "./lib/decision-prompts.ts"
import type { BridgeSpawner } from "./lib/decisions.ts"
import { LOG_DEFAULTS, getLogger } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { textOf } from "./lib/sessions.ts"

// Autonomy gate — the runtime wiring for docs/autonomy-harness-plan.md §4.3
// (kanban cards D–G on [[phase-1-kanban]]). Modelled on scoped-permissions.ts;
// the pure classifier lives in lib/autonomy-gate.ts.
//
// Card D: advisory + instrumentation — the hot-read `[autonomy]` prompt line
// plus a shadow verdict log (<log>/autonomy-gate.log, NDJSON).
// Card E: enforcement — `autonomy.gate_mode: shadow|gate` (default `gate`) is
// the kill switch; ask -> instructive throw, deny -> hard refusal, allow ->
// pass; `automationChildSessions` bypass entirely (settled decision #3).
// Card F: the pending-ask approval machine — an ask records {session, sha1
// fingerprint, ts} (TTL 10m, latest-only); the user's strict confirm in
// chat.message approves it; the exact retry then passes ONCE. Floor verdicts
// never record. The store lives on this factory (restart clears it).
// Card G (this revision): JEV borderline escalation — rows flagged `jev`
// consult the shared decision gate (fallback CLOSED, ~8s overlay): a
// confident `allow` passes; ask / abstain / error / timeout /
// decisions-disabled all fall through to the pending-ask flow. The user's
// confirm always outranks the model (approval is consumed first).
//
// The plugin auto-discovery loader requires every export of this file to be a
// plugin factory, so this file deliberately exports ONLY the default plugin.
// `ctx.spawner` is a test-injection seam (openDecisionGate's own convention);
// opencode never passes it, so production always uses the real bridge.
export default (async (ctx) => {
  const { directory } = ctx
  const spawner = (ctx as { spawner?: BridgeSpawner }).spawner
  const dir = directory ?? process.cwd()
  const resolved = await readResolvedPaths(dir, homedir())
  const logDir = resolved.logDir
  const logger = getLogger(
    { ...LOG_DEFAULTS, file: "autonomy-gate.log" },
    { logDir, home: homedir(), channel: "autonomy-gate" },
  )

  // JEV seam (card G): null when decisions are disabled — escalation then
  // fails closed to `ask` (settled decision #5). Assertion text is read once
  // at boot (decision-prompts.yaml changes are live on the next plugin boot).
  const decisionGate = await openDecisionGate(dir, { timeoutMs: AUTONOMY_JEV_TIMEOUT_MS, spawner })
  const autonomyAssertion = (await readDecisionPrompts(dir)).autonomy.assertion

  // Pending asks awaiting (or holding) the user's confirm — one per session,
  // latest-only. Cleared by a process restart (fail-closed).
  const pending: AskStore = new Map()

  // Hot-read: re-reads sysop-config.yaml per call so a level (or gate_mode)
  // flip applies to the very next turn/command. Fail-closed to L0 if the read
  // ever throws — the reader contract says it never does.
  const hotRead = async (): Promise<{ level: number; gate_mode: "shadow" | "gate" }> => {
    try {
      const cfg = await readAutonomyConfig(dir)
      return { level: cfg.level, gate_mode: cfg.gate_mode === "shadow" ? "shadow" : "gate" }
    } catch {
      return { level: 0, gate_mode: "gate" }
    }
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        output.system.push(autonomyDirective((await hotRead()).level))
      } catch {
        // A missing/broken transform output must never break the session.
      }
    },

    "chat.message": async (input, output) => {
      // Strict confirm (card F): only the confirm vocabulary approves the
      // pending ask; any other user text does not consume it.
      const text = textOf(((output as any)?.parts ?? []) as unknown[]).trim()
      if (!text) return
      if (isConfirm(text)) approveAsk(pending, input.sessionID, Date.now())
    },

    "tool.execute.before": async (input) => {
      let c: Classification | null = null
      let level = 0
      let mode: "shadow" | "gate" = "shadow"
      let fingerprint = ""

      // Automation children bypass the gate entirely — knowledge drain etc.
      // already run behind their own JEV gates (settled decision #3).
      if (automationChildSessions.has(input.sessionID)) return

      try {
        const cfg = await hotRead()
        level = cfg.level
        mode = cfg.gate_mode
        c = classifyCall(input.tool, input.args, level)
        fingerprint = fingerprintCall(input.tool, input.args)
        await logger.append({
          ts: new Date().toISOString(),
          event: "verdict",
          level,
          tool: input.tool,
          verdict: c.verdict,
          cls: c.cls,
          reason: c.reason,
          fingerprint,
          jev: c.jev,
          mode,
        })
      } catch (err) {
        // Instrumentation failure: shadow passes (never blocks), gate fails
        // closed to an ask.
        if (mode !== "gate") return
        throw new Error(
          askMessage({ reason: `instrumentation failure (${err instanceof Error ? err.message : String(err)})`, cls: "borderline" }, level),
        )
      }
      if (!c || mode === "shadow") return

      // deny before anything else: the floor is never approvable — not by the
      // user's confirm, not by JEV, not via root_classes.
      if (c.verdict === "deny") throw new Error(denyMessage(c, level))
      if (c.verdict === "ask") {
        const now = Date.now()
        // 1. The user's confirm outranks the model — approved exact retry
        //    passes once (card F).
        if (consumeApproved(pending, input.sessionID, fingerprint, now)) return
        // 2. JEV escalation (card G) — only the matrix rows flagged `jev`
        //    reach the model; a confident `allow` passes, everything else
        //    falls through to the pending-ask flow. decisionGate null
        //    (decisions disabled) = fail-closed fall-through.
        if (c.jev && decisionGate) {
          try {
            const outcome = await decisionGate.decide(
              buildAutonomyRequest(jevStateSummary(input.tool, input.args), autonomyAssertion),
              { fallback: "closed" },
            )
            const approved = jevAllows(outcome.result)
            await logger.append({
              ts: new Date().toISOString(),
              event: "jev",
              level,
              tool: input.tool,
              fingerprint,
              approved,
              reason: outcome.reason,
              mode,
            })
            if (approved) return
          } catch {
            // closed polarity never throws; fall through fail-closed anyway.
          }
        }
        // 3. Ask: record latest-only, then block until the user confirms.
        recordAsk(pending, input.sessionID, fingerprint, now)
        throw new Error(askMessage(c, level))
      }
      // allow -> pass
    },
  }
}) satisfies Plugin
