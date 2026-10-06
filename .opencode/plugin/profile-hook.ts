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
  DEFAULT_PROFILE_PROMPTS,
  atomicWriteFile,
  buildInjectionBlock,
  buildProfileDecisionRequest,
  buildProfileReviewRequest,
  buildTurnTranscript,
  buildWriterPrompt,
  extractNote,
  hasSubstantiveChange,
  parseProfileTargets,
  readProfileConfig,
  readProfilePrompts,
  resolveProfileFile,
  resolveProfilePrompts,
  setFrontmatterDate,
  splitWriterModel,
  summarizePass,
  tickIdleTurn,
  validateNote,
  type ProfilePrompts,
  type SessionTurn,
} from "./lib/profile.ts"

// Personality + user awareness (docs/jev-decision-provider-plan.md adjacent).
//
// Two independent jobs, both gated by `profile.enabled`:
//
//   1. Injection — on the first turn of each top-level session the prompt-style
//      Agent (persona) and User (user context) instruction notes are read from
//      the vault and appended to the system prompt as directives
//      (experimental.chat.system.transform). `chat.message` marks
//      the first turn; the first `session.idle` clears it, so the block is
//      present for the whole first turn (tool steps included) and never after.
//      Child/automation sessions are excluded.
//
//   2. Idle update decision — on `session.idle` the last `decision_turns` turns
//      are run through a conservative deterministic prefilter (trivial chatter
//      is skipped) and a turn-based cooldown, then a JEV `choice` decision asks
//      whether either profile note learned something durable. Only a confident,
//      non-fallback verdict that names a note spawns a short-lived
//      `profile-writer` child to draft the updated file. The draft is then
//      checked for a substantive change (a date-only bump is a no-op) and, when
//      `profile.review` is on, passed to a second JEV `noul` gate that rejects
//      session-specific/task-decision additions before anything is written. Only
//      an accepted, changing draft is written directly (atomic rename).
//      Fail-open: a provider error/abstain never writes (the reviewer gate is
//      fail-closed). The choice instructions/criteria and the reviewer
//      assertion live in `profile.prompts_file`, so update frequency +
//      precision are tunable without touching the TS.
//
// All work is fire-and-forget and serialized through a queue so a slow model or
// child can never block the session idle handler.

const PROFILE_CHILD_TITLE = "profile-writer"
const POLL_MS = 1000

type ProfileHookState = {
  idleTurns: number
  passSeq: number
}

const DEFAULT_STATE: ProfileHookState = { idleTurns: 0, passSeq: 0 }

// Per-target result of an update attempt, aggregated by runProfilePass into the
// terminal `profile-pass` summary. `no-op` = draft carried no substantive change
// (date-only); `review-rejected` = the durability reviewer declined the draft.
type WriteOutcome =
  | "updated"
  | "missing"
  | "writer-no-reply"
  | "writer-invalid"
  | "write-failed"
  | "review-rejected"
  | "no-op"

