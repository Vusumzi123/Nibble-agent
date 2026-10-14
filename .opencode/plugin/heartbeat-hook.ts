import type { Plugin } from "@opencode-ai/plugin"
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
  HEARTBEAT_WAKE_CAP_MS,
  acquireHeartbeatLock,
  assembleMissionBrief,
  buildDigestChoiceRequest,
  computeDigest,
  computeWakeDelayMs,
  digestVerdictFromResult,
  effectiveFrequencyMs,
  frequencyToMs,
  readHeartbeatConfig,
  releaseHeartbeatLock,
  heartbeatErrorFields,
  type DigestVerdict,
  type HeartbeatPhase,
} from "./lib/heartbeat.ts"
import { drainAccounting } from "./lib/knowledge.ts"
import { createMoodFeed } from "./lib/mood.ts"
import { createDiagnostics, getLogger, logSettingsFrom, LOG_DEFAULTS } from "./lib/logging.ts"
import { loadMissions } from "./lib/missions.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools } from "./lib/sessions.ts"
import { createStateStore } from "./lib/state.ts"
import { nowIso, sleep } from "./lib/util.ts"

// In-process heartbeat scheduler (kanban card D, missions-plan §12 — the
// D-M9 locked vehicle) + outcome recording (kanban card E, plan §7): a
// self-rescheduling `setTimeout` loop inside the opencode server plugin; no
// systemd unit, no `opencode run` child.
//
// One wake cycle (§12.1):
//
//   1. Hot-read `heartbeat.enabled`, `autonomy.level` + `heartbeat.frequency`
//      — config applies without a restart; every wake recomputes from disk.
//   2. Kill switch / L0 / `frequency: off` → sleep on (wake capped at
//      HEARTBEAT_WAKE_CAP_MS so a dial flip re-enables within ≤ 60 s).
//   3. Due check via the shared pure math (`computeWakeDelayMs`) —
//      `now − last_tick ≥ frequency`; missed ticks coalesce, never replay.
//   4. Acquire the in-process single-flight flag + the cross-instance file
//      lock `.opencode/state/heartbeat.lock` (stale-timestamp steal). A fresh
//      lock skips the tick — one mission at a time even when a TUI-embedded
//      server and a separate `opencode serve` both load this plugin.
//   5. Pre-gate (card B, deterministic): all-quiet ∧ level ≤ L2 → ledger
//      NO_REPLY, release, exit. Zero LLM calls — no session is created and no
//      JEV provider runs on this path.
//   6. Execute (cards B+C): JEV digest choice (`no_reply | mission:<id>`,
//      fail-open to no_reply, `reason` explains which) → one child session via
//      `client.session.create` + `session.promptAsync(fixed brief)`
//      (knowledge-hook pattern), resolved on `session.idle`. The mission runs
//      under the same autonomy gate and irreversibility floor as any session.
//
// Outcome recording (§7): every tick appends one NDJSON line to the
// `heartbeat:` ledger (`ts, tick, digest_hash, level, quiet, candidates, bias,
// verdict, mission, outcome, token_cost, mood_event`) through the shared
// rotation engine; a mission run also records itself in `backlog.ndjson`
// (`source: "heartbeat"`, `result.token_cost` filled) and refreshes the derived
// view one-way. The heartbeat feeds `long_silence` (gap ≥ factor × frequency)
// and `mission_failure` (non-completed run) through the shared `createMoodFeed`
// entry point — mood stays advisory, never touches the gate or the floor.
//
// The loop's timers are unref'd: the heartbeat lives and dies with the main
// opencode instance (the accepted D-M9 tradeoff) and must never keep a
// process — or the test runner — alive on its account.
//
// Tick lines land in `<log>/heartbeat.log`; scheduler state in
// `.opencode/state/heartbeat.json`, the lock in `.opencode/state/heartbeat.lock`.

