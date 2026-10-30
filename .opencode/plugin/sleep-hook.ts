import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { automationChildSessions } from "./lib/automation.ts"
import { readAutonomyConfig, readMoodConfig } from "./lib/autonomy.ts"
import { isQuietNow } from "./lib/heartbeat.ts"
import { createDiagnostics, getLogger, LOG_DEFAULTS } from "./lib/logging.ts"
import { buildMoodLine, createMoodFeed } from "./lib/mood.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools } from "./lib/sessions.ts"
import { applyWake, buildWakeLine, createSleepStore } from "./lib/sleep.ts"

// User-turn wake transitions for the quiet-hours sleep system (plan §17.1,
// §17.7 — kanban card G). sleep-hook is the SOLE writer of the user-turn
// transition class: dreaming → woken (+ the `woken` mood event and the `[wake]`
// block) and woken → woken activity refresh (so `resume_cooldown` measures
// from the LAST user message). Window and cooldown transitions belong to
// heartbeat-hook — the writer classes are disjoint by design (§17.1).
//
// Non-wake events (audit failures, mail, timer ticks) never wake the agent —
// only a top-level human chat.message does; child and automation sessions are
// ignored exactly like mood-hook ignores them. A turn outside the quiet window
// is not a wake at all: `isQuietNow` gates the whole path (hot-read of
// `autonomy.quiet.window`, no restart).
//
// The `[wake]` block ("you were dreaming since X" + the mood snapshot) is
// stashed per session at chat.message and injected once by the system
// transform below, then dropped at session.idle (retrieval-hook's pending
// pattern).
export default (async ({ client, directory }) => {
  const dir = directory ?? process.cwd()
  const { logDir, stateDir } = await readResolvedPaths(dir, homedir())
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "sleep-hook" })

  const moodCfg = await readMoodConfig(dir)
  const feed = await createMoodFeed({
    file: join(stateDir, "mood.json"),
    halfLife: moodCfg.decay_half_life,
    logger: getLogger({ file: "mood.ndjson", ...LOG_DEFAULTS }, {
      logDir,
      home: homedir(),
      channel: "sleep-hook",
    }),
    onError: (err) => void diag.error("[sleep-hook] mood feed failed:", err),
  })

  const store = createSleepStore(stateDir, {
    onError: (err) => void diag.error("[sleep-hook] sleep state write failed:", err),
  })
  const sessions = createSessionTools(client, dir)

  // sessionID → the [wake] block for the waking turn (one-shot).
  const pendingWake = new Map<string, string>()

  return {
    "chat.message": async (input) => {
      const sid = input.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      pendingWake.delete(sid) // a fresh turn supersedes any unconsumed block

      const autonomy = await readAutonomyConfig(dir)
      if (!isQuietNow(autonomy.quiet.window)) return // outside the window a turn is not a wake

      const before = await store.read()
      const t = applyWake(before, Date.now())
      if (!t.changed) return
      await store.write(t.state)
      for (const event of t.mood_events) await feed.apply(event)

      // Only the dreaming → woken transition injects the block; a woken
      // activity refresh is silent (§17.7: the wake block is per wake).
      if (before.status === "dreaming" && t.state.status === "woken") {
        pendingWake.set(sid, buildWakeLine(before.since, buildMoodLine(feed.view())))
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Kept for the whole turn (retrieval-hook pattern): superseded by the
      // next chat.message, dropped at session.idle.
      const block = pendingWake.get(input.sessionID)
      if (block) output.system.push(block)
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (sid) pendingWake.delete(sid)
    },
  }
}) satisfies Plugin
