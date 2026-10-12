import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createDiagnostics, getLogger, logSettingsFrom } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools, textOf } from "./lib/sessions.ts"
import { createStateStore } from "./lib/state.ts"
import { nowIso, sleep } from "./lib/util.ts"
import { automationChildSessions } from "./lib/automation.ts"
import { classifyTranscript } from "./lib/knowledge.ts"
import { openDecisionGate, type DecisionGate } from "./lib/decision-gate.ts"
import {
  atomicWriteFile,
  buildTurnTranscript,
  hasSubstantiveChange,
  setFrontmatterDate,
  splitWriterModel,
  validateNote,
  type SessionTurn,
} from "./lib/profile.ts"
import {
  DEFAULT_SOUL_PROMPTS,
  appendJournalEntry,
  buildSoulDecisionRequest,
  buildSoulInjectionBlock,
  buildSoulReviewRequest,
  buildSoulWriterPrompt,
  extractJournalEntry,
  extractSoulNote,
  journalTail,
  readSoulConfig,
  resolveSoulFile,
} from "./lib/soul.ts"

// First-person identity + episodic journal (the "soul"). The first-person
// counterpart to `profile-hook`: `Agent.md` is curated *about* the agent;
// `Soul.md` is written *by* it, distilled from the append-only journal.
//
// Two jobs, both gated by `soul.enabled`:
//
//   1. Injection — on the first turn of each top-level session the first-person
//      Soul note plus a bounded tail of the journal are injected as a `[soul]`
//      block, so a fresh session is situated in "who I am" and "how the last
//      iteration behaved and why", not just told a persona. Shares the profile's
//      injection budget philosophy (`soul.inject_max_bytes` mirrors `profile`).
//
//   2. Fold-down — on `session.idle` a turn-based cooldown arms a JEV `noul`
//      gate ("does the recent journal + session carry durable self-change?").
//      Only a confident true verdict spawns a short-lived `self-writer` child,
//      which redrafts `Soul.md` and emits one journal entry. The Soul note is
//      checked for substantive change and passed through a second `noul`
//      honesty/durability reviewer before the atomic write; the journal entry
//      (episodic, not identity) is appended when valid. Fail-open on the decide
//      gate, fail-closed on the reviewer.
//
// All work is fire-and-forget and serialized through a queue so a slow model or
// child can never block the session idle handler.

const SELF_WRITER_TITLE = "self-writer"
const POLL_MS = 1000

type SoulHookState = {
  idleTurns: number
  passSeq: number
}

const DEFAULT_STATE: SoulHookState = { idleTurns: 0, passSeq: 0 }

