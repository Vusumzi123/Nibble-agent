// ExplorerProvider: the built-in un-consolidated read lane
// (docs/knowledge-memory-modularization.md §4).
//
// Read-only by construction: fixed SQLite search over the same eligible-turn
// filter the drain uses, no writes, no model, no shell. Owns `memory_search`,
// the recency retrieval plan, the dream seed, and cursor-backed candidacy.
//
// Loaded via relative import only.
import type { DrainConfig } from "../../../drain/config.ts"
import {
  loadCursor,
  resolveCursorFile,
} from "../../../drain/cursor.ts"
import { countUnconsumed, searchUnconsumed } from "../../../drain/db.ts"
import { effectiveCursorLastTs } from "../../../drain/status.ts"
import type {
  MemoryEvidence,
  MemoryProfile,
  MemoryProvider,
  MemoryReadRequest,
  MemoryToolFactory,
} from "../../types.ts"

export const EXPLORER_AGENTS = ["memory-explorer"]

/** Standalone directive when the explorer is the only active provider. */
export const EXPLORER_READ_PLAN = [
  "[brain-first: RETRIEVE] Retrieval gate (authoritative for this turn): perform the memory-explorer search over un-consolidated turns before answering.",
  'Delegate with exactly: "memory-explorer: <user message verbatim>" / "Task type: relevance search" / "Budget: search once (topK <= 5). Reply with the relevant CONTENT — the facts, values, commands, paths, and steps that answer the question — as an answer-first synthesis, citing session and time where useful. Never reply with a bare link list."',
  "Integrate the returned hits directly into your answer; un-consolidated turns are evidence, so name the session/time when it matters.",
].join("\n")

/** The recency lane appended after the Brain plan in the `both` composite. */
export const EXPLORER_LANE = [
  'Recency lane: if the request names a specific date or uses recency language ("recent", "today", "last week"), also delegate memory-explorer (un-consolidated turns) in parallel with rag-search. If rag-search returns thin/empty results, delegate memory-explorer as a follow-up.',
  "Merge the two: fuse the facts, prefer the consolidated vault note when both cover the same fact, and dedupe by content hash.",
].join("\n")

export type ExplorerProviderDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  drain: DrainConfig
  dbFile?: string
  onWarn?: (message: string, err?: unknown) => void
}

const TOOL_DESCRIPTION =
  "Search recent, not-yet-consolidated conversation turns (read-only evidence). Use only for specific-date or recency questions, or when the vault search is thin. Returns compact hits: session, time, role, excerpt, score."

function memorySearchTool(factory: MemoryToolFactory, deps: ExplorerProviderDeps): unknown {
  const tool = factory
  const schema = tool.schema
  return tool({
    description: TOOL_DESCRIPTION,
    args: {
      query: schema.string().describe("Keywords or the user's question."),
      top_k: schema.number().int().min(1).max(20).optional().describe("Maximum hits (default 5, cap 20)."),
      since: schema.number().optional().describe("Only turns at/after this epoch-ms timestamp."),
      session: schema.string().optional().describe("Restrict to one session id."),
      tags: schema.array(schema.string()).optional().describe("Require these tags/identifiers to appear in the turn text."),
    },
    async execute(args: any, ctx: any) {
      const dir = ctx?.directory || deps.directory
      try {
        const cursor = await loadCursor(resolveCursorFile(deps.stateDir, deps.drain.cursor_file))
        const hits = await searchUnconsumed({
          projectDir: dir,
          cursorTs: cursor.watermark_ts,
          query: args.query,
          topK: args.top_k ?? 5,
          since: args.since,
          session: args.session,
          tags: args.tags,
          dbFile: deps.dbFile,
          excludeMissions: deps.drain.exclude_missions,
        })
        return JSON.stringify({ lane: "unconsolidated", cursor: cursor.watermark_ts, hits })
      } catch (err) {
        deps.onWarn?.("memory explorer: memory_search failed", err)
        return JSON.stringify({
          lane: "unconsolidated",
          hits: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
}

export function createExplorerProvider(deps: ExplorerProviderDeps): MemoryProvider {
  const id: MemoryProfile = "memory-explorer"

  const pending = async (): Promise<number> => {
    const { lastTs } = await effectiveCursorLastTs(deps.stateDir, deps.drain)
    return countUnconsumed({
      projectDir: deps.directory,
      lastTs,
      dbFile: deps.dbFile,
      excludeMissions: deps.drain.exclude_missions,
    })
  }

  return {
    id,
    capabilities: { read: true, write: false, searchTool: true },
    agents: [...EXPLORER_AGENTS],

    readPlan(_req?: MemoryReadRequest): string {
      return EXPLORER_READ_PLAN
    },

    async search(req: {
      query: string
      topK: number
      since?: number
      session?: string
      tags?: string[]
    }): Promise<MemoryEvidence[]> {
      const cursor = await loadCursor(resolveCursorFile(deps.stateDir, deps.drain.cursor_file))
      return searchUnconsumed({
        projectDir: deps.directory,
        cursorTs: cursor.watermark_ts,
        query: req.query,
        topK: req.topK,
        since: req.since,
        session: req.session,
        tags: req.tags,
        dbFile: deps.dbFile,
        excludeMissions: deps.drain.exclude_missions,
      })
    },

    pending,

    tools(factory: MemoryToolFactory): Record<string, unknown> {
      if (!factory) return {}
      return { memory_search: memorySearchTool(factory, deps) }
    },

    async seed(): Promise<string | null> {
      try {
        const cursor = await loadCursor(resolveCursorFile(deps.stateDir, deps.drain.cursor_file))
        const [last] = await searchUnconsumed({
          projectDir: deps.directory,
          cursorTs: cursor.watermark_ts,
          query: "",
          topK: 1,
          dbFile: deps.dbFile,
          excludeMissions: deps.drain.exclude_missions,
        })
        if (!last?.excerpt) return null
        return `recent turn: ${last.excerpt.replace(/\s+/g, " ").trim().slice(0, 300)}`
      } catch {
        return null
      }
    },

    async health(): Promise<{ ok: boolean; detail?: string }> {
      try {
        await pending()
        return { ok: true }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
