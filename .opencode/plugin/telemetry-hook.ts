import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { createDiagnostics, getLogger, logSettingsFrom } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools } from "./lib/sessions.ts"
import { drainAccounting } from "./lib/knowledge.ts"
import {
  buildTaskTelemetryEntry,
  parseWatchAgents,
  readTelemetryConfig,
  routeForAgent,
  shortDescription,
  taskEnvelopeState,
} from "./lib/telemetry.ts"

// Phase 0 retrieval telemetry (docs/phase0-retrieval-telemetry-plan.md). On
// every watched `task` delegation, emit one deterministic NDJSON record shaped
// like the drain ledger — tokens/steps/cost/wall time — so the later retrieval
// optimizations are falsifiable:
//
//   rag-search                 -> brain_log   (0a)
//   safe-browser/deep-browser  -> web_log     (0b, `web-task`)
//
// The bundled task tool returns `metadata: { parentSessionId, sessionId,
// model, background?, jobId? }`, so no session discovery is needed. Usage comes
// from `drainAccounting` over the child session's messages (the same pure helper
// the drain ledger uses), embedded verbatim. NO prompt text is logged — only
// `promptBytes`, a short description, and a byte-count/target for inner fetches.
//
// Fail-open by construction: the whole `after` is wrapped in try/catch, missing
// metadata degrades to an `outcome:"error"` line, and a logging failure can
// never break the session. `background` tasks return immediately, so their
// partial child session is never counted (Phase 0 records no completion re-read).

// Stamp-map bound: a cancelled task could otherwise leak a timestamp forever.
const MAX_STAMPS = 512

export default (async ({ client, directory }) => {
  const dir = directory ?? process.cwd()
  const resolved = await readResolvedPaths(dir, homedir())
  const logDir = resolved.logDir
  const cfg = await readTelemetryConfig(dir)
  if (!cfg.enabled) return {}

  const watch = parseWatchAgents(cfg.watch_agents)
  const brainLog = getLogger(logSettingsFrom(cfg, "brain_log", ""), {
    logDir,
    home: homedir(),
    channel: "telemetry-brain",
  })
  const webLog = getLogger(logSettingsFrom(cfg, "web_log", ""), {
    logDir,
    home: homedir(),
    channel: "telemetry-web",
  })
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "telemetry-hook" })
  const sessions = createSessionTools(client, dir, {
    onError: (err) => void diag.error("[telemetry-hook] session lookup failed:", err),
  })

  // callID -> spawn timestamp. Deleted on the first `after` so the map does not
  // leak; `emitted` is the actual duplicate-`after` guard (a task must produce
  // exactly one line even if the hook fires twice for a call).
  const starts = new Map<string, number>()
  const emitted = new Set<string>()
  const stamp = (callID: string): void => {
    if (starts.size >= MAX_STAMPS) {
      const oldest = starts.keys().next().value
      if (oldest !== undefined) starts.delete(oldest)
    }
    starts.set(callID, Date.now())
  }
  const claim = (callID: string): boolean => {
    if (emitted.has(callID)) return false
    if (emitted.size >= MAX_STAMPS) {
      const oldest = emitted.values().next().value
      if (oldest !== undefined) emitted.delete(oldest)
    }
    emitted.add(callID)
    return true
  }

  const loggerFor = (route: "brain" | "web") => (route === "brain" ? brainLog : webLog)

  return {
    "tool.execute.before": async (input) => {
      if (input.tool !== "task") return
      // `before` input carries no args; only the timestamp is needed here.
      stamp(input.callID)
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return
      if (!claim(input.callID)) return

      const t0 = starts.get(input.callID)
      starts.delete(input.callID)
      const wallMs = t0 == null ? null : Date.now() - t0

      let route: "brain" | "web" | null = null
      let parentSession = input.sessionID
      let childSession: string | null = null
      let delegate = ""
      try {
        const metadata = (output?.metadata ?? {}) as Record<string, unknown>

        childSession = typeof metadata.sessionId === "string" ? metadata.sessionId : null
        delegate = typeof input.args?.subagent_type === "string" ? input.args.subagent_type : ""
        // Resume calls carry only `task_id`; recover the agent from the child meta.
        if (!delegate && childSession) {
          delegate = (await sessions.meta(childSession)).agent ?? ""
        }
        route = routeForAgent(delegate, watch)
        if (!route) return

        parentSession =
          typeof metadata.parentSessionId === "string" ? metadata.parentSessionId : input.sessionID
        const topSession = await sessions.topLevel(parentSession)

        const event = route === "brain" ? "rag-search" : "web-task"
        const description = shortDescription(input.args?.description)
        const promptBytes = Buffer.byteLength(
          typeof input.args?.prompt === "string" ? input.args.prompt : "",
          "utf8",
        )
        const model = metadata.model ?? null
        const base = {
          event,
          parentSession,
          childSession,
          topSession,
          delegate,
          description,
          promptBytes,
          model,
          wallMs,
        }
        const logger = loggerFor(route)

        // Background: the child is still running at `after` time, so no usage
        // read (a partial-session count would be a lie). Record the spawn only.
        if (metadata.background === true || metadata.jobId != null) {
          await logger.append(buildTaskTelemetryEntry({ ...base, outcome: "background" }))
          return
        }

        // Degraded: no child session id means there is nothing to account.
        if (!childSession) {
          await logger.append(
            buildTaskTelemetryEntry({ ...base, outcome: "error", reason: "no-child" }),
          )
          return
        }

        let outcome: "ok" | "error" = "ok"
        let usage: unknown
        try {
          const res = await client.session.messages({
            path: { id: childSession },
            query: { directory: dir },
          })
          usage = drainAccounting(Array.isArray(res?.data) ? res.data : [])
        } catch (err) {
          void diag.error("[telemetry-hook] child messages read failed:", err)
          outcome = "error"
        }
        if (outcome === "ok" && taskEnvelopeState(output?.output) === "error") {
          outcome = "error"
        }

        await logger.append(
          buildTaskTelemetryEntry({
            ...base,
            outcome,
            ...(usage !== undefined ? { usage } : {}),
          }),
        )
      } catch (err) {
        void diag.error("[telemetry-hook] failed:", err)
        // Best effort: only emit when the route was already resolved, so an
        // early failure cannot mis-attribute a line to the wrong ledger.
        if (route) {
          try {
            await loggerFor(route).append(
              buildTaskTelemetryEntry({
                event: route === "brain" ? "rag-search" : "web-task",
                parentSession,
                childSession,
                topSession: parentSession,
                delegate,
                description: shortDescription(input.args?.description),
                promptBytes: 0,
                model: null,
                wallMs,
                outcome: "error",
                reason: "exception",
              }),
            )
          } catch (inner) {
            void diag.error("[telemetry-hook] degraded line failed:", inner)
          }
        }
      }
    },
  }
}) satisfies Plugin