export default (async ({ client, directory }) => {
  const resolved = await readResolvedPaths(directory ?? process.cwd(), homedir())
  const logDir = resolved.logDir
  const stateDir = resolved.stateDir
  const vaultDir = resolved.vaultDir
  const profile = await readProfileConfig(directory ?? process.cwd())
  const STATE_FILE = join(stateDir, "profile-hook.json")
  if (!profile.enabled) return {}

  const logger = getLogger(logSettingsFrom(profile, "log", "log_"), {
    logDir,
    home: homedir(),
    channel: "profile-hook",
  })
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "profile-hook" })

  // Externalized prompts (choice instructions/criteria + reviewer assertion).
  // Missing/unreadable/malformed -> built-in defaults, logged once at startup.
  const promptsFile = resolveProfilePrompts(directory ?? process.cwd(), profile.prompts_file)
  const prompts: ProfilePrompts = (await readProfilePrompts(promptsFile)) ?? DEFAULT_PROFILE_PROMPTS
  if (prompts === DEFAULT_PROFILE_PROMPTS) {
    await logger.append({
      ts: nowIso(),
      event: "profile-prompts-fallback",
      file: promptsFile,
    })
  }

  // Shared JEV gate (lib/decision-gate.ts) for the idle profile question and
  // the post-draft reviewer. `profile.decide` is this hook's switch and
  // `decisions.enabled` is the provider's master switch; either off (or a
  // failed gate) simply means the pass never writes.
  const gate: DecisionGate | null =
    profile.decide ? await openDecisionGate(directory ?? process.cwd()) : null

  const stateStore = createStateStore<ProfileHookState>(STATE_FILE, DEFAULT_STATE, {
    onError: (err) => {
      void diag.error("[profile-hook] failed to write state file:", err)
    },
  })

  const state = await stateStore.read()

  // Sub-agent children have a parentID; automation children are registered in
  // automationChildSessions. Both are excluded from injection and decisions.
  // Shared, cached child lookup (lib/sessions.ts); failures are best-effort.
  const sessions = createSessionTools(client, directory ?? process.cwd())

  // Injection bookkeeping: `firstTurn` = the session is mid-first-turn (block
  // injected on every request), `injected` = first turn completed (never again).
  const firstTurn = new Set<string>()
  const injected = new Set<string>()
  const blockCache = new Map<string, string>()

  const buildInjection = async (): Promise<string> => {
    try {
      const agent = await readFile(resolveProfileFile(vaultDir, profile.agent_file), "utf8")
      const user = await readFile(resolveProfileFile(vaultDir, profile.user_file), "utf8")
      return buildInjectionBlock(agent, user, profile.inject_max_bytes)
    } catch (err) {
      void diag.error("[profile-hook] injection read failed:", err)
      return ""
    }
  }

  const readRecentTurns = async (sid: string): Promise<{ text: string; turns: number }> => {
    try {
      const res = await client.session.messages({ path: { id: sid }, query: { directory } })
      const rows = Array.isArray(res?.data) ? res.data : []
      // Walk newest -> oldest, pairing each user message with its assistant
      // reply, until `decision_turns` exchanges are collected (or messages run
      // out). Reversed into chronological order for the transcript.
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
          if (turns.length >= profile.decision_turns) break
        }
      }
      if (turns.length === 0 && (user || assistant)) turns.push({ user, assistant })
      if (turns.length === 0) return { text: "", turns: 0 }
      return { text: buildTurnTranscript(turns, profile.decision_max_bytes), turns: turns.length }
    } catch (err) {
      void diag.error("[profile-hook] failed to read recent turns:", err)
      return { text: "", turns: 0 }
    }
  }

  // Spawn a short-lived profile-writer child, prompt it, and poll for its
  // assistant reply (the writer has no tools, so a single message is expected).
  const generateWithChild = async (parentID: string, prompt: string): Promise<string> => {
    try {
      const created = await client.session.create({
        body: { parentID, title: PROFILE_CHILD_TITLE },
        query: { directory },
      })
      const childID = created?.data?.id
      if (!childID) return ""
      automationChildSessions.add(childID)

      const model = splitWriterModel(profile.writer_model)
      const res = await client.session.promptAsync({
        path: { id: childID },
        body: {
          agent: profile.writer_agent,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text: prompt }],
        },
      })
      if (res?.error || !res?.response?.ok) return ""

      const deadline = Date.now() + profile.child_timeout_ms
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
      void diag.error("[profile-hook] writer child failed:", err)
      return ""
    }
  }

  const updateProfileFile = async (
    pass: string,
    sid: string,
    target: "agent" | "user",
    transcript: string,
    prompts: ProfilePrompts,
    decisionGate: DecisionGate,
  ): Promise<WriteOutcome> => {
    const leaf = target === "agent" ? profile.agent_file : profile.user_file
    const filePath = resolveProfileFile(vaultDir, leaf)
    let current = ""
    try {
      current = await readFile(filePath, "utf8")
    } catch {
      await logger.append({ ts: nowIso(), event: "profile-missing", pass, session: sid, file: filePath })
      return "missing"
    }

    const today = new Date().toISOString().slice(0, 10)
    const reply = await generateWithChild(
      sid,
      buildWriterPrompt(leaf, current, transcript, today, profile.note_max_bytes),
    )
    if (!reply) {
      await logger.append({ ts: nowIso(), event: "writer-no-reply", pass, session: sid, file: filePath })
      return "writer-no-reply"
    }

    const note = extractNote(reply)
    if (!note || !validateNote(current, note, profile.note_max_bytes)) {
      await logger.append({
        ts: nowIso(),
        event: "writer-invalid",
        pass,
        session: sid,
        file: filePath,
        replyBytes: Buffer.byteLength(reply, "utf8"),
      })
      return "writer-invalid"
    }

    // No substantive change (e.g. only the `updated:` date moved): skip both the
    // reviewer and the write so a pass never produces date-only churn.
    if (!hasSubstantiveChange(current, note)) {
      return "no-op"
    }

    // Post-draft durability/globalness gate: reject additions that only make
    // sense for the current session. Fail-closed for the write: the open
    // polarity reports `fallback` for a rules substitute, and a substituted
    // (abstaining) verdict never satisfies `accepted`.
    if (profile.review) {
      const { result, fallback, reason: fallbackReason } = await decisionGate.decide(
        buildProfileReviewRequest(leaf, current, note, transcript, prompts),
        { fallback: "open" },
      )
      const pTrue = typeof result.probabilities?.true === "number" ? result.probabilities.true : 0
      const accepted =
        !fallback && result.value === true && pTrue >= profile.review_threshold
      await logger.append({
        ts: nowIso(),
        event: "profile-review",
        pass,
        session: sid,
        target,
        pTrue,
        reviewThreshold: profile.review_threshold,
        accepted,
        fallback,
        fallbackReason,
        confidence: result.confidence,
        provider: result.provider,
        backend: result.backend,
        wallMs: result.wallMs ?? null,
        error: result.error ?? null,
      })
      if (!accepted) {
        await logger.append({
          ts: nowIso(),
          event: "profile-review-reject",
          pass,
          session: sid,
          target,
          pTrue,
          reviewThreshold: profile.review_threshold,
          accepted: false,
          fallback,
          fallbackReason,
        })
        return "review-rejected"
      }
    }

    const updated = setFrontmatterDate(note, today)
    const beforeBytes = Buffer.byteLength(current, "utf8")
    const afterBytes = Buffer.byteLength(updated, "utf8")
    try {
      await atomicWriteFile(filePath, updated)
      await logger.append({
        ts: nowIso(),
        event: "profile-updated",
        pass,
        session: sid,
        target,
        file: filePath,
        beforeBytes,
        afterBytes,
      })
      return "updated"
    } catch (err) {
      await logger.append({
        ts: nowIso(),
        event: "profile-write-failed",
        pass,
        session: sid,
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      })
      return "write-failed"
    }
  }

  const runProfilePass = async (sid: string): Promise<void> => {
    if (!profile.enabled || !profile.decide || !gate) return

    const started = Date.now()
    const pass = `p${++state.passSeq}`

    // Turn-based cooldown: every top-level idle increments the persisted
    // counter; the pass only proceeds once it reaches `cooldown_turns`. The
    // counter is reset only when a decision actually runs (below), so a
    // triage-skipped or empty turn at the boundary keeps the pass armed.
    const tick = tickIdleTurn(state.idleTurns, profile.cooldown_turns)
    state.idleTurns = tick.idleTurns
    const armedTurns = state.idleTurns
    await stateStore.write(state)
    if (!tick.ready) {
      await logger.append({
        ts: nowIso(),
        event: "profile-cooldown",
        pass,
        session: sid,
        idleTurns: state.idleTurns,
        cooldownTurns: profile.cooldown_turns,
      })
      return
    }

    const recent = await readRecentTurns(sid)
    const transcriptBytes = Buffer.byteLength(recent.text, "utf8")
    if (!recent.text) {
      await logger.append({
        ts: nowIso(),
        ...summarizePass({
          pass,
          session: sid,
          result: "no-transcript",
          idleTurns: armedTurns,
          cooldownTurns: profile.cooldown_turns,
          durationMs: Date.now() - started,
        }),
      })
      return
    }

    if (profile.skip_triage && classifyTranscript(recent.text, profile.skip_triage_max_bytes).skip) {
      await logger.append({ ts: nowIso(), event: "profile-prefilter-skip", pass, session: sid })
      await logger.append({
        ts: nowIso(),
        ...summarizePass({
          pass,
          session: sid,
          result: "prefilter-skip",
          idleTurns: armedTurns,
          cooldownTurns: profile.cooldown_turns,
          transcriptTurns: recent.turns,
          transcriptBytes,
          durationMs: Date.now() - started,
        }),
      })
      return
    }

    // Decision is running: consume the cooldown (reset the turn counter).
    state.idleTurns = 0
    await stateStore.write(state)

    const { result, fallback, reason: fallbackReason } = await gate.decide(
      buildProfileDecisionRequest(recent.text, prompts),
      { fallback: "open" },
    )
    const verdict = typeof result.value === "string" ? result.value : undefined
    const targets = parseProfileTargets(result.value)
    await logger.append({
      ts: nowIso(),
      event: "profile-decision",
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
      targets,
      transcriptTurns: recent.turns,
      transcriptBytes,
    })

    if (fallback || result.abstained) {
      await logger.append({
        ts: nowIso(),
        ...summarizePass({
          pass,
          session: sid,
          result: fallback ? "decision-fallback" : "decision-abstain",
          idleTurns: armedTurns,
          cooldownTurns: profile.cooldown_turns,
          verdict,
          confidence: result.confidence,
          fallback,
          fallbackReason,
          transcriptTurns: recent.turns,
          transcriptBytes,
          durationMs: Date.now() - started,
        }),
      })
      return
    }

    if (targets.length === 0) {
      await logger.append({
        ts: nowIso(),
        ...summarizePass({
          pass,
          session: sid,
          result: "no-update",
          idleTurns: armedTurns,
          cooldownTurns: profile.cooldown_turns,
          verdict,
          confidence: result.confidence,
          fallback,
          fallbackReason,
          transcriptTurns: recent.turns,
          transcriptBytes,
          durationMs: Date.now() - started,
        }),
      })
      return
    }

    const updated: string[] = []
    const failed: string[] = []
    const noop: string[] = []
    for (const target of targets) {
      const outcome = await updateProfileFile(pass, sid, target, recent.text, prompts, gate)
      if (outcome === "updated") updated.push(target)
      else if (outcome === "no-op") noop.push(target)
      else failed.push(target)
    }
    await logger.append({
      ts: nowIso(),
      ...summarizePass({
        pass,
        session: sid,
        result:
          updated.length > 0
            ? "updated"
            : failed.length > 0
              ? "update-failed"
              : "no-op",
        idleTurns: armedTurns,
        cooldownTurns: profile.cooldown_turns,
        verdict,
        confidence: result.confidence,
        fallback,
        fallbackReason,
        targets,
        updated,
        failed,
        noop,
        transcriptTurns: recent.turns,
        transcriptBytes,
        durationMs: Date.now() - started,
      }),
    })
  }

  let queue: Promise<void> = Promise.resolve()
  const scheduleProfilePass = (sid: string): void => {
    queue = queue.then(() => runProfilePass(sid)).catch((err) => {
      void diag.error("[profile-hook] profile pass failed:", err)
    })
  }

  return {
    "chat.message": async (input) => {
      if (!profile.inject) return
      const sid = input.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      if (injected.has(sid) || firstTurn.has(sid)) return
      firstTurn.add(sid)
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!profile.inject) return
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

      // First turn finished: stop injecting this session, ever.
      if (firstTurn.has(sid)) {
        firstTurn.delete(sid)
        injected.add(sid)
        blockCache.delete(sid)
      }

      if (automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      scheduleProfilePass(sid)
    },
  }
}) satisfies Plugin
