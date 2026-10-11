import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { automationChildSessions } from "./lib/automation.ts"
import {
  AUTONOMY_JEV_TIMEOUT_MS,
  approveAsk,
  askMessage,
  autonomyDirective,
  buildAutonomyRequest,
  callTarget,
  classifyCall,
  clearGrant,
  clearSessionGrant,
  consumeApproved,
  consumeGrant,
  consumeSessionGrant,
  denyMessage,
  fingerprintCall,
  isConfirm,
  isSessionConfirm,
  isSessionRevoke,
  jevAllows,
  jevStateSummary,
  mintGrant,
  mintSessionGrant,
  parseBatchManifest,
  pendingFor,
  recordAsk,
  type AskStore,
  type Classification,
  type GrantStore,
  type SessionGrantMode,
  type SessionGrantStore,
} from "./lib/autonomy-gate.ts"
import { readAutonomyConfig } from "./lib/autonomy.ts"
import { openDecisionGate } from "./lib/decision-gate.ts"
import { readDecisionPrompts } from "./lib/decision-prompts.ts"
import type { BridgeSpawner } from "./lib/decisions.ts"
import { LOG_DEFAULTS, getLogger } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools, textOf } from "./lib/sessions.ts"

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
// Scope (`autonomy.gate_scope`, default `main`): a Task sub-agent child
// session (parentID set) only ever faces the irreversibility floor — asks in
// a child are unapprovable anyway (the user's confirm lands keyed to the
// human session), so the dial only drives the top-level session. `all`
// restores Phase 1's gate-everything behaviour. Floor denies apply to every
// scope; verdicts are still logged either way.
//
// The plugin auto-discovery loader requires every export of this file to be a
// plugin factory, so this file deliberately exports ONLY the default plugin.
// `ctx.spawner` is a test-injection seam (openDecisionGate's own convention);
// opencode never passes it, so production always uses the real bridge.
export default (async (ctx) => {
  const { directory, client } = ctx as { directory?: string; client?: unknown }
  const spawner = (ctx as { spawner?: BridgeSpawner }).spawner
  const dir = directory ?? process.cwd()
  const resolved = await readResolvedPaths(dir, homedir())
  const logDir = resolved.logDir
  const logger = getLogger(
    { ...LOG_DEFAULTS, file: "autonomy-gate.log" },
    { logDir, home: homedir(), channel: "autonomy-gate" },
  )

  // Cached child lookup (lib/sessions.ts). No client (tests) = no child
  // detection = fail closed: every session is gated like a human session.
  const sessions = client ? createSessionTools(client as Parameters<typeof createSessionTools>[0], dir) : null

  // JEV seam (card G): null when decisions are disabled — escalation then
  // fails closed to `ask` (settled decision #5). Assertion text is read once
  // at boot (decision-prompts.yaml changes are live on the next plugin boot).
  const decisionGate = await openDecisionGate(dir, { timeoutMs: AUTONOMY_JEV_TIMEOUT_MS, spawner })
  const autonomyAssertion = (await readDecisionPrompts(dir)).autonomy.assertion

  // Pending asks awaiting (or holding) the user's confirm — one per session,
  // latest-only. Cleared by a process restart (fail-closed).
  const pending: AskStore = new Map()

  // Per-turn batch grants (manifest approval). Turn-scoped: cleared on the next
  // non-confirm user message or TTL. Cleared by a process restart (fail-closed).
  const grants: GrantStore = new Map()

  // Session-scoped grants ("allow session"). Survive turn boundaries for the
  // session's life; cleared only by an explicit revoke or a process restart
  // (fail-closed). Floor / root / self-improve are never mintable.
  const sessionGrants: SessionGrantStore = new Map()

  // Hot-read: re-reads sysop-config.yaml per call so a level (or gate_mode)
  // flip applies to the very next turn/command. Fail-closed to L0 if the read
  // ever throws — the reader contract says it never does.
  const hotRead = async (): Promise<{
    level: number
    gate_mode: "shadow" | "gate"
    gate_scope: "main" | "all"
    batch_max_actions: number
    session_grant: SessionGrantMode
    session_grant_ttl: number
    class_overrides: string[]
    root_classes: string[]
  }> => {
    try {
      const cfg = await readAutonomyConfig(dir)
      return {
        level: cfg.level,
        gate_mode: cfg.gate_mode === "shadow" ? "shadow" : "gate",
        gate_scope: cfg.gate_scope === "all" ? "all" : "main",
        batch_max_actions: cfg.batch.max_actions,
        session_grant: cfg.session_grant,
        session_grant_ttl: cfg.session_grant_ttl,
        class_overrides: cfg.class_overrides,
        root_classes: cfg.root_classes,
      }
    } catch {
      return { level: 0, gate_mode: "gate", gate_scope: "main", batch_max_actions: 0, session_grant: "off", session_grant_ttl: 0, class_overrides: [], root_classes: [] }
    }
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const cfg = await hotRead()
        // Under gate_scope main the dial does not govern sub-agent children —
        // no directive line for them either.
        if (cfg.gate_scope === "main" && sessions && (await sessions.isChild((input as { sessionID?: string })?.sessionID ?? ""))) {
          return
        }
        output.system.push(autonomyDirective(cfg.level))
      } catch {
        // A missing/broken transform output must never break the session.
      }
    },

    "chat.message": async (input, output) => {
      // Confirm vocabulary (cards F + session grant): only an explicit confirm
      // approves the pending ask; any other user text does not consume it.
      const text = textOf(((output as any)?.parts ?? []) as unknown[]).trim()
      if (!text) return
      const now = Date.now()
      const cfg = await hotRead()

      // Explicit revoke of any session grant for this session.
      if (isSessionRevoke(text)) {
        clearSessionGrant(sessionGrants, input.sessionID)
        try {
          await logger.append({ ts: new Date(now).toISOString(), event: "session-grant-revoke" })
        } catch {
          // Logging must never break the turn.
        }
        return
      }

      // Session-wide confirm ("allow session" / "always allow"). Checked before
      // isConfirm. Approve the pending one-shot too (so the immediate retry
      // passes), then mint a session grant covering the pending call.
      if (isSessionConfirm(text)) {
        approveAsk(pending, input.sessionID, now)
        if (cfg.session_grant !== "off") {
          const rec = pendingFor(pending, input.sessionID, now)
          if (rec && mintSessionGrant(sessionGrants, input.sessionID, rec.cls, rec.target, cfg.session_grant, now)) {
            try {
              await logger.append({
                ts: new Date(now).toISOString(),
                event: "session-grant-mint",
                cls: rec.cls,
                target: rec.target,
                grant_mode: cfg.session_grant,
              })
            } catch {
              // Logging must never break the turn.
            }
          }
        }
        return
      }

      if (isConfirm(text)) {
        approveAsk(pending, input.sessionID, now)
        // Batch mint: the assistant's last reply may carry a manifest. A
        // confirm with no manifest degrades to today's one-shot approval.
        if (cfg.batch_max_actions > 0 && sessions) {
          try {
            const last = await sessions.lastAssistantText(input.sessionID)
            const entries = parseBatchManifest(last)
            if (entries) {
              mintGrant(grants, input.sessionID, entries, cfg.batch_max_actions, now)
              await logger.append({
                ts: new Date(now).toISOString(),
                event: "grant-mint",
                entries: entries.length,
                budget: Math.min(cfg.batch_max_actions, entries.length),
              })
            }
          } catch {
            // A manifest read failure never breaks the confirm path.
          }
        }
      } else {
        // Turn boundary: a new non-confirm user message ends the batch grant
        // and clears any stale pending ask. Session grants deliberately survive
        // the turn boundary (they are revoked explicitly or on restart).
        clearGrant(grants, input.sessionID)
        pending.delete(input.sessionID)
      }
    },

    "tool.execute.before": async (input) => {
      let c: Classification | null = null
      let level = 0
      let mode: "shadow" | "gate" = "shadow"
      let scope: "main" | "all" = "main"
      let child = false
      let fingerprint = ""
      let sessionGrantMode: SessionGrantMode = "off"
      let sessionGrantTtl = 0

      // Automation children bypass the gate entirely — knowledge drain etc.
      // already run behind their own JEV gates (settled decision #3).
      if (automationChildSessions.has(input.sessionID)) return

      try {
        const cfg = await hotRead()
        level = cfg.level
        mode = cfg.gate_mode
        scope = cfg.gate_scope
        sessionGrantMode = cfg.session_grant
        sessionGrantTtl = cfg.session_grant_ttl
        child = sessions ? await sessions.isChild(input.sessionID) : false
        c = classifyCall(input.tool, input.args, level, {
          root_classes: cfg.root_classes,
          class_overrides: cfg.class_overrides,
        })
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
          outOfSchema: c.outOfSchema ?? false,
          mode,
          scope,
          child,
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

      // Sub-agent children under gate_scope main: the dial (ask AND dial-deny
      // rows) does not apply — only the irreversibility floor's deny below
      // still does. `all` gates them too.
      if (child && scope === "main" && c.cls !== "floor") return

      // deny before anything else: the floor is never approvable — not by the
      // user's confirm, not by JEV, not via root_classes.
      if (c.verdict === "deny") throw new Error(denyMessage(c, level))
      if (c.verdict === "ask") {
        const now = Date.now()
        const target = callTarget(input.tool, input.args)
        // 1. The user's confirm outranks the model — approved exact retry
        //    passes once (card F).
        if (consumeApproved(pending, input.sessionID, fingerprint, now)) return
        // 2. Batch grant — a call declared in the confirmed manifest passes
        //    (budget decremented) without prompting.
        if (consumeGrant(grants, input.sessionID, c.cls, target, now)) {
          await logger.append({
            ts: new Date(now).toISOString(),
            event: "grant-use",
            level,
            tool: input.tool,
            cls: c.cls,
            fingerprint,
            mode,
          })
          return
        }
        // 3. Session grant — an "allow session" approval covering this exact
        //    call (target mode) or its whole class (class mode). Never
        //    consulted while session grants are off.
        if (
          sessionGrantMode !== "off" &&
          consumeSessionGrant(sessionGrants, input.sessionID, c.cls, target, now, sessionGrantTtl * 60_000)
        ) {
          await logger.append({
            ts: new Date(now).toISOString(),
            event: "session-grant-use",
            level,
            tool: input.tool,
            cls: c.cls,
            fingerprint,
            mode,
          })
          return
        }
        // 4. JEV escalation (card G) — only the matrix rows flagged `jev`
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
        // 5. Ask: record latest-only (with its class + target), then block
        //    until the user confirms.
        recordAsk(pending, input.sessionID, fingerprint, now, c.cls, target)
        throw new Error(askMessage(c, level, { sessionGrant: sessionGrantMode !== "off" }))
      }
      // allow -> pass
    },
  }
}) satisfies Plugin
