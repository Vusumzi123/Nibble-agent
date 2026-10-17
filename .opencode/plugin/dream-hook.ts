import type { Plugin } from "@opencode-ai/plugin"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { automationChildSessions } from "./lib/automation.ts"
import { readAutonomyConfig, readMoodConfig } from "./lib/autonomy.ts"
import {
  append,
  readBacklogConfig,
  refreshView,
  resolveBacklogFile,
  resolveViewFile,
  setStatus,
} from "./lib/backlog.ts"
import { openDecisionGate } from "./lib/decision-gate.ts"
import { readDecisionPrompts } from "./lib/decision-prompts.ts"
import type { BridgeSpawner } from "./lib/decisions.ts"
import {
  DREAM_BUCKET,
  appendDream,
  buildDreamPrompt,
  dreamHash,
  formatDreamEntry,
  newDreamId,
  parseDreamOutcome,
  DREAM_TONE_EVENT,
  type DreamSeeds,
} from "./lib/dream.ts"
import {
  HEARTBEAT_FIXED_PROMPT,
  acquireHeartbeatLock,
  assembleMissionBrief,
  buildDigestChoiceRequest,
  computeDigest,
  digestVerdictFromResult,
  isQuietNow,
  readHeartbeatConfig,
  releaseHeartbeatLock,
  type DigestVerdict,
} from "./lib/heartbeat.ts"
import { sessionAccounting } from "./lib/transcript.ts"
import { createMoodFeed } from "./lib/mood.ts"
import { createDiagnostics, getLogger, logSettingsFrom, LOG_DEFAULTS } from "./lib/logging.ts"
import { readDrainConfig } from "./lib/drain/config.ts"
import { createDrainLedger } from "./lib/drain/ledger.ts"
import { runMissionRunner } from "./lib/drain/runner.ts"
import { formatDrainResult, type DrainPipeClient } from "./lib/drain/pipe.ts"
import { loadMissions } from "./lib/missions.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools } from "./lib/sessions.ts"
import {
  DREAM_WAKE_CAP_MS,
  computeDreamWakeDelayMs,
  createSleepStore,
  durationToMs,
  reconcileSleep,
} from "./lib/sleep.ts"
import { readMemory, resolveMemoryFile } from "./lib/turn-buffer.ts"
import { nowIso, sleep as delay } from "./lib/util.ts"

// In-process dream timer (kanban card G, plan §17.2/§17.3 — the D-M9/§13
// in-process pattern, systemd retired 2026-10-13): a self-rescheduling
// `setTimeout` loop inside the opencode server plugin. It shares
// `.opencode/state/heartbeat.lock` with the heartbeat (D5) so the two
// schedulers never run autonomous work at the same time, and it journals its
// ticks to the shared `<log>/heartbeat.log` ledger with `source: "dream"`
// (§17.8: dream token costs live in the heartbeat ledger, B6 style).
//
// One wake cycle (§17.3 cheapest-first):
//
//   0. Reconcile the sleep state — the sole writer of window and cooldown
//      transitions (§17.1): awake ↔ dreaming on window edges (+ `fell_asleep`
//      / `well_rested`), woken → dreaming after `resume_cooldown` silence.
//      Runs every wake, so edges land within the 60 s wake cap.
//   1. L0 / outside the window / not dreaming → sleep on the cap (zero cost —
//      "dream tick outside the window, or not dreaming: NO_REPLY").
//   2. Due check through the pure wake math — dream_cadence × backoff
//      (§17.8: 30m → 60m → 120m after 2 no-ops, `quiet.backoff` gated).
//   3. Acquire the SHARED heartbeat lock; a fresh foreign lock skips the tick.
//   4. DETERMINISTIC PRE-GATE (zero LLM): the digest's night candidates are
//      already gated — drain only with pending turns (`turns-pending`), dream
//      only on status ∧ nightly cap ∧ roll (`dream-gate`, the roll journaled
//      via `onDreamGate`). NO candidates ⇒ NO_REPLY with NO JEV call.
//   5. ONE survivor ⇒ dispatched directly (the §17.10 sole-candidate
//      short-circuit — deterministic "roll failed + turns pending ⇒ drain
//      still runs"); TWO+ survivors ⇒ JEV digest choice, fail-open no_reply.
//   6. Execute one mission in a child session (delegation-child pattern,
//      15 min abandon). A dream outcome is parsed by the hook — append the
//      bucket entry, apply the §17.7 tone→delta (never the LLM's numbers),
//      count dreams_tonight; other missions record like a heartbeat run.
//
// The loop's timers are unref'd: the dream timer lives and dies with the main
// opencode instance (D-M9 tradeoff) and never keeps the test runner alive.
/** A dream child session that never idles is abandoned after this budget. */
const DREAM_TICK_TIMEOUT_MS = 15 * 60_000

