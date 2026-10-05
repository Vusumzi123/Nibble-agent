import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { automationChildSessions } from "./lib/automation.ts"
import { createDiagnostics, getLogger, logSettingsFrom } from "./lib/logging.ts"
import { createNotifier } from "./lib/notify.ts"
import { readResolvedPaths, SYSCONFIG } from "./lib/paths.ts"
import { createSessionTools, textOf } from "./lib/sessions.ts"
import { createStateStore } from "./lib/state.ts"
import { nowIso, sleep } from "./lib/util.ts"
import { atomicWrite } from "./lib/fsx.ts"
import { buildTurnTranscript, readProfileConfig, type SessionTurn } from "./lib/profile.ts"
import {
  RulesProvider,
  createDecisionProvider,
  decideWithFallback,
  readDecisionsConfig,
  type DecisionProvider,
} from "./lib/decisions.ts"
import {
  DEFAULT_IDEA_HOOK_STATE,
  DEFAULT_IDEA_PROMPTS,
  IDEA_CATEGORIES,
  appendIdeaToBucket,
  buildGeneratePrompt,
  buildIdeaReviewRequest,
  drawDailyCount,
  drawDueTimes,
  drawWeightedIndex,
  extractIdea,
  ideaHash,
  ideaId,
  isDuplicate,
  isDue,
  isInActiveWindow,
  localDayKey,
  parseBucket,
  parseWeights,
  readIdeaConfig,
  readIdeaPrompts,
  resolveIdeaFile,
  resolveIdeaPrompts,
  reviewAccepted,
  setFrontmatterDate,
  splitWriterModel,
  type IdeaCategory,
  type IdeaConfig,
  type IdeaHookState,
  type IdeaPrompts,
} from "./lib/idea.ts"

// Idea generation (docs/idea-hook-plan.md).
//
// Time-driven, not turn-driven: a timer tick (plus a startup catch-up and a
// cheap due-check on session idle) draws up to ~2 ideas/day, builds a
// deterministic context (recent turns + profile/seed excerpts + existing idea
// titles), spawns a tool-free `idea-generator` child, then dedupes and reviews
// the reply before appending it to the bucket note (idea.bucket_file).
//
// The expression half (Telegram + email) is a standalone systemd script
// (.opencode/scripts/idea-express.py) that only reads the bucket — it needs no
// model and works while opencode is closed.
//
// All work is fire-and-forget and serialized by a single-flight guard so a slow
// child can never block a session. Fail-open: any error only logs.

const CHILD_TITLE = "idea-generator"
const POLL_MS = 1000

