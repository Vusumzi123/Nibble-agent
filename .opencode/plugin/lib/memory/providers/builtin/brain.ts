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
import {
  parseConsolidationReport,
  type ConsolidationReport,
} from "./brain/report.ts"
import { assistantReplies, spawnConsolidationChild } from "./brain/spawn.ts"

function fenceCorrection(itemCount: number): string {
  return `Your previous reply did not end with the required report fences.
Reply again with ONLY the two fenced blocks below: one line per item label (#
plus its number), every item from #1 to #${itemCount} exactly once, no prose.

\`\`\`consolidated
#1
\`\`\`
\`\`\`skipped
#2
\`\`\``
}

/** Ask the same child for the missing fences once, then re-read its newest reply. */
async function requestReportFences(
  ctx: WriteContext,
  sessionID: string,
  itemCount: number,
  agent: string,
  model: string,
): Promise<ConsolidationReport | null> {
  const res = await ctx.client.session.promptAsync({
    path: { id: sessionID },
    body: {
      agent,
      ...(model ? { model } : {}),
      parts: [{ type: "text", text: fenceCorrection(itemCount) }],
    },
    query: { directory: ctx.directory },
  })
  if (res?.error || (res?.response && !res.response.ok)) return null
  if (!(await ctx.waitForIdle(sessionID))) {
    // A correction child that outlives its wait must not keep running.
    try {
      await ctx.client.session.abort({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
    } catch {
      /* best effort */
    }
    return null
  }
  const messages = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  })
  const rows = Array.isArray(messages?.data) ? messages.data : []
  const newest = assistantReplies(rows)[0]
  return newest ? parseConsolidationReport(newest, itemCount) : null
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

      const spawned = await spawnConsolidationChild(ctx.client, {
        directory: ctx.directory,
        prompt,
        agent: cfg.writer_agent,
        model: cfg.writer_model,
        waitForIdle: ctx.waitForIdle,
        registerChild: ctx.registerChild,
      })

      const telemetry = {
        tokens: spawned.tokens,
        cost: spawned.cost,
        promptBytes,
        session: spawned.sessionID || null,
        ...(spawned.lateReply ? { late: true } : {}),
        spawnMs: spawned.spawnMs ?? null,
        queueMs: spawned.queueMs ?? null,
        runMs: spawned.runMs ?? null,
        steps: spawned.steps ?? null,
        spanMs: spawned.spanMs ?? null,
        modelMs: spawned.modelMs ?? null,
        toolMs: spawned.toolMs ?? null,
      }

      if (!spawned.ok) {
        return {
          ok: false,
          consumed: [],
          skipped: [],
          errorKind: "transient",
          detail: spawned.error ?? "writer failed",
          ...telemetry,
        }
      }

      // A timed-out child was already aborted; its partial text is not a
      // report. Retry the batch transiently instead of poisoning it.
      if (spawned.aborted) {
        return {
          ok: false,
          consumed: [],
          skipped: [],
          errorKind: "transient",
          detail: "writer timed out",
          ...telemetry,
        }
      }

      // Newest first: a trailing acknowledgement must not hide the report in
      // the preceding assistant message.
      const reports = spawned.replies.map((reply) =>
        parseConsolidationReport(reply, items.length),
      )
      let report =
        reports.find((candidate) => candidate.valid) ??
        reports[0] ??
        parseConsolidationReport("", items.length)
      // One correction turn for the only recoverable class: the writer forgot
      // the fences. Everything else keeps the permanent/poison path.
      if (!report.valid && report.error === "no report fence") {
        try {
          const corrected = await requestReportFences(
            ctx,
            spawned.sessionID,
            items.length,
            cfg.writer_agent,
            cfg.writer_model,
          )
          if (corrected?.valid) report = corrected
        } catch (err) {
          ctx.onWarn?.("memory brain: report-fence correction failed", err)
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
          ...telemetry,
        }
      }

      return {
        ok: true,
        consumed: report.consolidated,
        skipped: report.skipped,
        ...telemetry,
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
