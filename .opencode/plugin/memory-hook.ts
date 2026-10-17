import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { readDrainConfig } from "./lib/drain/config.ts"
import { loadCursor, resolveCursorFile } from "./lib/drain/cursor.ts"
import { searchUnconsumed } from "./lib/drain/db.ts"
import { createDiagnostics } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"

// Memory explorer lane (knowledge-pipeline-redesign Part C): a read-only
// keyword search over the un-consolidated SQLite turns. The tool is denied
// globally in opencode.json and allowed only for the `memory-explorer`
// sub-agent, which is gated on specific-date/recency requests (or a thin vault
// result).
//
// Read-only by construction: fixed queries over the same eligible-turn filter
// the drain uses, no writes, no model, no shell. Results disappear as soon as
// the drain cursor advances past them.
//
// The plugin API (including `tool`) is supplied by opencode at runtime; this
// file is not imported by the unit suite.
export default (async ({ directory }) => {
  const projectDir = directory ?? process.cwd()
  const { logDir, stateDir } = await readResolvedPaths(projectDir, homedir())
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "memory-hook" })

  return {
    tool: {
      memory_search: tool({
        description:
          "Search recent, not-yet-consolidated conversation turns (read-only evidence). Use only for specific-date or recency questions, or when the vault search is thin. Returns compact hits: session, time, role, excerpt, score.",
        args: {
          query: tool.schema.string().describe("Keywords or the user's question."),
          top_k: tool.schema
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Maximum hits (default 5, cap 20)."),
          since: tool.schema
            .number()
            .optional()
            .describe("Only turns at/after this epoch-ms timestamp."),
          session: tool.schema.string().optional().describe("Restrict to one session id."),
          tags: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Require these tags/identifiers to appear in the turn text."),
        },
        async execute(args, ctx) {
          const dir = ctx.directory || projectDir
          try {
            const cfg = await readDrainConfig(dir)
            const cursor = await loadCursor(resolveCursorFile(stateDir, cfg.cursor_file))
            const hits = await searchUnconsumed({
              projectDir: dir,
              cursorTs: cursor.last_ts,
              query: args.query,
              topK: args.top_k ?? 5,
              since: args.since,
              session: args.session,
              tags: args.tags,
            })
            return JSON.stringify({ lane: "unconsolidated", cursor: cursor.last_ts, hits })
          } catch (err) {
            void diag.warn("[memory-hook] memory_search failed:", err)
            return JSON.stringify({
              lane: "unconsolidated",
              hits: [],
              error: err instanceof Error ? err.message : String(err),
            })
          }
        },
      }),
    },
  }
}) satisfies Plugin
