// BrainProvider: the built-in vault memory lane
// (docs/knowledge-memory-modularization.md §4).
//
// Owns the Brain retrieval plan (rag-search delegation), the consolidation
// prompt/spawn/report contract (rag-brain), the deterministic candidate
// prefetch, and cursor-backed pending candidacy. The drain pipe never sees a
// vault note, a candidate score, or a fence.
//
// Loaded via relative import only.
import { extractKeywords } from "../../../transcript.ts"
import type { DrainConfig } from "../../../drain/config.ts"
import { countUnconsumed } from "../../../drain/db.ts"
import { effectiveCursorLastTs } from "../../../drain/status.ts"
import type {
  MemoryProfile,
  MemoryProvider,
  MemoryReadRequest,
  WriteContext,
  WriteItem,
  WriteReport,
} from "../../types.ts"
import { extractTitlePhrases, findCandidateNotes, type CandidateNote } from "./brain/candidates.ts"
import { buildConsolidationPrompt } from "./brain/prompt.ts"
import { parseDrainReport } from "./brain/report.ts"
import { promptConsolidationChild, spawnConsolidationChild } from "./brain/spawn.ts"

function reportCorrection(itemCount: number): string {
  return `Your previous reply completed without calling \`drain_report\`.
Call \`drain_report\` now with item_count: ${itemCount}, the \`consolidated\`
labels, the \`skipped\` labels, and partial: true only when the step cap stopped
you. Every item #1..#${itemCount} must appear exactly once unless partial is true.`
}

export const BRAIN_AGENTS = ["rag-search", "rag-brain"]

const HEADER =
  "[brain-first: RETRIEVE] Retrieval gate (authoritative for this turn): perform the Brain-First rag-search (rag-search sub-agent) before answering."

export type BrainProviderDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  drain: DrainConfig
  summaryWords: number
  dbFile?: string
  onWarn?: (message: string, err?: unknown) => void
}

/** The Brain delegation body (without the directive stats suffix). */
export function brainReadPlan(summaryWords: number): string {
  return [
    HEADER,
    `Delegate with exactly: "rag-search: <user message verbatim>" / "Task type: relevance search" / "Budget: search once (semantic + keyword, topK <= 5), read <= 3 notes. Reply with the relevant CONTENT — the facts, values, commands, paths, and steps that answer the question — as an answer-first synthesis of about ${summaryWords} words, citing each source note inline with [[wikilink]]. Never reply with a bare link list. No re-runs."`,
    'Integrate the returned facts directly into your answer — the summary already contains the content, so do not merely re-list the links; on "No relevant vault knowledge found" proceed normally.',
  ].join("\n")
}

export function createBrainProvider(deps: BrainProviderDeps): MemoryProvider {
  const id: MemoryProfile = "rag-brain"

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
    capabilities: { read: true, write: true, searchTool: false },
    agents: [...BRAIN_AGENTS],

    readPlan(_req?: MemoryReadRequest): string {
      return brainReadPlan(deps.summaryWords)
    },

    async consolidate(items: WriteItem[], ctx: WriteContext): Promise<WriteReport> {
      const cfg = ctx.config
      const searchText =
        ctx.searchText ??
        items
          .map((item) => [item.title, item.summary, item.atoms.join(" ")].join("\n"))
          .join("\n\n")

      let candidates: CandidateNote[] = []
      try {
        candidates = await findCandidateNotes({
          vaultDir: ctx.vaultDir,
          keywords: extractKeywords(searchText, 24),
          phrases: extractTitlePhrases(searchText, 12),
          limit: cfg.prefetch_candidates,
        })
      } catch (err) {
        ctx.onWarn?.("memory brain: candidate prefetch failed", err)
      }

      const prompt = buildConsolidationPrompt(items, candidates, {
        maxBytes: cfg.drain_prompt_max_bytes,
      })
      const promptBytes = Buffer.byteLength(prompt, "utf8")

      const executor = ctx.executor
      if (!executor) {
        return {
          ok: false,
          consumed: [],
          skipped: [],
          errorKind: "transient",
          detail: "no child executor",
        }
      }

      const spawned = await spawnConsolidationChild(executor, {
        directory: ctx.directory,
        prompt,
        agent: cfg.writer_agent,
        model: cfg.writer_model,
        deadlineMs: cfg.child_stall_ms,
      })

      let late = spawned.lateReply
      let aborted = spawned.aborted
      const baseTelemetry = {
        tokens: spawned.tokens,
        cost: spawned.cost,
        promptBytes,
        session: spawned.sessionID || null,
        started: spawned.started,
        timedOut: spawned.aborted,
        spawnMs: spawned.spawnMs ?? null,
        queueMs: spawned.queueMs ?? null,
        runMs: spawned.runMs ?? null,
        steps: spawned.steps ?? null,
        spanMs: spawned.spanMs ?? null,
        modelMs: spawned.modelMs ?? null,
        toolMs: spawned.toolMs ?? null,
      }
      const telemetry = () => ({ ...baseTelemetry, ...(late ? { late: true } : {}) })

      if (!spawned.sessionID) {
        return {
          ok: false,
          consumed: [],
          skipped: [],
          errorKind: "transient",
          detail: spawned.error ?? "writer failed",
          ...telemetry(),
        }
      }

      // A valid late report is still a report: parse the rows before deciding.
      let report = parseDrainReport(spawned.rows, items.length)
      if (report === null && !spawned.aborted) {
        try {
          const corrected = await promptConsolidationChild(executor, spawned.sessionID, {
            directory: ctx.directory,
            prompt: reportCorrection(items.length),
            agent: cfg.writer_agent,
            model: cfg.writer_model,
            deadlineMs: cfg.child_stall_ms,
          })
          late = late || corrected.lateReply
          aborted = aborted || corrected.aborted
          report = parseDrainReport(corrected.rows, items.length)
        } catch (err) {
          ctx.onWarn?.("memory brain: report correction failed", err)
        }
      }

      if (report === null) {
        return {
          ok: false,
          consumed: [],
          skipped: [],
          errorKind: "transient",
          detail: spawned.error ?? "writer did not call drain_report",
          ...telemetry(),
        }
      }

      if (!report.valid) {
        const missing = report.missing.length > 0 ? ` missing=${report.missing.join(",")}` : ""
        const excerpt = spawned.reply.replace(/\s+/g, " ").trim().slice(0, 500)
        ctx.onWarn?.(
          `memory brain: invalid report (${report.error ?? "incomplete"})${missing}; reply: ${excerpt}`,
        )
        return {
          ok: false,
          consumed: report.consolidated,
          skipped: report.skipped,
          errorKind: "permanent",
          detail: `invalid report: ${report.error ?? "incomplete"}`,
          ...telemetry(),
        }
      }

      if (aborted) late = true
      return {
        ok: true,
        consumed: report.consolidated,
        skipped: report.skipped,
        ...telemetry(),
      }
    },

    pending,

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