/** A mission child session that never idles is abandoned after this budget
 *  (the lock's stale steal is the crash backstop for the whole tick). */
export const HEARTBEAT_TICK_TIMEOUT_MS = 15 * 60_000

export default (async ({ client, directory, ...rest }) => {
  const dir = directory ?? process.cwd()
  const { logDir, stateDir, vaultDir } = await readResolvedPaths(dir, homedir())

  // Ledger settings are read once at plugin init (restart to re-rotate — the
  // same policy as `knowledge:` / `profile:`); the behavioural dials below are
  // hot-read on every tick.
  const hbInit = await readHeartbeatConfig(dir)
  const logger = getLogger(logSettingsFrom(hbInit as unknown as Record<string, unknown>, "log", "log_"), {
    logDir,
    home: homedir(),
    channel: "heartbeat-hook",
  })
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "heartbeat-hook" })

  const lockFile = join(stateDir, "heartbeat.lock")
  // `noop_hash`/`noop_streak` drive B7 day-side backoff (missions-plan §7):
  // consecutive no_reply ticks on an identical digest stretch the cadence ×2/×4.
  const stateStore = createStateStore<{
    last_tick: number
    ticks: number
    noop_hash: string | null
    noop_streak: number
  }>(join(stateDir, "heartbeat.json"), { last_tick: 0, ticks: 0, noop_hash: null, noop_streak: 0 })

  // B7 bookkeeping: a no_reply tick on the SAME digest extends the streak, a
  // changed digest restarts it at 1; an executed mission clears it (§17.8
  // reset rule, day twin).
  const recordNoop = async (digestHash: string): Promise<void> => {
    await stateStore.update((s) => ({
      ...s,
      noop_hash: digestHash,
      noop_streak: s.noop_hash === digestHash ? s.noop_streak + 1 : 1,
    }))
  }
  const recordExecution = async (): Promise<void> => {
    await stateStore.update((s) => ({ ...s, noop_hash: null, noop_streak: 0 }))
  }

  // Shared mood feed (card E): same mood.ndjson journal and queue discipline
  // mood-hook uses — one in-process serialized mutation path per plugin.
  const moodCfg = await readMoodConfig(dir)
  const moodFeed = await createMoodFeed({
    file: join(stateDir, "mood.json"),
    halfLife: moodCfg.decay_half_life,
    logger: getLogger({ file: "mood.ndjson", ...LOG_DEFAULTS }, {
      logDir,
      home: homedir(),
      channel: "heartbeat-hook",
    }),
    onError: (err) => void diag.error("[heartbeat-hook] mood feed failed:", err),
  })

  const sessions = createSessionTools(client, dir)

  // Test-injection seam (decisions.test.ts convention): production input never
  // carries `spawner`; the hook tests hand one in to fake the JEV bridge.
  const spawner = (rest as { spawner?: BridgeSpawner }).spawner
  // Test-injection seam: shrink the 60 s wake cap so a test can observe
  // several due cycles (B7 backoff) without waiting out real minutes.
  // Production input never carries it.
  const wakeCapMs = (rest as { wakeCapMs?: number }).wakeCapMs ?? HEARTBEAT_WAKE_CAP_MS

  // In-process single-flight (the file lock covers cross-instance overlap).
  let ticking = false

  // Child-idle waiters, resolved from the event hook below (never a poll
  // loop). Registered BEFORE the prompt so the child's first idle is caught.
  const childIdleResolvers = new Map<string, () => void>()

  const waitForChildIdle = (childID: string): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        childIdleResolvers.delete(childID)
        resolve(false) // timed out — mission abandoned for this tick
      }, HEARTBEAT_TICK_TIMEOUT_MS)
      timer.unref?.()
      childIdleResolvers.set(childID, () => {
        clearTimeout(timer)
        childIdleResolvers.delete(childID)
        resolve(true)
      })
    })

  const logTick = async (entry: Record<string, unknown>): Promise<void> => {
    try {
      await logger.append({ ts: nowIso(), event: "tick", ...entry })
    } catch (err) {
      void diag.error("[heartbeat-hook] tick log failed:", err)
    }
  }

  type TickStatus = "fired" | "lock-held" | "sleeping"

  const runTick = async (): Promise<TickStatus> => {
    if (ticking) return "lock-held" // in-process single-flight
    ticking = true
    let lockHeld = false
    // Troubleshooting trail: which stage the tick is in, and the ledger
    // closure once it exists — so ANY failure below leaves one
    // `outcome: "error"` ledger line with a phase-tagged error, never silent.
    let phase: HeartbeatPhase = "pre-gate"
    let ledgerForTick: ((extra: Record<string, unknown>) => Promise<void>) | null = null
    try {
      // 1-2. Hot-read the kill switch and the dial. A malformed frequency
      // parses to null and sleeps — a garbage dial must never fire the
      // heartbeat.
      const hbCfg = await readHeartbeatConfig(dir)
      if (!hbCfg.enabled) return "sleeping"

      const autonomy = await readAutonomyConfig(dir)

      // 3. Due check through the shared pure math (a never-ticked state is
      // overdue: fires once soon after boot, coalescing anything missed).
      // B7: the effective day cadence carries the identical-digest NO_REPLY
      // backoff (missions-plan §7) — the SAME value feeds the wake loop.
      const state = await stateStore.read()
      const frequencyMs = effectiveFrequencyMs(
        frequencyToMs(autonomy.heartbeat.frequency),
        state.noop_streak,
      )
      const nowMs = Date.now()
      const wake = computeWakeDelayMs({
        level: autonomy.level,
        frequencyMs,
        lastTickMs: state.last_tick > 0 ? state.last_tick : null,
        nowMs,
      })
      if (wake > 0) return "sleeping"

      // 4. Cross-instance lock; a fresh lock means another instance is inside
      // a tick (overrun semantics) — skip, retry next wake.
      const lock = await acquireHeartbeatLock(lockFile, nowMs)
      if (!lock) return "lock-held"
      lockHeld = true
      const prevState = state
      const nextState = await stateStore.update((s) => ({
        ...s,
        last_tick: nowMs,
        ticks: s.ticks + 1,
      }))
      const tick = nextState.ticks

      const digest = await computeDigest(dir, { now: new Date(nowMs) })
      const candidates = digest.candidates.map((c) => `${c.id}:${c.weight.toFixed(2)}`)
      const bias = digest.bias

      // Mood feed (§7): a gap of ≥ factor × frequency since the previous tick
      // means the harness was silent too long — fed once per gap, because
      // last_tick has already advanced past it. Independent of the verdict.
      let moodEvent: string | null = null
      if (
        hbCfg.long_silence_factor > 0 &&
        frequencyMs !== null &&
        prevState.last_tick > 0 &&
        nowMs - prevState.last_tick >= hbCfg.long_silence_factor * frequencyMs
      ) {
        await moodFeed.apply("long_silence")
        moodEvent = "long_silence"
      }

      // One ledger line per tick (§7). `reason` disambiguates no_reply:
      // all-quiet pre-gate, decisions-disabled, provider error/abstain/shape,
      // or an explicit JEV no_reply choice.
      const ledger = (extra: Record<string, unknown>): Promise<void> =>
        logTick({
          tick,
          digest_hash: digest.digest_hash,
          level: digest.level,
          quiet: digest.quiet,
          candidates,
          bias,
          ...extra,
          mood_event: moodEvent,
        })
      ledgerForTick = ledger

      // 5. Sleep-system pre-gate (§17.2): inside the quiet window the dream
      // timer owns sleeping time — status dreaming ends the heartbeat tick as
      // NO_REPLY with zero LLM calls. The pre-gates are the window
      // transitions' READ side; dream-hook is the sole writer (§17.1).
      if (digest.quiet && digest.sleep_status === "dreaming") {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: "silent",
          token_cost: 0,
          gate: "sleep",
          reason: "dreaming",
        })
        await recordNoop(digest.digest_hash)
        return "fired"
      }

      // 6. Deterministic pre-gate — zero LLM calls by construction: no JEV
      // provider, no session. Card B's digest reads every signal from disk.
      if (digest.all_quiet && digest.level <= 2) {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: "silent",
          token_cost: 0,
          gate: "pre-gate",
          reason: "all-quiet",
        })
        await recordNoop(digest.digest_hash)
        return "fired"
      }

      // 7a. JEV digest decision. Fail-open to no_reply: decisions disabled,
      // error, abstain, or unknown id all mean silence — never invent work.
      phase = "digest"
      let verdict: DigestVerdict = { kind: "no_reply" }
      let reason = "decisions-disabled"
      let digestError: ReturnType<typeof heartbeatErrorFields> | undefined
      try {
        const gate = await openDecisionGate(dir, spawner ? { spawner } : {})
        if (gate) {
          const prompts = await readDecisionPrompts(dir)
          const outcome = await gate.decide(
            buildDigestChoiceRequest(digest, prompts.digest.assertion),
            { fallback: "open" },
          )
          verdict = digestVerdictFromResult(
            outcome.result,
            digest.candidates.map((c) => c.id),
          )
          reason =
            outcome.reason !== "none"
              ? outcome.reason // "error" | "abstain" | "shape"
              : verdict.kind === "no_reply"
                ? "jev-no-reply"
                : "none"
        }
      } catch (err) {
        void diag.error("[heartbeat-hook] digest decision failed:", err)
        reason = "error"
        digestError = heartbeatErrorFields("digest", err)
      }

      const missionId = verdict.kind === "mission" ? verdict.id : null
      const missions = missionId ? await loadMissions(dir).catch(() => []) : []
      const mission = missions.find((m) => m.id === missionId)
      const brief = assembleMissionBrief(verdict, mission)
      if (!brief) {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: "silent",
          token_cost: 0,
          gate: "digest",
          reason,
          ...(digestError ? { error: digestError } : {}),
        })
        await recordNoop(digest.digest_hash)
        return "fired"
      }

      // 7b. Execute exactly one mission in a child session (D-M7: the
      // mission's `agent:` pins the child when set). The child is registered
      // in automationChildSessions so the other hooks never re-process it.
      phase = "dispatch"
      let outcome = "error"
      let tokenCost = 0
      let summary = ""
      let runError: ReturnType<typeof heartbeatErrorFields> | undefined
      try {
        const created = await (client as any).session.create({
          body: { title: `heartbeat:${brief.mission_id}` },
          query: { directory: dir },
        })
        const childID: string = created?.data?.id
        if (!childID) throw new Error("session.create returned no id")
        automationChildSessions.add(childID)
        phase = "mission"
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
          // No exception was thrown here — synthesize the error record from
          // the provider response so the ledger line is still diagnosable.
          runError = heartbeatErrorFields(
            "dispatch",
            new Error(
              (res?.error as { message?: string } | undefined)?.message ??
                `promptAsync failed (status ${res?.response?.status ?? "unknown"})`,
            ),
          )
        } else {
          outcome = (await idled) ? "completed" : "timeout"
        }

        // Account for the child: billable tokens + the final assistant line
        // (the mission's outcome summary). A finished child's message store
        // may need a short propagation window — bounded retries, never a poll
        // loop: a missing report degrades to empty, never blocks the tick.
        const attempts = outcome === "completed" ? 5 : 1
        for (let i = 0; i < attempts; i++) {
          const msgs = await (client as any).session
            .messages({ path: { id: childID }, query: { directory: dir } })
            .catch(() => null)
          if (Array.isArray(msgs?.data)) {
            const acct = drainAccounting(msgs.data)
            tokenCost = acct.inputTokens + acct.outputTokens
            summary = await sessions.lastAssistantText(childID)
          }
          if (summary || tokenCost > 0 || i === attempts - 1) break
          await sleep(250)
        }
      } catch (err) {
        void diag.error("[heartbeat-hook] mission run failed:", err)
        outcome = "error"
        runError = heartbeatErrorFields(phase === "mission" ? "mission" : "dispatch", err)
      }

      phase = "post"
      if (outcome !== "completed") {
        await moodFeed.apply("mission_failure")
        moodEvent = "mission_failure"
      }

      // Mission record in the action queue (§7, §10): `source: "heartbeat"`
      // with the reserved result.token_cost filled, then the one-way view
      // refresh. Best-effort — a ledger failure never fails the tick.
      try {
        const backlogCfg = await readBacklogConfig(dir)
        if (backlogCfg.enabled && mission) {
          const backlogFile = resolveBacklogFile(stateDir, backlogCfg)
          const { entry } = await append(backlogFile, {
            source: "heartbeat",
            kind: "task",
            payload: {
              title: mission.title,
              detail: summary || `heartbeat tick ${tick}: ${outcome}`,
            },
          })
          await setStatus(backlogFile, entry.id, outcome === "completed" ? "done" : "failed", {
            result: {
              ok: outcome === "completed",
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
        void diag.error("[heartbeat-hook] backlog record failed:", err)
      }

      await ledger({
        verdict: `mission:${brief.mission_id}`,
        mission: brief.mission_id,
        outcome,
        token_cost: tokenCost,
        gate: "digest",
        reason,
        ...(runError ? { error: runError } : {}),
      })
      // An executed mission resets the B7 backoff streak (§17.8 reset rule).
      await recordExecution()
      return "fired"
    } catch (err) {
      void diag.error("[heartbeat-hook] tick failed:", err)
      // Never a silent tick: record the failure in the ledger itself with
      // the stage it died in (best-effort — a ledger fault was already
      // reported by logTick's own diag above).
      const error = heartbeatErrorFields(phase, err)
      const line = {
        outcome: "error",
        token_cost: 0,
        gate: "tick",
        reason: "tick-error",
        error,
      }
      if (ledgerForTick) await ledgerForTick({ verdict: null, mission: null, ...line })
      else await logTick({ tick: null, ...line })
      return "fired"
    } finally {
      ticking = false
      if (lockHeld) await releaseHeartbeatLock(lockFile).catch(() => {})
    }
  }

  // The self-rescheduling loop: the delay is recomputed from disk after every
  // wake so the dial is hot; capped at HEARTBEAT_WAKE_CAP_MS everywhere (the
  // 60 s ceiling is what makes kill switch / L0 / off and shorter frequencies
  // apply without a restart). A lock-held skip backs off a full cap so two
  // instances cannot spin on the lock.
  const wakeInput = async () => {
    const autonomy = await readAutonomyConfig(dir)
    const state = await stateStore.read()
    return {
      level: autonomy.level,
      frequencyMs: effectiveFrequencyMs(
        frequencyToMs(autonomy.heartbeat.frequency),
        state.noop_streak,
      ),
      lastTickMs: state.last_tick > 0 ? state.last_tick : null,
      nowMs: Date.now(),
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
      void diag.error("[heartbeat-hook] loop error:", err)
    }
    if (status === "lock-held") {
      scheduleWake(wakeCapMs)
      return
    }
    scheduleWake(Math.min(computeWakeDelayMs(await wakeInput()), wakeCapMs))
  }

  // First wake deferred so plugin init returns first (knowledge-hook
  // startup-catch-up pattern); the due check inside means an overdue interval
  // fires once soon after boot — coalesce, never replay (§12.1).
  setTimeout(() => {
    void loop()
  }, 0).unref?.()

  // --- Hook surface ---------------------------------------------------------
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid) return
      childIdleResolvers.get(sid)?.()
    },
  }
}) satisfies Plugin
