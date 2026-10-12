import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { createDiagnostics, getLogger, LOG_DEFAULTS } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools } from "./lib/sessions.ts"
import { automationChildSessions } from "./lib/automation.ts"
import { nowIso } from "./lib/util.ts"
import { readMoodConfig } from "./lib/autonomy.ts"
import {
  applyEvent,
  buildMoodLine,
  decay,
  halfLifeMs,
  readMoodState,
  writeMoodState,
  type MoodEvent,
  type MoodState,
} from "./lib/mood.ts"

// Per-turn mood lifecycle (plan §15) — the feeling-state counterpart to the
// Brain-First retrieval gate. Three jobs:
//
//   1. Inject — `experimental.chat.system.transform` appends a one-line `[mood]`
//      block every turn (same mechanism `retrieval-hook` uses for `[brain-first]`),
//      so the mood is always fresh, never stale across a long session.
//   2. Feed — each top-level user message applies the `engaged` event (the
//      deterministic delta table of §15.2); the remaining events (mission/audit
//      failure, approval, consolidation, sleep/dream, silence) are fed by the
//      heartbeat/chatter/sleep cards via `applyEvent` from lib/mood.ts.
//   3. Realize decay — on `session.idle` the state is decayed toward its baseline
//      and persisted, so the on-disk position stays current between turns.
//
// Mood is advisory only. The `dispatch_influence` dial governs the bounded
// mission-selection steering in the heartbeat digest (card 4), not this hook:
// here it is read but not consumed — expression/`[mood]` injection is always on.
// Mood NEVER touches the autonomy gate, locks, approvals, or the floor (§4.1).
export default (async ({ client, directory }) => {
  const resolved = await readResolvedPaths(directory ?? process.cwd(), homedir())
  const { logDir, stateDir } = resolved
  const mood = await readMoodConfig(directory ?? process.cwd())

  const STATE_FILE = join(stateDir, "mood.json")
  const halfLife = halfLifeMs(mood.decay_half_life)

  const logger = getLogger({ file: "mood.ndjson", ...LOG_DEFAULTS }, {
    logDir,
    home: homedir(),
    channel: "mood-hook",
  })
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "mood-hook" })

  let state: MoodState = await readMoodState(STATE_FILE)

  const sessions = createSessionTools(client, directory ?? process.cwd())

  // Mutations are serialized through a queue so a user message, an idle, and a
  // late child event can never interleave a read-modify-write of `state`.
  let queue: Promise<void> = Promise.resolve()

  const apply = (event: MoodEvent): Promise<void> => {
    queue = queue.then(async () => {
      try {
        const before = state
        const next = applyEvent(decay(state, Date.now(), halfLife), event)
        state = next
        await writeMoodState(STATE_FILE, next)
        await logger.append({
          ts: nowIso(),
          event,
          valence_before: before.valence,
          arousal_before: before.arousal,
          valence_after: next.valence,
          arousal_after: next.arousal,
          label_after: next.label,
        })
      } catch (err) {
        void diag.error("[mood-hook] apply failed:", err)
      }
    })
    return queue
  }

  const realizeDecay = (): Promise<void> => {
    queue = queue.then(async () => {
      try {
        const next = decay(state, Date.now(), halfLife)
        state = next
        await writeMoodState(STATE_FILE, next)
      } catch (err) {
        void diag.error("[mood-hook] decay persist failed:", err)
      }
    })
    return queue
  }

  return {
    "chat.message": async (input) => {
      const sid = input.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      await apply("engaged")
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Read-only decayed view: the injected block reflects "now" without
      // mutating the persisted state (that happens on idle).
      output.system.push(buildMoodLine(decay(state, Date.now(), halfLife)))
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      await realizeDecay()
    },
  }
}) satisfies Plugin