export default (async ({ client, directory }) => {
  const resolved = await readResolvedPaths(directory ?? process.cwd(), homedir())
  const logDir = resolved.logDir
  const stateDir = resolved.stateDir
  const vaultDir = resolved.vaultDir
  const soul = await readSoulConfig(directory ?? process.cwd())
  const STATE_FILE = join(stateDir, "soul-hook.json")
  if (!soul.enabled) return {}

  const logger = getLogger(logSettingsFrom(soul, "log", "log_"), {
    logDir,
    home: homedir(),
    channel: "soul-hook",
  })
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "soul-hook" })

  const gate: DecisionGate | null =
    soul.decide ? await openDecisionGate(directory ?? process.cwd()) : null

  const stateStore = createStateStore<SoulHookState>(STATE_FILE, DEFAULT_STATE, {
    onError: (err) => {
      void diag.error("[soul-hook] failed to write state file:", err)
    },
  })
  const state = await stateStore.read()

  const sessions = createSessionTools(client, directory ?? process.cwd())

  const soulPath = resolveSoulFile(vaultDir, soul.soul_file)
  const journalPath = resolveSoulFile(vaultDir, soul.journal_file)

  const firstTurn = new Set<string>()
  const injected = new Set<string>()
  const blockCache = new Map<string, string>()

  const readSoul = async (): Promise<string> => {
    try {
      return await readFile(soulPath, "utf8")
    } catch {
      return ""
    }
  }
  const readJournal = async (): Promise<string> => {
    try {
      return await readFile(journalPath, "utf8")
    } catch {
      return ""
    }
  }

  const buildInjection = async (): Promise<string> => {
    try {
      const s = await readSoul()
      const j = await readJournal()
      return buildSoulInjectionBlock(s, journalTail(j, soul.journal_tail_bytes), soul.inject_max_bytes)
    } catch (err) {
      void diag.error("[soul-hook] injection read failed:", err)
      return ""
    }
  }

  const readRecentTurns = async (sid: string): Promise<{ text: string; turns: number }> => {
    try {
      const res = await client.session.messages({ path: { id: sid }, query: { directory } })
      const rows = Array.isArray(res?.data) ? res.data : []
      const turns: SessionTurn[] = []
      let user = ""
      let assistant = ""
      for (let i = rows.length - 1; i >= 0; i--) {
        const info = (rows[i] as any)?.info ?? {}
        const t = textOf((rows[i] as any)?.parts ?? []).trim()
        if (!t) continue
        if (info.role === "assistant" && !assistant) assistant = t
        else if (info.role === "user" && !user) user = t
        if (user && assistant) {
          turns.unshift({ user, assistant })
          user = ""
          assistant = ""
          if (turns.length >= 3) break
        }
      }
      if (turns.length === 0 && (user || assistant)) turns.push({ user, assistant })
      if (turns.length === 0) return { text: "", turns: 0 }
      return { text: buildTurnTranscript(turns, 24000), turns: turns.length }
    } catch (err) {
      void diag.error("[soul-hook] failed to read recent turns:", err)
      return { text: "", turns: 0 }
    }
  }

  const generateWithChild = async (parentID: string, prompt: string): Promise<string> => {
    try {
      const created = await client.session.create({
        body: { parentID, title: SELF_WRITER_TITLE },
        query: { directory },
      })
      const childID = created?.data?.id
      if (!childID) return ""
      automationChildSessions.add(childID)

      const model = splitWriterModel(soul.writer_model)
      const res = await client.session.promptAsync({
        path: { id: childID },
        body: {
          agent: soul.writer_agent,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text: prompt }],
        },
      })
      if (res?.error || !res?.response?.ok) return ""

      const deadline = Date.now() + soul.child_timeout_ms
      while (Date.now() < deadline) {
        await sleep(POLL_MS)
        const msgs = await client.session.messages({ path: { id: childID }, query: { directory } })
        const rows = Array.isArray(msgs?.data) ? msgs.data : []
        let text = ""
        for (const row of rows) {
          const info = (row as any)?.info ?? {}
          if (info.role !== "assistant") continue
          const t = textOf((row as any)?.parts ?? []).trim()
          if (t) text = t
        }
        if (text) return text
      }
      return ""
    } catch (err) {
      void diag.error("[soul-hook] writer child failed:", err)
      return ""
    }
  }

  const runSoulPass = async (sid: string): Promise<void> => {
    if (!soul.enabled || !soul.decide || !gate) return

    const started = Date.now()
    const pass = `s${++state.passSeq}`

    state.idleTurns = state.idleTurns + 1
    const armedTurns = state.idleTurns
    await stateStore.write(state)
    if (armedTurns < soul.cooldown_turns) {
      await logger.append({
        ts: nowIso(),
        event: "soul-cooldown",
        pass,
        session: sid,
        idleTurns: armedTurns,
        cooldownTurns: soul.cooldown_turns,
      })
      return
    }

    const recent = await readRecentTurns(sid)
    if (!recent.text) {
      await logger.append({
        ts: nowIso(),
        event: "soul-pass",
        pass,
        session: sid,
        result: "no-transcript",
        durationMs: Date.now() - started,
      })
      return
    }

    if (classifyTranscript(recent.text, 800).skip) {
      await logger.append({ ts: nowIso(), event: "soul-prefilter-skip", pass, session: sid })
      return
    }

    // Decision is running: consume the cooldown.
    state.idleTurns = 0
    await stateStore.write(state)

    const journalTailText = journalTail(await readJournal(), soul.journal_tail_bytes)

    const { result, fallback, reason: fallbackReason } = await gate.decide(
      buildSoulDecisionRequest(journalTailText, recent.text, DEFAULT_SOUL_PROMPTS),
      { fallback: "open" },
    )
    await logger.append({
      ts: nowIso(),
      event: "soul-decision",
      pass,
      session: sid,
      value: result.value,
      confidence: result.confidence,
      fallback,
      fallbackReason,
      provider: result.provider,
      backend: result.backend,
      wallMs: result.wallMs ?? null,
      error: result.error ?? null,
    })

    if (fallback || result.abstained || result.value !== true) {
      await logger.append({
        ts: nowIso(),
        event: "soul-pass",
        pass,
        session: sid,
        result: fallback ? "decision-fallback" : "no-update",
        durationMs: Date.now() - started,
      })
      return
    }

    const current = await readSoul()
    const today = new Date().toISOString().slice(0, 10)
    const reply = await generateWithChild(
      sid,
      buildSoulWriterPrompt(soul.soul_file, current, journalTailText, recent.text, today, soul.note_max_bytes),
    )
    if (!reply) {
      await logger.append({ ts: nowIso(), event: "writer-no-reply", pass, session: sid })
      await logger.append({ ts: nowIso(), event: "soul-pass", pass, session: sid, result: "writer-no-reply" })
      return
    }

    // The journal entry (episodic) is appended whenever it is valid; the Soul
    // note (identity) additionally passes the substantive-change + honesty
    // review gates before it is written.
    const entry = extractJournalEntry(reply)
    if (entry) {
      const journalNow = await readJournal()
      await atomicWriteFile(journalPath, appendJournalEntry(journalNow, entry))
      await logger.append({ ts: nowIso(), event: "soul-journal-appended", pass, session: sid })
    }

    const note = extractSoulNote(reply)
    if (!note || !validateNote(current, note, soul.note_max_bytes)) {
      await logger.append({
        ts: nowIso(),
        event: "writer-invalid",
        pass,
        session: sid,
        replyBytes: Buffer.byteLength(reply, "utf8"),
      })
      await logger.append({ ts: nowIso(), event: "soul-pass", pass, session: sid, result: "writer-invalid" })
      return
    }

    if (!hasSubstantiveChange(current, note)) {
      await logger.append({ ts: nowIso(), event: "soul-pass", pass, session: sid, result: "no-op" })
      return
    }

    if (soul.review) {
      const rev = await gate.decide(
        buildSoulReviewRequest(soul.soul_file, current, note, recent.text, DEFAULT_SOUL_PROMPTS),
        { fallback: "open" },
      )
      const pTrue = typeof rev.result.probabilities?.true === "number" ? rev.result.probabilities.true : 0
      const accepted = !rev.fallback && rev.result.value === true && pTrue >= soul.review_threshold
      await logger.append({
        ts: nowIso(),
        event: "soul-review",
        pass,
        session: sid,
        pTrue,
        reviewThreshold: soul.review_threshold,
        accepted,
        fallback: rev.fallback,
        fallbackReason: rev.reason,
      })
      if (!accepted) {
        await logger.append({ ts: nowIso(), event: "soul-pass", pass, session: sid, result: "review-rejected" })
        return
      }
    }

    const updated = setFrontmatterDate(note, today)
    try {
      await atomicWriteFile(soulPath, updated)
      await logger.append({ ts: nowIso(), event: "soul-updated", pass, session: sid, file: soulPath })
      await logger.append({ ts: nowIso(), event: "soul-pass", pass, session: sid, result: "updated" })
    } catch (err) {
      await logger.append({
        ts: nowIso(),
        event: "soul-write-failed",
        pass,
        session: sid,
        error: err instanceof Error ? err.message : String(err),
      })
      await logger.append({ ts: nowIso(), event: "soul-pass", pass, session: sid, result: "write-failed" })
    }
  }

  let queue: Promise<void> = Promise.resolve()
  const scheduleSoulPass = (sid: string): void => {
    queue = queue.then(() => runSoulPass(sid)).catch((err) => {
      void diag.error("[soul-hook] soul pass failed:", err)
    })
  }

  return {
    "chat.message": async (input) => {
      if (!soul.inject) return
      const sid = input.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      if (injected.has(sid) || firstTurn.has(sid)) return
      firstTurn.add(sid)
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!soul.inject) return
      const sid = input.sessionID
      if (!sid || !firstTurn.has(sid)) return
      let block = blockCache.get(sid)
      if (block === undefined) {
        block = await buildInjection()
        blockCache.set(sid, block)
      }
      if (block) output.system.push(block)
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid) return

      if (firstTurn.has(sid)) {
        firstTurn.delete(sid)
        injected.add(sid)
        blockCache.delete(sid)
      }

      if (automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      scheduleSoulPass(sid)
    },
  }
}) satisfies Plugin
