import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { automationChildSessions } from "./lib/automation.ts"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { atomicWrite } from "./lib/fsx.ts"
import { createDiagnostics, getLogger, logSettingsFrom } from "./lib/logging.ts"
import { readResolvedPaths, SYSCONFIG } from "./lib/paths.ts"
import { createSessionTools, textOf } from "./lib/sessions.ts"
import { createStateStore } from "./lib/state.ts"
import { nowIso } from "./lib/util.ts"
import { blockingIssues, takeIssues } from "./lib/verification.ts"
import {
  RulesProvider,
  buildDecisionsLogEntry,
  buildIngestRequest,
  createDecisionProvider,
  decideWithFallback,
  isGateSkip,
  readDecisionsConfig,
} from "./lib/decisions.ts"
import {
  buildDrainPrompt,
  buildTagIndex,
  candidateTags,
  classifyTurn,
  drainAccounting,
  extractKeywords,
  findCandidateNotes,
  hasDurableSignal,
  parseConsolidated,
  parseSkipped,
  readKnowledgeConfig,
  recoverMislabeledConsolidated,
  resolveMemoryFile,
  resolveTagIndexFile,
  selectDrainBatch,
  spawnDrainChild,
  TURN_AGENT,
  type CandidateNote,
  type TagIndexEntry,
} from "./lib/autonomy.ts"
import {
  appendMemoryEntry,
  normalizeMemoryFile,
  pruneConsumed,
  readMemory,
  searchTemporal,
  type MemoryDraft,
  type MemoryEntry,
  type TemporalHit,
} from "./lib/temporal.ts"

// Deterministic capture + async consolidation over the single project-local
// temporal-memory buffer (.opencode/state/memory.json), plus the deterministic
// `temporal_search` tool exposed only to rag-search. See
// docs/temporal-memory-plan.md.
//
// Capture (no LLM by default): `chat.message` stashes the user text;
// `session.idle` appends the completed turn (user + assistant + JEV tags /
// salience when enabled) to a JSON array. Consolidation: unconsumed turns are
// run through a conservative deterministic prefilter, an optional per-turn JEV
// ingest gate, batched, and handed verbatim to one rag-brain child; the child
// reports `#<seq>` outcomes and the consumed turns are pruned. Failures retain
// turns for retry (never lose a turn).

const DRAIN_TIMEOUT_MS = 180000

// One-shot re-ask when a consolidation child finishes without emitting its
// outcome blocks. The child intermittently ends on an empty final assistant
// message after its writes, so the fence-based completion check sees nothing
// even though the work is done. This asks for the report ONLY — no tools, no
// reads, no writes — and a genuine failure still falls through to the
// deterministic retain-and-retry path.
const DRAIN_REASK =
  "You finished but did not include the outcome blocks. Do NOT call any tools and " +
  "do NOT read or write anything — the work is already done. Reply with ONLY these " +
  "two blocks, listing each turn id exactly once (consolidated = you wrote or " +
  "updated a durable note for it; skipped = it held no durable knowledge):\n" +
  "```consolidated\n#<seq>\n```\n```skipped\n#<seq>\n```"

const z = tool.schema

type KnowledgeHookState = {
  lastDrainAt: number | null
  lastError: string | null
  lastFailureTime: string | null
  notifiedError: string | null
}

const DEFAULT_STATE: KnowledgeHookState = {
  lastDrainAt: null,
  lastError: null,
  lastFailureTime: null,
  notifiedError: null,
}

function renderTemporalHits(hits: TemporalHit[]): string {
  if (hits.length === 0) return "No un-consumed turns matched."
  const lines: string[] = [`${hits.length} un-consumed turn(s) (deterministic BM25):`]
  for (const h of hits) {
    const meta = [`#${h.seq}`, `session ${h.session}`, h.ts].filter(Boolean)
    if (typeof h.salience === "number") meta.push(`salience ${h.salience}`)
    if (h.tags.length > 0) meta.push(`tags: ${h.tags.join(", ")}`)
    lines.push(`- ${meta.join(" | ")} (score ${h.score})`)
    lines.push(`  ${h.snippet}`)
  }
  return lines.join("\n")
}