export default (async ({ client, directory, ...rest }) => {
  const dir = directory ?? process.cwd()
  const { logDir, stateDir, vaultDir } = await readResolvedPaths(dir, homedir())

  // Dream ticks share the heartbeat ledger (§17.8) — same `heartbeat:` log
  // settings, own channel, `event: "dream-tick"` discriminator.
  const hbInit = await readHeartbeatConfig(dir)
  const logger = getLogger(logSettingsFrom(hbInit as unknown as Record<string, unknown>, "log", "log_"), {
    logDir,
    home: homedir(),
    channel: "dream-hook",
  })
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "dream-hook" })

  const lockFile = join(stateDir, "heartbeat.lock") // SHARED with heartbeat (§17.2)
  const sleepStore = createSleepStore(stateDir, {
    onError: (err) => void diag.error("[dream-hook] sleep state write failed:", err),
  })

  const moodCfg = await readMoodConfig(dir)
  const moodFeed = await createMoodFeed({
    file: join(stateDir, "mood.json"),
    halfLife: moodCfg.decay_half_life,
    logger: getLogger({ file: "mood.ndjson", ...LOG_DEFAULTS }, {
      logDir,
      home: homedir(),
      channel: "dream-hook",
    }),
    onError: (err) => void diag.error("[dream-hook] mood feed failed:", err),
  })

  const sessions = createSessionTools(client, dir)

  // Test-injection seams (heartbeat-hook convention): production input never
  // carries these; the hook tests hand them in to fake the JEV bridge and the
  // dream roll.
  const spawner = (rest as { spawner?: BridgeSpawner }).spawner
  const random = (rest as { random?: () => number }).random
  const drainDbFile = (rest as { drainDbFile?: string }).drainDbFile

  let ticking = false

  const childIdleResolvers = new Map<string, () => void>()
  const waitForChildIdle = (childID: string): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        childIdleResolvers.delete(childID)
        resolve(false)
      }, DREAM_TICK_TIMEOUT_MS)
      timer.unref?.()
      childIdleResolvers.set(childID, () => {
        clearTimeout(timer)
        childIdleResolvers.delete(childID)
        resolve(true)
      })
    })

  const logTick = async (entry: Record<string, unknown>): Promise<void> => {
    try {
      await logger.append({ ts: nowIso(), event: "dream-tick", source: "dream", ...entry })
    } catch (err) {
      void diag.error("[dream-hook] tick log failed:", err)
    }
  }

  // §17.5 hybrid seeds, gathered hook-side (zero LLM): A = most recent
  // temporal turn (mood/recent-turn-seeded proxy), B = one random vault note
  // (the associative junk-dream character). The dreamer is tool-free, so the
  // fragments ride in the prompt.
  const pickDreamSeeds = async (): Promise<DreamSeeds> => {
    let recent: string | null = null
    try {
      const turns = await readMemory(resolveMemoryFile(stateDir))
      const last = turns.length > 0 ? turns.reduce((a, b) => (b.seq > a.seq ? b : a)) : null
      if (last?.user) recent = `recent turn: ${String(last.user).replace(/\s+/g, " ").trim().slice(0, 300)}`
    } catch {
      /* no memory — seed A falls back to the mood line */
    }
    if (!recent) recent = `mood: ${moodFeed.view().label}`

    let randomNote: string | null = null
    try {
      const notes = (await readdir(vaultDir))
        .filter((f) => f.endsWith(".md") && f !== DREAM_BUCKET && f !== "Backlog.md")
      if (notes.length > 0) {
        const pick = notes[Math.floor((random ?? Math.random)() * notes.length)]
        const text = await readFile(join(vaultDir, pick), "utf8").catch(() => "")
        const excerpt = text.replace(/---[\s\S]*?---/, "").replace(/\s+/g, " ").trim().slice(0, 300)
        randomNote = `random note "${pick}": ${excerpt}`
      }
    } catch {
      /* no vault yet — seed B omitted */
    }
    return { recent, random: randomNote }
  }

  type TickStatus = "fired" | "lock-held" | "sleeping"

  const runTick = async (): Promise<TickStatus> => {
    if (ticking) return "lock-held"
    ticking = true
    let lockHeld = false
    try {
      const hbCfg = await readHeartbeatConfig(dir)
      if (!hbCfg.enabled) return "sleeping" // shared kill switch (one lock, one engine)

      const autonomy = await readAutonomyConfig(dir)
      const q = autonomy.quiet
      const cadenceMs = durationToMs(q.dream_cadence, 30 * 60_000)
      const cooldownMs = durationToMs(q.resume_cooldown, 60 * 60_000)
      const quiet = isQuietNow(q.window)

      // 0. Window + cooldown transitions — this hook's writer class (§17.1).
      if (autonomy.level > 0) {
        const before = await sleepStore.read()
        const rec = reconcileSleep(before, { nowMs: Date.now(), quiet, resumeCooldownMs: cooldownMs })
        if (rec.changed) {
          await sleepStore.write(rec.state)
          for (const event of rec.mood_events) await moodFeed.apply(event)
        }
      }
      if (autonomy.level <= 0) return "sleeping" // L0 sleeps the timer (§4.1)

      // 1. Outside the window / not dreaming → NO_REPLY, zero cost (§17.2).
      const state = await sleepStore.read()
      if (!quiet || state.status !== "dreaming") return "sleeping"

      // 2. Due check (backoff applied — §17.8).
      const nowMs = Date.now()
      const wake = computeDreamWakeDelayMs({
        level: autonomy.level,
        quiet,
        status: state.status,
        cadenceMs,
        lastTickMs: state.last_tick,
        nowMs,
        noopStreak: state.noop_streak,
        backoff: q.backoff,
      })
      if (wake > 0) return "sleeping"

      // 3. Shared lock with the heartbeat (D5): overrun → skip, never queue.
      const lock = await acquireHeartbeatLock(lockFile, nowMs)
      if (!lock) return "lock-held"
      lockHeld = true
      const nextState = await sleepStore.update((s) => ({
        ...s,
        last_tick: nowMs,
        ticks: s.ticks + 1,
      }))
      const tick = nextState.ticks

      // The roll journal (§17.3: journaled with its outcome).
      const dreamGates: Array<{ id: string; chance: number; passed: boolean; reason: string }> = []
      const digest = await computeDigest(dir, {
        now: new Date(nowMs),
        random,
        dbFile: drainDbFile,
        onDreamGate: (info) => dreamGates.push(info),
      })
      const candidates = digest.candidates.map((c) => `${c.id}:${c.weight.toFixed(2)}`)
      const bias = digest.bias
      let moodEvent: string | null = null

      const ledger = (extra: Record<string, unknown>): Promise<void> =>
        logTick({
          tick,
          digest_hash: digest.digest_hash,
          level: digest.level,
          quiet: digest.quiet,
          sleep_status: digest.sleep_status,
          candidates,
          bias,
          dream_gate: dreamGates,
          ...extra,
          mood_event: moodEvent,
        })

      // Records §17.8: a completed mission resets the streak, anything short
      // of a landed effect steps toward the backoff (roll failed / no_reply /
      // error / malformed outcome).
      const afterTick = async (completed: boolean): Promise<void> => {
        await sleepStore.update((s) => ({
          ...s,
          noop_streak: completed ? 0 : s.noop_streak + 1,
        }))
      }

      // 4. DETERMINISTIC PRE-GATE — zero candidates ⇒ NO_REPLY, no JEV call,
      //    no dream (§17.3 step 1 → step 2 skipped by construction).
      if (digest.candidates.length === 0) {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: "silent",
          token_cost: 0,
          gate: "dream-pre-gate",
          reason: "no-candidates",
        })
        await afterTick(false)
        return "fired"
      }

      // 5. One survivor → dispatch directly (§17.10 sole-candidate precedent:
      //    deterministic "failed roll + pending turns ⇒ drain still runs").
      //    Two or more → JEV digest choice, fail-open to no_reply.
      let verdict: DigestVerdict = { kind: "no_reply" }
      let reason: string
      if (digest.candidates.length === 1) {
        verdict = { kind: "mission", id: digest.candidates[0].id }
        reason = "sole-candidate"
      } else {
        reason = "decisions-disabled"
        try {
          const gate = await openDecisionGate(dir, spawner ? { spawner } : {})
          if (gate) {
            const prompts = await readDecisionPrompts(dir)
            const outcome = await gate.decide(
              buildDigestChoiceRequest(digest, prompts.digest.assertion),
              { fallback: "open" },
            )
            verdict = digestVerdictFromResult(outcome.result, digest.candidates.map((c) => c.id))
            reason =
              outcome.reason !== "none"
                ? outcome.reason
                : verdict.kind === "no_reply"
                  ? "jev-no-reply"
                  : "none"
          }
        } catch (err) {
          void diag.error("[dream-hook] digest decision failed:", err)
          reason = "error"
        }
      }

      const missionId = verdict.kind === "mission" ? verdict.id : null
      const missions = missionId ? await loadMissions(dir).catch(() => []) : []
      const mission = missions.find((m) => m.id === missionId)
      const isDream = mission?.candidacy === "dream-gate"

      // Dream briefs carry the fixed dream prompt + the hook-gathered seeds
      // (§17.5); everything else gets the heartbeat's fixed maintenance prompt.
      const fixedPrompt = isDream ? buildDreamPrompt(await pickDreamSeeds()) : HEARTBEAT_FIXED_PROMPT
      const brief = assembleMissionBrief(verdict, mission, fixedPrompt)
      if (!brief) {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: "silent",
          token_cost: 0,
          gate: "digest",
          reason,
        })
        await afterTick(false)
        return "fired"
      }

      // Nightly cap counts dispatched dreams (§17.3): tokens spent per attempt.
      if (isDream) {
        await sleepStore.update((s) => ({ ...s, dreams_tonight: s.dreams_tonight + 1 }))
      }

      // 6. Execute exactly one mission. In-process runners (drain-pipe) own
      //    their own children; everything else uses the D-M7 child session
      //    (`agent:` pins it — `dreamer` for dreams).
      let outcome = "error"
      let tokenCost = 0
      let summary = ""
      let handledByRunner = false
      try {
        if (mission?.runner) {
          const drainCfg = await readDrainConfig(dir)
          const runnerResult = await runMissionRunner(mission.runner, {
            directory: dir,
            stateDir,
            vaultDir,
            config: drainCfg,
            client: client as unknown as DrainPipeClient,
            waitForIdle: waitForChildIdle,
            registerChild: (sid) => automationChildSessions.add(sid),
            dbFile: drainDbFile,
            ledger: createDrainLedger({ logDir, home: homedir() }),
            onWarn: (msg, err) => {
              void diag.warn(`[dream-hook] ${msg}`, err)
            },
          })
          if (runnerResult) {
            handledByRunner = true
            outcome = runnerResult.outcome
            summary = formatDrainResult(runnerResult)
          } else {
            void diag.warn(
              `[dream-hook] unknown mission runner "${mission.runner}" — falling through to dispatch`,
            )
          }
        }

        if (!handledByRunner) {
          const created = await (client as any).session.create({
            body: { title: `dream:${brief.mission_id}` },
            query: { directory: dir },
          })
          const childID: string = created?.data?.id
          if (!childID) throw new Error("session.create returned no id")
          automationChildSessions.add(childID)
          const idled = waitForChildIdle(childID)
          const res = await (client as any).session.promptAsync({
            path: { id: childID },
            body: {
              ...(brief.agent ? { agent: brief.agent } : {}),
              parts: [{ type: "text", text: brief.prompt }],
            },
            query: { directory: dir },
          })
          if (res?.error || (res?.response && !res.response.ok)) {
            outcome = "error"
          } else {
            outcome = (await idled) ? "completed" : "timeout"
          }
          const attempts = outcome === "completed" ? 5 : 1
          for (let i = 0; i < attempts; i++) {
            const msgs = await (client as any).session
              .messages({ path: { id: childID }, query: { directory: dir } })
              .catch(() => null)
            if (Array.isArray(msgs?.data)) {
              const acct = sessionAccounting(msgs.data)
              tokenCost = acct.inputTokens + acct.outputTokens
              summary = await sessions.lastAssistantText(childID)
            }
            if (summary || tokenCost > 0 || i === attempts - 1) break
            await delay(250)
          }
        }
      } catch (err) {
        void diag.error("[dream-hook] mission run failed:", err)
        outcome = "error"
      }

      if (isDream && !handledByRunner) {
        // §17.5 discipline: the hook parses the typed outcome — the LLM's
        // proposed mood numbers never reach the mood system.
        const parsed = outcome === "completed" ? parseDreamOutcome(summary) : null
        if (!parsed) {
          if (outcome === "completed") outcome = "malformed"
          await moodFeed.apply("mission_failure") // "log + tiny valence wobble" (§17.5)
          moodEvent = "mission_failure"
        } else {
          try {
            // §17.5 order adapted so §17.6 metadata carries the REAL
            // before/after: snapshot → apply the §17.7 tone delta (the table
            // is the only mood source) → append the bucket entry → journal.
            const moodBefore = moodFeed.view()
            await moodFeed.apply(DREAM_TONE_EVENT[parsed.tone])
            moodEvent = DREAM_TONE_EVENT[parsed.tone]
            const moodAfter = moodFeed.view()
            await appendDream(
              vaultDir,
              formatDreamEntry(parsed, {
                id: newDreamId(nowMs),
                created: nowIso(),
                tone: parsed.tone,
                mood_before: { valence: moodBefore.valence, arousal: moodBefore.arousal },
                mood_after: { valence: moodAfter.valence, arousal: moodAfter.arousal },
                seeds: parsed.seeds,
                hash: dreamHash(parsed.narrative),
              }),
            )
            outcome = "completed"
          } catch (err) {
            void diag.error("[dream-hook] dream bucket append failed:", err)
            outcome = "error"
            moodEvent = "mission_failure"
          }
        }
      } else {
        // Non-dream night missions record exactly like a heartbeat run (§7).
        // Runner outcomes: "nothing" and "degraded" are successful ticks.
        const missionOk = handledByRunner
          ? outcome === "completed" || outcome === "nothing" || outcome === "degraded"
          : outcome === "completed"
        if (!missionOk) {
          await moodFeed.apply("mission_failure")
          moodEvent = "mission_failure"
        }
        try {
          const backlogCfg = await readBacklogConfig(dir)
          if (backlogCfg.enabled && mission) {
            const backlogFile = resolveBacklogFile(stateDir, backlogCfg)
            const { entry } = await append(backlogFile, {
              source: "heartbeat",
              kind: "task",
              payload: {
                title: mission.title,
                detail: summary || `dream tick ${tick}: ${outcome}`,
              },
            })
            await setStatus(backlogFile, entry.id, missionOk ? "done" : "failed", {
              result: {
                ok: missionOk,
                summary,
                ts: nowIso(),
                token_cost: tokenCost,
              },
            })
            await refreshView(backlogFile, resolveViewFile(vaultDir, backlogCfg), {
              maxView: backlogCfg.max_view,
            })
          }
        } catch (err) {
          void diag.error("[dream-hook] backlog record failed:", err)
        }
      }

      // dream_token_budget is config-validated and journaled as an overrun
      // flag (no mid-flight cap exists on the child-session path — noted as
      // an open gap; mission_token_budget is enforced nowhere either).
      const tickOk = handledByRunner
        ? outcome === "completed" || outcome === "nothing" || outcome === "degraded"
        : outcome === "completed"
      const overBudget = isDream && !handledByRunner && tokenCost > q.dream_token_budget
      await ledger({
        verdict: `mission:${brief.mission_id}`,
        mission: brief.mission_id,
        outcome,
        token_cost: tokenCost,
        over_budget: overBudget,
        gate: "digest",
        reason,
      })
      await afterTick(tickOk)
      return "fired"
    } catch (err) {
      void diag.error("[dream-hook] tick failed:", err)
      return "fired"
    } finally {
      ticking = false
      if (lockHeld) await releaseHeartbeatLock(lockFile).catch(() => {})
    }
  }

  // The self-rescheduling loop: the delay is recomputed from disk after every
  // wake so quiet/dials apply hot; capped at DREAM_WAKE_CAP_MS everywhere —
  // the cap is what catches a window start, a cooldown end, or a dial flip
  // within a minute (mirrors the heartbeat's 60 s ceiling). A lock-held skip
  // backs off a full cap so two instances cannot spin on the lock.
  const wakeInput = async () => {
    const autonomy = await readAutonomyConfig(dir)
    const state = await sleepStore.read()
    return {
      level: autonomy.level,
      quiet: isQuietNow(autonomy.quiet.window),
      status: state.status,
      cadenceMs: durationToMs(autonomy.quiet.dream_cadence, 30 * 60_000),
      lastTickMs: state.last_tick,
      nowMs: Date.now(),
      noopStreak: state.noop_streak,
      backoff: autonomy.quiet.backoff,
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleWake = (ms: number): void => {
    timer = setTimeout(() => {
      void loop()
    }, Math.max(0, ms))
    timer.unref?.()
  }

  const loop = async (): Promise<void> => {
    let status: TickStatus = "sleeping"
    try {
      status = await runTick()
    } catch (err) {
      void diag.error("[dream-hook] loop error:", err)
    }
    if (status === "lock-held") {
      scheduleWake(DREAM_WAKE_CAP_MS)
      return
    }
    scheduleWake(computeDreamWakeDelayMs(await wakeInput()))
  }

  // First wake deferred so plugin init returns first (startup-catch-up
  // pattern); the immediate reconcile inside means window edges land right away.
  setTimeout(() => {
    void loop()
  }, 0).unref?.()

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid) return
      childIdleResolvers.get(sid)?.()
    },
  }
}) satisfies Plugin