export default (async ({ client, directory }) => {
  const projectDir = directory ?? process.cwd()
  const resolved = await readResolvedPaths(projectDir, homedir())
  const sysopDir = resolved.sysopDir
  const vaultDir = resolved.vaultDir
  const stateDir = resolved.stateDir
  const config = await readIdeaConfig(projectDir)
  const STATE_FILE = join(sysopDir, "idea-hook.json")
  if (!config.enabled) return {}

  const bucketFile = resolveIdeaFile(vaultDir, config.bucket_file)
  const profileCfg = await readProfileConfig(projectDir)
  const tagIndexFile = join(stateDir, "tag-index.json")

  const logger = getLogger(logSettingsFrom(config, "log", "log_"), {
    sysopDir,
    home: homedir(),
    channel: "idea-hook",
  })
  const diag = createDiagnostics({ sysopDir, home: homedir(), channel: "idea-hook" })
  const notifier = createNotifier({
    client,
    directory: projectDir,
    enabled: config.notify,
    channel: "idea-hook",
  })

  const promptsFile = resolveIdeaPrompts(projectDir, config.prompts_file)
  const prompts: IdeaPrompts = (await readIdeaPrompts(promptsFile)) ?? DEFAULT_IDEA_PROMPTS
  if (prompts === DEFAULT_IDEA_PROMPTS) {
    await logger.append({ ts: nowIso(), event: "idea-prompts-fallback", file: promptsFile })
  }

  const decisions = await readDecisionsConfig(projectDir)
  const provider: DecisionProvider | null = decisions.enabled
    ? createDecisionProvider(decisions, { configPath: join(projectDir, SYSCONFIG) })
    : null
  const rules = new RulesProvider()

  const stateStore = createStateStore<IdeaHookState>(STATE_FILE, DEFAULT_IDEA_HOOK_STATE, {
    onError: (err) => {
      void diag.error("[idea-hook] failed to write state file:", err)
    },
  })
  const state = await stateStore.read()

  const sessions = createSessionTools(client, projectDir)
  const rng = Math.random

  let generating = false
  let lastSessionID: string | null = null
  let skippedDayKey = ""

  const readBucket = async (): Promise<string> => {
    try {
      return await readFile(bucketFile, "utf8")
    } catch {
      return ""
    }
  }

  const readSeed = async (): Promise<string> => {
    const parts: string[] = []
    for (const leaf of [profileCfg.agent_file, profileCfg.user_file]) {
      try {
        const t = (await readFile(join(vaultDir, leaf), "utf8")).replace(/^---[\s\S]*?---/, "").trim()
        if (t) parts.push(t.slice(0, 1500))
      } catch {
        // best effort
      }
    }
    if (config.seed_notes > 0) {
      try {
        const parsed = JSON.parse(await readFile(tagIndexFile, "utf8"))
        const notes: string[] = Array.isArray(parsed)
          ? parsed.flatMap((e: any) => (Array.isArray(e?.notes) ? e.notes : []))
          : []
        const unique = [...new Set(notes.filter((n) => typeof n === "string"))]
        const picks = new Set<string>()
        for (let i = 0; i < config.seed_notes && unique.length > 0; i++) {
          picks.add(unique[Math.floor(rng() * unique.length)])
        }
        for (const rel of picks) {
          try {
            const t = (await readFile(join(vaultDir, rel), "utf8")).replace(/^---[\s\S]*?---/, "").trim()
            if (t) parts.push(`# ${rel}\n${t.slice(0, 2000)}`)
          } catch {
            // best effort
          }
        }
      } catch {
        // missing/invalid tag index — skip the seed, never fatal
      }
    }
    return parts.join("\n\n").slice(0, Math.max(2000, Math.floor(config.context_max_bytes / 2)))
  }

  const readRecentTranscript = async (): Promise<string> => {
    if (!lastSessionID || config.context_turns <= 0) return ""
    try {
      const res = await client.session.messages({ path: { id: lastSessionID }, query: { directory } })
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
          if (turns.length >= config.context_turns) break
        }
      }
      if (turns.length === 0 && (user || assistant)) turns.push({ user, assistant })
      return buildTurnTranscript(turns, config.context_max_bytes)
    } catch (err) {
      void diag.error("[idea-hook] failed to read recent turns:", err)
      return ""
    }
  }

  const generateWithChild = async (parentID: string, prompt: string): Promise<string> => {
    try {
      const created = await client.session.create({
        body: { parentID, title: CHILD_TITLE },
        query: { directory: projectDir },
      })
      const childID = created?.data?.id
      if (!childID) return ""
      automationChildSessions.add(childID)

      const model = splitWriterModel(config.generator_model)
      const res = await client.session.promptAsync({
        path: { id: childID },
        body: {
          agent: config.generator_agent,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text: prompt }],
        },
      })
      if (res?.error || !res?.response?.ok) return ""

      const deadline = Date.now() + config.child_timeout_ms
      while (Date.now() < deadline) {
        await sleep(POLL_MS)
        const msgs = await client.session.messages({ path: { id: childID }, query: { directory: projectDir } })
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
      void diag.error("[idea-hook] generator child failed:", err)
      return ""
    }
  }

  const ensureParent = async (): Promise<string | null> => {
    if (lastSessionID) return lastSessionID
    try {
      const created = await client.session.create({
        body: { title: "idea-hook" },
        query: { directory: projectDir },
      })
      const id = created?.data?.id
      if (id) automationChildSessions.add(id)
      return id ?? null
    } catch (err) {
      void diag.error("[idea-hook] failed to create parent session:", err)
      return null
    }
  }

  const runGeneration = async (today: string, existing: ReturnType<typeof parseBucket>): Promise<void> => {
    const pass = `p${++state.passSeq}`
    await stateStore.write(state)

    const category: IdeaCategory =
      IDEA_CATEGORIES[drawWeightedIndex(parseWeights(config.category_weights), rng)] ?? IDEA_CATEGORIES[0]
    const [transcript, seed] = await Promise.all([readRecentTranscript(), readSeed()])
    const prompt = buildGeneratePrompt({
      category,
      criteria: prompts.generate.criteria[category],
      instructions: prompts.generate.instructions,
      transcript,
      seed,
      existingTitles: existing.map((e) => e.title),
      today,
      categoryWeights: config.category_weights,
      transcriptMaxBytes: config.context_max_bytes,
    })

    const parentID = await ensureParent()
    if (!parentID) {
      await logger.append({ ts: nowIso(), event: "idea-skipped", pass, reason: "no-parent" })
      return
    }

    const reply = await generateWithChild(parentID, prompt)
    if (!reply) {
      await logger.append({ ts: nowIso(), event: "idea-skipped", pass, reason: "child-no-reply" })
      await notifier.toast("idea not generated — no child reply", "warning")
      return
    }

    const parsed = extractIdea(reply)
    if (!parsed || Buffer.byteLength(parsed.body, "utf8") > config.note_max_bytes) {
      await logger.append({
        ts: nowIso(),
        event: "idea-skipped",
        pass,
        reason: "invalid-draft",
        replyBytes: Buffer.byteLength(reply, "utf8"),
      })
      return
    }

    if (isDuplicate(parsed.body, existing, config.dedupe_threshold)) {
      await logger.append({
        ts: nowIso(),
        event: "idea-skipped",
        pass,
        reason: "duplicate",
        title: parsed.title,
        category: parsed.category,
      })
      await notifier.toast("idea rejected — too similar to an existing idea", "warning")
      return
    }

    if (config.review) {
      if (!provider) {
        await logger.append({ ts: nowIso(), event: "idea-review-reject", pass, reason: "no-provider" })
        return
      }
      const { result, fallback, fallbackReason } = await decideWithFallback(
        provider,
        buildIdeaReviewRequest(parsed, existing.map((e) => e.title), prompts),
        rules,
      )
      const pTrue = typeof result.probabilities?.true === "number" ? result.probabilities.true : 0
      const accepted = reviewAccepted(result.value, pTrue, fallback, result.abstained, config.review_threshold)
      await logger.append({
        ts: nowIso(),
        event: "idea-review",
        pass,
        title: parsed.title,
        category: parsed.category,
        pTrue,
        reviewThreshold: config.review_threshold,
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
        await notifier.toast("idea rejected — reviewer declined", "warning")
        return
      }
    }

    const hash = ideaHash(parsed.body)
    const entry = {
      title: parsed.title,
      category: parsed.category,
      id: ideaId(parsed.body),
      created: today,
      hash,
      body: parsed.body,
    }
    const current = await readBucket()
    const next = setFrontmatterDate(appendIdeaToBucket(current, entry, today), today)
    try {
      await atomicWrite(bucketFile, next)
    } catch (err) {
      await logger.append({
        ts: nowIso(),
        event: "idea-write-failed",
        pass,
        error: err instanceof Error ? err.message : String(err),
      })
      await notifier.toast("idea write failed", "error")
      return
    }

    state.generatedToday += 1
    state.lastGeneratedAt = Date.now()
    await stateStore.write(state)
    await logger.append({
      ts: nowIso(),
      event: "idea-generated",
      pass,
      title: parsed.title,
      category: parsed.category,
      hash,
      generatedToday: state.generatedToday,
      dailyTarget: state.dailyTarget,
      bytes: Buffer.byteLength(next, "utf8"),
    })
    await notifier.toast(`new idea: ${parsed.title}`, "success")
  }

  const tick = async (): Promise<void> => {
    try {
      if (!config.enabled || generating) return
      const now = new Date()
      const today = localDayKey(now)
      const nowMs = now.getTime()

      // Day rollover: draw today's target and due times.
      if (state.dayKey !== today) {
        state.dayKey = today
        state.dailyTarget = drawDailyCount(config.daily_weights, rng)
        state.dueAt = drawDueTimes(
          now,
          state.dailyTarget,
          config.active_start_hour,
          config.active_end_hour,
          rng,
        )
        state.generatedToday = 0
        await stateStore.write(state)
        await logger.append({
          ts: nowIso(),
          event: "idea-schedule",
          dayKey: today,
          dailyTarget: state.dailyTarget,
          dueAt: state.dueAt,
        })
      }

      if (!isDue(state.dueAt, state.generatedToday, nowMs)) return
      if (!isInActiveWindow(now, config.active_start_hour, config.active_end_hour)) {
        if (skippedDayKey !== today) {
          skippedDayKey = today
          await logger.append({ ts: nowIso(), event: "idea-skipped", reason: "out-of-window", dayKey: today })
        }
        return
      }

      generating = true
      try {
        await runGeneration(today, parseBucket(await readBucket()))
      } finally {
        generating = false
      }
    } catch (err) {
      void diag.error("[idea-hook] tick failed:", err)
    }
  }

  // Deferred startup catch-up, mirroring knowledge-hook §8.2: notice a due time
  // that passed while opencode was closed instead of waiting a full interval.
  setTimeout(() => {
    void tick()
  }, 0)

  const timer = setInterval(() => {
    void tick()
  }, config.interval_ms)
  ;(timer as any).unref?.()

  return {
    "chat.message": async (input) => {
      const sid = input.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      lastSessionID = sid
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid || automationChildSessions.has(sid)) return
      if (await sessions.isChild(sid)) return
      lastSessionID = sid
      // Cheap due-check: the schedule stays authoritative, but an active
      // session gives us a runtime to spawn the child in.
      void tick()
    },
  }
}) satisfies Plugin