export default (async ({ client, directory }) => {
  const resolved = await readResolvedPaths(directory, homedir())
  const sysopDir = resolved.sysopDir
  const vaultDir = resolved.vaultDir
  const stateDir = resolved.stateDir
  const config = await readKnowledgeConfig(directory)
  const memoryFile = resolveMemoryFile(stateDir, config)
  const tagIndexFile = resolveTagIndexFile(stateDir, config)
  const STATE_FILE = join(sysopDir, "knowledge-hook.json")
  const logger = getLogger(logSettingsFrom(config, "log", "log_"), {
    sysopDir,
    home: homedir(),
    channel: "knowledge-hook",
  })
  const diag = createDiagnostics({ sysopDir, home: homedir(), channel: "knowledge-hook" })

  const decisions = await readDecisionsConfig(directory)
  const gateActive = decisions.enabled && decisions.mode === "gate"
  const shadowActive = decisions.enabled && decisions.mode === "shadow"
  const tagActive = config.tag_gate && decisions.enabled
  const provider = decisions.enabled
    ? createDecisionProvider(decisions, { configPath: join(directory, SYSCONFIG) })
    : null
  const rules = decisions.enabled ? new RulesProvider() : null
  // Shadow/gate decisions are journaled here now that the legacy raw-session
  // jev-hook is retired (it was the sole writer of decisions.log).
  const decisionLogger = decisions.enabled
    ? getLogger(logSettingsFrom(decisions, "ledger", "log_"), {
        sysopDir,
        home: homedir(),
        channel: "knowledge-hook",
      })
    : null

  const stateStore = createStateStore<KnowledgeHookState>(STATE_FILE, DEFAULT_STATE, {
    onError: (err) => {
      void diag.error("[knowledge-hook] failed to write state file:", err)
    },
  })

  let state = await stateStore.read()
  let draining = false

  const pendingUserText = new Map<string, string>()
  const lastCaptured = new Map<string, string>()
  const childIdleResolvers = new Map<string, () => void>()

  // Tag index cache (Phase 3). Rebuilt on demand when missing/invalid and
  // invalidated after every ingestion cycle (which may have minted a new tag).
  let tagIndex: TagIndexEntry[] | null = null

  const loadTagIndex = async (): Promise<TagIndexEntry[]> => {
    if (tagIndex) return tagIndex
    try {
      const raw = await readFile(tagIndexFile, "utf8")
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        tagIndex = parsed as TagIndexEntry[]
        return tagIndex
      }
    } catch {
      // missing / invalid — rebuild below
    }
    tagIndex = await buildTagIndex(vaultDir)
    await atomicWrite(tagIndexFile, JSON.stringify(tagIndex)).catch((err) => {
      void diag.error("[knowledge-hook] failed to write tag index:", err)
    })
    return tagIndex
  }

  const readChildMessages = async (childID: string): Promise<any[]> => {
    try {
      const res = await client.session.messages({ path: { id: childID }, query: { directory } })
      return Array.isArray(res?.data) ? res.data : []
    } catch {
      return []
    }
  }

  const sessions = createSessionTools(client, directory, {
    onError: (err, ctx) => {
      if (ctx === "get") void diag.error("[knowledge-hook] session.get failed:", err)
    },
  })

  const waitForChildIdle = (childID: string): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        childIdleResolvers.delete(childID)
        resolve(false) // timed out
      }, DRAIN_TIMEOUT_MS)
      childIdleResolvers.set(childID, () => {
        clearTimeout(timer)
        childIdleResolvers.delete(childID)
        resolve(true)
      })
    })

  const getChildReply = async (childID: string): Promise<{ reply: string; timedOut: boolean }> => {
    const idled = await waitForChildIdle(childID)
    for (let i = 0; i < 5; i++) {
      const t = await sessions.lastAssistantText(childID)
      if (t) return { reply: t, timedOut: !idled }
      await new Promise((r) => setTimeout(r, 300))
    }
    return { reply: "", timedOut: !idled }
  }

  // Ask a finished consolidation child to emit its outcome blocks. Registers the
  // idle waiter BEFORE prompting so the child's next `session.idle` is caught.
  // Best-effort: any transport failure yields "" and the caller retains the turns.
  const reaskForOutcome = async (childID: string): Promise<string> => {
    const reIdle = waitForChildIdle(childID)
    try {
      const res = await (client as any).session.promptAsync({
        path: { id: childID },
        body: { agent: TURN_AGENT, parts: [{ type: "text", text: DRAIN_REASK }] },
        query: { directory },
      })
      if (res?.error || (res?.response && !res.response.ok)) {
        childIdleResolvers.delete(childID)
        return ""
      }
    } catch (err) {
      void diag.error("[knowledge-hook] drain re-ask failed:", err)
      childIdleResolvers.delete(childID)
      return ""
    }
    const idled = await reIdle
    if (!idled) return ""
    for (let i = 0; i < 5; i++) {
      const t = await sessions.lastAssistantText(childID)
      if (t) return t
      await new Promise((r) => setTimeout(r, 300))
    }
    return ""
  }

  const recordFailure = async (sid: string, err: unknown): Promise<void> => {
    const errorText = err instanceof Error ? err.message : String(err)
    state.lastError = errorText
    state.lastFailureTime = nowIso()
    if (state.notifiedError !== errorText) {
      try {
        const res = await client.session.promptAsync({
          path: { id: sid },
          body: {
            parts: [{ type: "text", text: `[knowledge-hook] consolidation failed: ${errorText}` }],
            noReply: true,
          },
        })
        if (res?.error || !res?.response?.ok) {
          throw new Error(`surface prompt rejected: ${res?.response?.status}`)
        }
        state.notifiedError = errorText
      } catch (notifyErr) {
        void diag.error("[knowledge-hook] failed to surface error:", notifyErr)
      }
    }
    await stateStore.write(state)
  }

  const surfaceFailure = async (sid: string, message: string): Promise<void> => {
    if (state.notifiedError === message) return
    try {
      const res = await client.session.promptAsync({
        path: { id: sid },
        body: { parts: [{ type: "text", text: `[knowledge-hook] ${message}` }], noReply: true },
      })
      if (res?.error || !res?.response?.ok) {
        throw new Error(`surface prompt rejected: ${res?.response?.status}`)
      }
      state.notifiedError = message
      await stateStore.write(state)
    } catch (err) {
      void diag.error("[knowledge-hook] failed to surface:", err)
    }
  }

  // Capture-time JEV tagging (Phase 3, plan §11). Only durable turns are
  // tagged/scored, and any failure degrades to empty tags / null salience —
  // capture must never block on the JEV.
  const tagTurn = async (entry: Pick<MemoryDraft, "user" | "assistant">): Promise<{
    tags: string[]
    salience: number | null
    newTag: string | null
  }> => {
    const empty = { tags: [] as string[], salience: null as number | null, newTag: null as string | null }
    if (!tagActive || !provider || !rules) return empty
    const content = entry.user + "\n" + entry.assistant
    if (!hasDurableSignal(content)) return empty

    const keywords = extractKeywords(content)
    const index = await loadTagIndex()
    const candidates = candidateTags(keywords, index, config.tag_candidates)

    let tags: string[] = []
    let newTag: string | null = null
    try {
      const { result } = await decideWithFallback(
        provider,
        {
          kind: "choice",
          state: content,
          candidates: [...candidates, "NEW"],
          criteria:
            "Pick the existing tags that best categorize this turn. Choose NEW only if none of the existing tags fit.",
        },
        rules,
      )
      if (!result.abstained && typeof result.value === "string") {
        if (result.value === "NEW") newTag = keywords[0] ?? null
        else tags = [result.value]
      }
    } catch (err) {
      void diag.error("[knowledge-hook] capture tag choice failed:", err)
    }

    let salience: number | null = null
    try {
      const { result } = await decideWithFallback(
        provider,
        {
          kind: "score",
          state: content,
          criteria:
            "How durable/useful is this turn for future retrieval, independent of any note? (1 = ephemeral, 5 = core knowledge)",
        },
        rules,
      )
      // The bridge returns the score as a leveled label (a string like "3"),
      // not a number — accept either, then clamp to the 1-5 ordinal scale.
      if (!result.abstained) {
        const raw = result.value
        const n =
          typeof raw === "number"
            ? raw
            : typeof raw === "string" && raw.trim() !== ""
              ? Number(raw)
              : Number.NaN
        if (Number.isFinite(n)) salience = Math.min(5, Math.max(1, Math.round(n)))
      }
    } catch (err) {
      void diag.error("[knowledge-hook] capture salience score failed:", err)
    }

    return { tags, salience, newTag }
  }

  const captureTurn = async (sid: string): Promise<void> => {
    let assistant = ""
    let assistantId = ""
    let userTextFromMsgs = ""
    try {
      const res = await client.session.messages({ path: { id: sid }, query: { directory } })
      const rows = Array.isArray(res?.data) ? res.data : []
      for (let i = rows.length - 1; i >= 0; i--) {
        const info = (rows[i] as any)?.info ?? {}
        const t = textOf((rows[i] as any)?.parts ?? []).trim()
        if (!t) continue
        if (info.role === "assistant" && !assistant) {
          assistant = t
          assistantId = String(info.id ?? "")
        } else if (info.role === "user" && !userTextFromMsgs) {
          userTextFromMsgs = t
        }
        if (assistant && userTextFromMsgs) break
      }
    } catch (err) {
      void diag.error("[knowledge-hook] failed to fetch assistant reply:", err)
      return
    }

    if (!assistant) return
    if (lastCaptured.get(sid) === assistantId) return

    const userText = pendingUserText.get(sid) ?? userTextFromMsgs
    if (!userText) return

    try {
      const tagging = await tagTurn({ user: userText, assistant })
      await appendMemoryEntry(memoryFile, {
        session: sid,
        ts: nowIso(),
        user: userText,
        assistant,
        ...tagging,
      })
      // Mark captured / consume the pending text only AFTER a successful append,
      // so a failed write is retried rather than silently dropped.
      lastCaptured.set(sid, assistantId)
      pendingUserText.delete(sid)
    } catch (err) {
      void diag.error("[knowledge-hook] failed to append memory entry:", err)
    }
  }

  const ingestIfNeeded = async (sid: string, opts: { force?: boolean } = {}): Promise<void> => {
    if (draining) return
    draining = true
    const startedAt = Date.now()
    try {
      const entries = (await readMemory(memoryFile)).sort((a, b) => a.seq - b.seq)
      if (entries.length === 0) return

      const now = Date.now()
      const staleThreshold = config.max_turn_age > 0 ? now - config.max_turn_age : 0
      const stale = config.max_turn_age > 0 && entries.some((e) => {
        const t = Date.parse(e.ts)
        return Number.isFinite(t) && t < staleThreshold
      })
      const forced = opts.force === true || stale
      if (entries.length < config.min_ready_turns && !forced) return
      if (!forced && state.lastDrainAt && now - state.lastDrainAt < config.drain_cooldown_ms) return

      // Deterministic per-turn prefilter: auto-prune only unambiguously trivial
      // turns, no LLM.
      const autoDropped: number[] = []
      let candidates: MemoryEntry[] = entries
      if (config.skip_triage) {
        candidates = []
        for (const e of entries) {
          const verdict = classifyTurn(e, config.skip_triage_max_bytes)
          if (verdict.skip) autoDropped.push(e.seq)
          else candidates.push(e)
        }
      }
      if (autoDropped.length > 0) {
        const pruned = await pruneConsumed(memoryFile, new Set(autoDropped))
        await logger.append({
          ts: nowIso(),
          event: "prefilter-skip",
          turns: autoDropped,
          count: autoDropped.length,
          pruned,
        })
      }
      if (candidates.length === 0) return

      // Per-turn JEV ingest gate. Fail-open: only a confident, non-fallback "no
      // durable knowledge" verdict drops a turn. In shadow mode the decision is
      // journaled but every turn is ingested.
      const gateDropped: number[] = []
      let kept = candidates
      if ((gateActive || shadowActive) && provider && rules) {
        kept = []
        for (const e of candidates) {
          const content = e.user + "\n" + e.assistant
          const { result, fallback, fallbackReason } = await decideWithFallback(
            provider,
            buildIngestRequest(content, config.skip_triage_max_bytes),
            rules,
          )
          if (decisionLogger) {
            await decisionLogger.append(
              buildDecisionsLogEntry({
                session: e.session,
                result,
                rulesVerdict: classifyTurn(e, config.skip_triage_max_bytes),
                fallback,
                fallbackReason,
                mode: decisions.mode,
              }),
            )
          }
          if (gateActive && isGateSkip(result, fallback, decisions.noul_threshold)) {
            gateDropped.push(e.seq)
          } else {
            kept.push(e)
          }
        }
        if (gateDropped.length > 0) {
          const pruned = await pruneConsumed(memoryFile, new Set(gateDropped))
          await logger.append({
            ts: nowIso(),
            event: "gate-skip",
            turns: gateDropped,
            count: gateDropped.length,
            pruned,
          })
        }
      }
      if (kept.length === 0) return

      const selection = selectDrainBatch(kept, config.batch_turns, config.drain_max_tokens)
      state.lastDrainAt = now
      await stateStore.write(state)

      // Deterministic dedupe prefetch over the batch.
      let candidatesNotes: CandidateNote[] = []
      try {
        const keywords = extractKeywords(selection.batch.map((e) => e.user + " " + e.assistant).join("\n"))
        candidatesNotes = await findCandidateNotes(vaultDir, memoryFile, keywords, config.prefetch_candidates)
      } catch (err) {
        void diag.error("[knowledge-hook] prefetch failed:", err)
      }

      const prompt = buildDrainPrompt(selection.batch, candidatesNotes)
      const spawned = await spawnDrainChild(client as any, { parentID: sid, directory, prompt })
      if (!spawned.ok) {
        await recordFailure(sid, new Error(spawned.error ?? "ingest spawn failed"))
        await logger.append({ ts: nowIso(), event: "ingest-spawn-failed", error: spawned.error })
        return
      }

      const { reply, timedOut } = await getChildReply(spawned.sessionID)
      const childMessages = await readChildMessages(spawned.sessionID)
      const acct = drainAccounting(childMessages)

      if (!reply) {
        await recordFailure(sid, new Error(timedOut ? "ingest child timed out" : "ingest child produced no reply"))
        await logger.append({
          ts: nowIso(),
          event: timedOut ? "ingest-timeout" : "ingest-no-reply",
          batch: selection.batch.map((e) => e.seq),
          child: acct,
          durationMs: Date.now() - startedAt,
        })
        return
      }

      const guardIssues = blockingIssues(takeIssues(spawned.sessionID))
      if (guardIssues.length > 0) {
        await surfaceFailure(
          sid,
          `write verification incomplete for ${guardIssues.length} note(s) ` +
            `(turns retained for retry): ${guardIssues.map((i) => i.path).join(", ")}`,
        )
        await logger.append({
          ts: nowIso(),
          event: "ingest-verification-blocked",
          batch: selection.batch.map((e) => e.seq),
          issues: guardIssues,
          child: acct,
          durationMs: Date.now() - startedAt,
        })
        return
      }

      const batchSeqs = new Set(selection.batch.map((e) => e.seq))
      let ok = parseConsolidated(reply)
      let skipped = parseSkipped(reply)
      let recovered = recoverMislabeledConsolidated(reply, selection.batch.map((e) => e.seq))
      for (const s of recovered) ok.add(s)

      // No batch turn was reported in either block: the child likely wrote its
      // notes but ended without its summary. Re-ask once for the report before
      // treating the cycle as failed (and retaining the turns).
      let reasked = false
      if (![...ok, ...skipped].some((s) => batchSeqs.has(s))) {
        reasked = true
        const reReply = await reaskForOutcome(spawned.sessionID)
        if (reReply) {
          ok = parseConsolidated(reReply)
          skipped = parseSkipped(reReply)
          recovered = recoverMislabeledConsolidated(reReply, selection.batch.map((e) => e.seq))
          for (const s of recovered) ok.add(s)
        }
        await logger.append({
          ts: nowIso(),
          event: "ingest-reask",
          batch: [...batchSeqs],
          reported: [...ok, ...skipped].filter((s) => batchSeqs.has(s)),
        })
      }

      const consumed = new Set([...ok, ...skipped].filter((s) => batchSeqs.has(s)))
      const failed = selection.batch.filter((e) => !consumed.has(e.seq))
      const pruned = await pruneConsumed(memoryFile, consumed)

      // A cycle may have minted a new tag; drop the cache so the next capture
      // rebuilds it.
      tagIndex = null

      if (failed.length > 0) {
        await surfaceFailure(
          sid,
          `consolidation did not complete for turn(s): ${failed.map((e) => `#${e.seq}`).join(", ")} (kept for retry)`,
        )
      } else {
        state.notifiedError = null
      }
      await stateStore.write(state)

      if (selection.overshoot) {
        await surfaceFailure(
          sid,
          `ingest batch exceeds knowledge.drain_max_tokens (~${selection.tokens} tokens > ` +
            `${config.drain_max_tokens}); ingested ${selection.batch.length} turn(s) alone — ` +
            `raise the cap to batch more per cycle.`,
        )
      }

      await logger.append({
        ts: nowIso(),
        event: "ingest",
        batch: selection.batch.map((e) => e.seq),
        sessions: [...new Set(selection.batch.map((e) => e.session))],
        turns: selection.batch.length,
        bytes: selection.bytes,
        tokensEst: selection.tokens,
        overshoot: selection.overshoot,
        autoDropped: autoDropped.length,
        gateDropped: gateDropped.length,
        gateDroppedSeqs: gateDropped,
        outcome: {
          consolidated: [...ok].length,
          skipped: [...skipped].length,
          failed: failed.length,
        },
        consolidated: [...ok],
        skipped: [...skipped],
        recovered: [...recovered],
        reasked,
        pruned,
        child: acct,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      void diag.error("[knowledge-hook] ingest failed:", err)
      await logger.append({ ts: nowIso(), event: "ingest-error", error: err instanceof Error ? err.message : String(err) })
    } finally {
      draining = false
    }
  }

  // Startup catch-up (plan §8.2): if a backlog survived the last exit, run one
  // cycle immediately (bypassing the cooldown) instead of waiting for a future
  // session to idle. Deferred to a timer so plugin init returns first.
  const startupCatchUp = async (): Promise<void> => {
    try {
      const migrated = await normalizeMemoryFile(memoryFile)
      if (migrated) {
        await logger.append({ ts: nowIso(), event: "memory-format-migrated" })
      }
      const entries = await readMemory(memoryFile)
      if (entries.length === 0) return
      const created = await (client as any).session.create({
        body: { title: "knowledge-catchup" },
        query: { directory },
      })
      const parentID = created?.data?.id
      if (!parentID) return
      automationChildSessions.add(parentID)
      await ingestIfNeeded(parentID, { force: true })
    } catch (err) {
      void diag.error("[knowledge-hook] startup catch-up failed:", err)
    }
  }
  setTimeout(() => {
    void startupCatchUp()
  }, 0)

  return {
    tool: {
      temporal_search: tool({
        description:
          "Deterministic keyword/BM25 search over un-consumed conversation turns stored in .opencode/state/memory.json. Returns turn ids (seq), session, tags, salience, a snippet, and a BM25 score. Use to surface recent, not-yet-consolidated memory alongside the vault.",
        args: {
          query: z.string().describe("Search query"),
          top_k: z.number().int().min(1).max(20).optional().describe("Max hits (default 5, cap 20)"),
          tags: z.array(z.string()).optional().describe("Restrict to turns carrying one of these tags"),
          session: z.string().optional().describe("Restrict to a single session id"),
        },
        execute: async (args) => {
          if (!config.enabled) return "temporal_search: knowledge pipeline disabled"
          try {
            const hits = searchTemporal(memoryFile, {
              query: args.query,
              topK: args.top_k,
              tags: args.tags,
              session: args.session,
            })
            return renderTemporalHits(hits)
          } catch (err) {
            return `temporal_search error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),
    },

    "chat.message": async (input, output) => {
      const sid = input.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (!config.enabled) return
      if (await sessions.isChild(sid)) return
      const text = textOf((output as any)?.parts ?? []).trim()
      if (!text) return
      pendingUserText.set(sid, text)
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      // A drain child we are awaiting has just finished: resolve its waiter
      // before the child-skip below (drain children are in the skip set).
      const waiter = sid ? childIdleResolvers.get(sid) : undefined
      if (waiter) {
        childIdleResolvers.delete(sid)
        waiter()
        return
      }
      if (!sid || automationChildSessions.has(sid)) return
      if (!config.enabled) return
      if (await sessions.isChild(sid)) return

      await captureTurn(sid)
      await ingestIfNeeded(sid)
    },
  }
}) satisfies Plugin
