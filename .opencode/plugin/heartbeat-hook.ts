import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
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
  HEARTBEAT_CURRENT_FILE,
  HEARTBEAT_STATE_FILE,
  HEARTBEAT_WAKE_CAP_MS,
  acquireHeartbeatLock,
  assembleMissionBrief,
  buildDigestChoiceRequest,
  computeDigest,
  computeWakeDelayMs,
  digestVerdictFromResult,
  effectiveFrequencyMs,
  frequencyToMs,
  idleHeartbeatCurrent,
  readHeartbeatConfig,
  releaseHeartbeatLock,
  heartbeatErrorFields,
  missionContextHeader,
  writeHeartbeatCurrent,
  soleDeterministicVerdict,
  staleCodeFiles,
  type DigestVerdict,
  type HeartbeatDigest,
  type HeartbeatCurrent,
  type HeartbeatPhase,
} from "./lib/heartbeat.ts"
import {
  DEFAULT_IDEA_STATE,
  buildIdeaReviewRequest,
  drawCategory,
  extractIdea,
  ideaDayContext,
  ideaHash,
  ideaId,
  isDuplicate,
  localDayKey,
  parseBucket,
  readBucket,
  readIdeaConfig,
  recordExpressed,
  recordGenerated,
  resolveIdeaFile,
  reviewAccepted,
  writeIdeaToBucket,
  type IdeaConfig,
  type IdeaState,
} from "./lib/idea.ts"
import { sessionAccounting } from "./lib/transcript.ts"
import { createMoodFeed } from "./lib/mood.ts"
import { createDiagnostics, getLogger, logSettingsFrom, LOG_DEFAULTS } from "./lib/logging.ts"
import { loadMissions, type Mission } from "./lib/missions.ts"
import { parseMissionResult, type MissionResult } from "./lib/mission-result.ts"
import { readDrainConfig } from "./lib/drain/config.ts"
import { readMemoryConfig } from "./lib/memory/config.ts"
import { resolveProvider } from "./lib/memory/registry.ts"
import { createDrainLedger } from "./lib/drain/ledger.ts"
import { findDrainToolResult, runDrainForMission, type DrainToolResult } from "./lib/drain/tool.ts"
import type { DrainPipeClient } from "./lib/drain/pipe.ts"
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
//      (delegation-child pattern), resolved on `session.idle`. The mission runs
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
const HEARTBEAT_TICK_TIMEOUT_MS = 15 * 60_000

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

  // Stale-code guard: a long-lived `opencode serve` can keep ticking with
  // plugin code that predates the latest edits (the pre-warrant digest bug).
  // Refuse to schedule until the process is restarted on current code.
  const startedAtMs = Date.now() - process.uptime() * 1000
  const staleFiles = await staleCodeFiles(dir, startedAtMs)
  if (staleFiles.length > 0) {
    void diag.warn(
      `[heartbeat-hook] plugin code changed after this process started (${staleFiles.join(", ")}); heartbeat scheduler disabled — restart opencode`,
    )
    return {}
  }

  const lockFile = join(stateDir, "heartbeat.lock")
  // Live status marker for the dashboard (§9.2, card 16): written on every
  // phase transition so `idle | in-flight` + the in-flight mission are
  // observable without reading in-process state. Best-effort, single writer.
  const currentFile = join(stateDir, HEARTBEAT_CURRENT_FILE)
  let currentMarker: HeartbeatCurrent = idleHeartbeatCurrent()
  const setCurrent = async (patch: Partial<HeartbeatCurrent>): Promise<void> => {
    currentMarker = { ...currentMarker, ...patch, updated_at: nowIso() }
    await writeHeartbeatCurrent(currentFile, currentMarker)
  }
  // `noop_hash`/`noop_streak` drive B7 day-side backoff (missions-plan §7):
  // consecutive no_reply ticks on an identical digest stretch the cadence ×2/×4.
  const stateStore = createStateStore<{
    last_tick: number
    ticks: number
    noop_hash: string | null
    noop_streak: number
    last_mission: string | null
  }>(join(stateDir, HEARTBEAT_STATE_FILE), {
    last_tick: 0,
    ticks: 0,
    noop_hash: null,
    noop_streak: 0,
    last_mission: null,
  })

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

  // Card 7a (§17.10): the idea pipeline's deterministic half rides the
  // heartbeat — no idea-hook scheduler. Log settings are init-once (the
  // `knowledge:`/`profile:`/`heartbeat:` restart-to-re-rotate policy); the
  // behavioural dials (`enabled`, weights, thresholds) are hot-read per tick.
  const ideaInit = await readIdeaConfig(dir)
  const ideaLogger = getLogger(
    logSettingsFrom(ideaInit as unknown as Record<string, unknown>, "log", "log_"),
    { logDir, home: homedir(), channel: "idea" },
  )
  // Day/gap state: sole writer is this hook (day rollover before the digest,
  // generated/expressed counts after a completed mission).
  const ideaStateStore = createStateStore<IdeaState>(
    join(stateDir, "idea.json"),
    DEFAULT_IDEA_STATE,
  )

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
  // Test-injection seam: point the drain pipe at a fixture SQLite store
  // instead of the real opencode data dir. Production input never carries it.
  const drainDbFile = (rest as { drainDbFile?: string }).drainDbFile

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
      await logger.append({ ts: nowIso(), event: "tick", pid: process.pid, ...entry })
    } catch (err) {
      void diag.error("[heartbeat-hook] tick log failed:", err)
    }
  }

  const logIdea = async (entry: Record<string, unknown>): Promise<void> => {
    try {
      await ideaLogger.append({ ts: nowIso(), ...entry })
    } catch (err) {
      void diag.error("[heartbeat-hook] idea log failed:", err)
    }
  }

  // Card 7a (§17.10) — the deterministic half of `idea-generate`: extract the
  // typed block from the child's final message, dedupe against the bucket,
  // run the JEV reviewer (fail-closed for the write: gate missing, fallback,
  // abstain, or sub-threshold pTrue all reject), then append. Never throws —
  // returns a short ledger tag.
  const storeGeneratedIdea = async (summary: string, cfg: IdeaConfig): Promise<string> => {
    const parsed = extractIdea(summary)
    if (!parsed) {
      await logIdea({ event: "idea-skipped", reason: "no-block" })
      return "no-block"
    }
    const bucketFile = resolveIdeaFile(vaultDir, cfg.bucket_file)
    const current = await readBucket(bucketFile)
    const existing = parseBucket(current)
    if (isDuplicate(parsed.body, existing, cfg.dedupe_threshold)) {
      await logIdea({ event: "idea-skipped", reason: "duplicate", title: parsed.title })
      return "duplicate"
    }
    if (cfg.review) {
      const gate = await openDecisionGate(dir, spawner ? { spawner } : {})
      if (!gate) {
        await logIdea({ event: "idea-review-reject", reason: "no-provider", title: parsed.title })
        return "review-reject"
      }
      const { result, fallback } = await gate.decide(
        buildIdeaReviewRequest(parsed, existing.map((e) => e.title)),
        { fallback: "open" },
      )
      const pTrue = typeof result.probabilities?.true === "number" ? result.probabilities.true : 0
      const accepted = reviewAccepted(result.value, pTrue, fallback, result.abstained, cfg.review_threshold)
      await logIdea({
        event: "idea-review",
        title: parsed.title,
        category: parsed.category,
        pTrue,
        reviewThreshold: cfg.review_threshold,
        accepted,
        fallback,
        reason: result.error ? "error" : undefined,
      })
      if (!accepted) return "review-reject"
    }
    const today = localDayKey(new Date())
    await writeIdeaToBucket(
      bucketFile,
      {
        title: parsed.title,
        category: parsed.category,
        id: ideaId(parsed.body),
        created: today,
        hash: ideaHash(parsed.body),
        body: parsed.body,
      },
      today,
    )
    await logIdea({ event: "idea-generated", title: parsed.title, category: parsed.category })
    return "stored"
  }

  type ChildOutcome = "completed" | "timeout" | "error"

  type ChildRun = {
    outcome: ChildOutcome
    tokenCost: number
    summary: string
    runError?: ReturnType<typeof heartbeatErrorFields>
    sessionId: string | null
    result: MissionResult | null
    tool: DrainToolResult | null
  }

  const runMissionChild = async (args: {
    mission: Mission
    prompt: string
    agent: string
  }): Promise<ChildRun> => {
    let sessionId: string | null = null
    let outcome: ChildOutcome = "error"
    let tokenCost = 0
    let summary = ""
    let runError: ReturnType<typeof heartbeatErrorFields> | undefined
    let result: MissionResult | null = null
    let drainTool: DrainToolResult | null = null

    try {
      const created = await (client as any).session.create({
        body: { title: `heartbeat:${args.mission.id}` },
        query: { directory: dir },
      })
      const childID: string = created?.data?.id
      if (!childID) throw new Error("session.create returned no id")
      sessionId = childID
      automationChildSessions.add(childID)
      await setCurrent({
        phase: "mission",
        mission: args.mission.id,
        mission_title: args.mission.title,
        session: childID,
      })

      const idled = waitForChildIdle(childID)
      const res = await (client as any).session.promptAsync({
        path: { id: childID },
        body: {
          ...(args.agent ? { agent: args.agent } : {}),
          parts: [{ type: "text", text: args.prompt }],
        },
        query: { directory: dir },
      })
      if (res?.error || (res?.response && !res.response.ok)) {
        outcome = "error"
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

      let rows: unknown[] = []
      const attempts = outcome === "completed" ? 5 : 1
      for (let i = 0; i < attempts; i++) {
        const msgs = await (client as any).session
          .messages({ path: { id: childID }, query: { directory: dir } })
          .catch(() => null)
        if (Array.isArray(msgs?.data)) {
          rows = msgs.data
          const acct = sessionAccounting(rows)
          tokenCost = acct.inputTokens + acct.outputTokens
          summary = await sessions.lastAssistantText(childID)
        }
        if (summary || tokenCost > 0 || i === attempts - 1) break
        await sleep(250)
      }

      result = parseMissionResult(rows)
      drainTool = findDrainToolResult(rows)
      if (drainTool) tokenCost += drainTool.tokens
      if (!summary && result?.summary) summary = result.summary
    } catch (err) {
      void diag.error("[heartbeat-hook] mission run failed:", err)
      outcome = "error"
      runError = heartbeatErrorFields("mission", err)
    }

    return { outcome, tokenCost, summary, runError, sessionId, result, tool: drainTool }
  }

  type Decided = {
    verdict: DigestVerdict
    reason: string
    error?: ReturnType<typeof heartbeatErrorFields>
  }

  const decideDigest = async (digest: HeartbeatDigest): Promise<Decided> => {
    const sole = soleDeterministicVerdict(digest.candidates)
    if (sole) return { verdict: sole, reason: "sole-min-gap" }

    try {
      const gate = await openDecisionGate(dir, spawner ? { spawner } : {})
      if (!gate) return { verdict: { kind: "no_reply" }, reason: "decisions-disabled" }
      const prompts = await readDecisionPrompts(dir)
      const outcome = await gate.decide(
        buildDigestChoiceRequest(digest, prompts.digest.assertion),
        { fallback: "open" },
      )
      const verdict = digestVerdictFromResult(
        outcome.result,
        digest.candidates.map((c) => c.id),
      )
      const reason =
        outcome.reason !== "none"
          ? outcome.reason
          : verdict.kind === "no_reply"
            ? "jev-no-reply"
            : "none"
      return { verdict, reason }
    } catch (err) {
      void diag.error("[heartbeat-hook] digest decision failed:", err)
      return {
        verdict: { kind: "no_reply" },
        reason: "error",
        error: heartbeatErrorFields("digest", err),
      }
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
    // Child/writer session that produced this tick, persisted in the ledger
    // so the dashboard can open its transcript from a Recent-ticks row.
    let sessionId: string | null = null
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
      await setCurrent({
        state: "in-flight",
        tick,
        phase: "pre-gate",
        mission: null,
        mission_title: null,
        session: null,
        started_at: nowIso(),
        level: autonomy.level,
      })

      // Card 7a (§17.10): hot-read the idea dials; the day-rollover draw +
      // express gap feed the `idea-roll` / `min-gap:express` candidacy.
      // Pipeline off → no ideaDay (idea-roll fails closed) and no gap store;
      // the rollover persists only on a real day change, never per tick.
      const ideaCfg = await readIdeaConfig(dir)
      let ideaDay: { target: number; generated: number } | undefined
      let ideaGaps: Record<string, number> | undefined
      if (ideaCfg.enabled) {
        const stored = await ideaStateStore.read()
        const rolled = ideaDayContext(stored, nowMs, ideaCfg.daily_weights, Math.random)
        if (rolled.changed) await ideaStateStore.update(() => rolled.state)
        ideaDay = rolled.day
        if (stored.lastExpressedAt !== null) ideaGaps = { express: stored.lastExpressedAt }
      }
      const digestOpts = {
        now: new Date(nowMs),
        ideaDay,
        gaps: ideaGaps,
        minGapMs: { express: ideaCfg.express_min_gap_hours * 3_600_000 },
        dbFile: drainDbFile,
      }
      let digest = await computeDigest(dir, digestOpts)

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
          candidates: digest.candidates.map((c) => `${c.id}:${c.weight.toFixed(2)}`),
          bias: digest.bias,
          ...extra,
          mood_event: moodEvent,
          // Exec time for the dashboard's metrics widget (card 16): ms from
          // tick start to this ledger write.
          duration_ms: Date.now() - nowMs,
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
      await setCurrent({ phase })
      let decided = await decideDigest(digest)
      let verdict = decided.verdict
      let reason = decided.reason
      let digestError = decided.error

      const contextFor = (d: HeartbeatDigest): string =>
        missionContextHeader(
          {
            tick,
            nowMs,
            level: d.level,
            quiet: d.quiet,
            signals: d.signals,
            digestHash: d.digest_hash,
          },
          { tokenBudget: autonomy.mission_token_budget },
        )

      // Every mission is a child session. `runner` is a tool binding; the
      // body names the tool. A null result means the verdict/mission pair
      // could not be assembled (no_reply or a mismatch).
      const selected = async (
        d: HeartbeatDigest,
        v: DigestVerdict,
      ): Promise<{ mission: Mission; run: ChildRun } | null> => {
        const id = v.kind === "mission" ? v.id : null
        if (!id) return null
        const all = await loadMissions(dir).catch(() => [])
        const mission = all.find((m) => m.id === id)
        const brief = assembleMissionBrief(v, mission, undefined, contextFor(d))
        if (!brief || !mission) return null
        // Record the attempt before dispatch: a declined mission still counts
        // as the last mission, so a no-repeat mission is not re-offered next
        // tick (the digest reads this back through `last_mission`).
        await stateStore.update((s) => ({ ...s, last_mission: mission.id }))
        const extra =
          ideaCfg.enabled && brief.mission_id === "idea-generate"
            ? `\n\n=== REQUESTED CATEGORY ===\n${drawCategory(ideaCfg.category_weights, Math.random)}\n=== END REQUESTED CATEGORY ===`
            : ""
        phase = "dispatch"
        await setCurrent({ phase })
        const run = await runMissionChild({
          mission,
          prompt: brief.prompt + extra,
          agent: brief.agent,
        })
        return { mission, run }
      }

      const first = await selected(digest, verdict)
      if (!first) {
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

      let chosen = first
      let totalTokens = first.run.tokenCost
      let reroll: { from: string; reason: string } | null = null
      const declined: string[] = []
      let finalReason = reason
      let finalDecision: "mission" | "no_reply" = "mission"
      let noReplyReason = "mission-declined"

      if (first.run.result?.status === "declined") {
        declined.push(first.mission.id)
        if (first.mission.onDecline === "reroll") {
          reroll = { from: first.mission.id, reason: first.run.result.reason ?? "declined" }
          digest = await computeDigest(dir, {
            ...digestOpts,
            excludeMissions: [...declined],
          })
          phase = "digest"
          await setCurrent({ phase })
          decided = await decideDigest(digest)
          verdict = decided.verdict
          finalReason = decided.reason
          digestError = decided.error
          const second = await selected(digest, verdict)
          if (second) {
            chosen = second
            totalTokens += second.run.tokenCost
            if (second.run.result?.status === "declined") {
              declined.push(second.mission.id)
              finalDecision = "no_reply"
              noReplyReason = "mission-declined"
            }
          } else {
            finalDecision = "no_reply"
            noReplyReason = "declined-reroll-empty"
          }
        } else {
          finalDecision = "no_reply"
          noReplyReason = "mission-declined"
        }
      }

      const run = chosen.run
      const finalMission = chosen.mission
      const finalResult = run.result
      const drainTool = run.tool
      const outcome = run.outcome
      const tokenCost = totalTokens
      const overBudget =
        autonomy.mission_token_budget !== "unlimited" &&
        tokenCost > autonomy.mission_token_budget
      const summary = run.summary
      const runError = run.runError
      const resultStatus: MissionResult["status"] | "missing" =
        finalResult?.status ?? (outcome === "completed" ? "missing" : "error")
      const resultMissing = !finalResult
      const toolSkippedButCompleted =
        drainTool?.status === "skipped" && resultStatus === "completed"
      sessionId = run.sessionId

      if (finalDecision === "no_reply") {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: "silent",
          token_cost: tokenCost,
          over_budget: overBudget,
          gate: "digest",
          reason: noReplyReason,
          ...(sessionId ? { session: sessionId } : {}),
          result_status: resultStatus,
          result_missing: resultMissing,
          ...(drainTool ? { tool_status: drainTool.status, tool_session: drainTool.session } : {}),
          ...(reroll ? { reroll } : {}),
          ...(declined.length ? { declined } : {}),
          ...(runError ?? digestError ? { error: runError ?? digestError } : {}),
        })
        await recordNoop(digest.digest_hash)
        return "fired"
      }

      const missionOk =
        outcome === "completed" && resultStatus !== "declined" && resultStatus !== "error"

      phase = "post"
      await setCurrent({ phase })
      if (!missionOk) {
        await moodFeed.apply("mission_failure")
        moodEvent = "mission_failure"
      }

      // Mission record in the action queue (§7, §10): `source: "heartbeat"`
      // with the reserved result.token_cost filled, then the one-way view
      // refresh. Best-effort — a ledger failure never fails the tick.
      try {
        const backlogCfg = await readBacklogConfig(dir)
        if (backlogCfg.enabled && finalMission) {
          const backlogFile = resolveBacklogFile(stateDir, backlogCfg)
          const { entry } = await append(backlogFile, {
            source: "heartbeat",
            kind: "task",
            payload: {
              title: finalMission.title,
              detail: summary || `heartbeat tick ${tick}: ${outcome}`,
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
        void diag.error("[heartbeat-hook] backlog record failed:", err)
      }

      // Card 7a (§17.10): the idea pipeline's post-run half — a completed
      // idea-generate goes through dedupe + JEV review + bucket append; a
      // completed express stamps the `min-gap:express` store. Best-effort: a
      // failure logs and degrades the ledger tag to "error", never the tick.
      let ideaNote: string | null = null
      if (finalMission && ideaCfg.enabled && missionOk) {
        try {
          if (finalMission.id === "idea-generate") {
            ideaNote = await storeGeneratedIdea(summary, ideaCfg)
            if (ideaNote === "stored") await ideaStateStore.update((s) => recordGenerated(s))
          } else if (finalMission.id === "express") {
            await ideaStateStore.update((s) => recordExpressed(s, Date.now()))
            ideaNote = "expressed"
          }
        } catch (err) {
          void diag.error("[heartbeat-hook] idea post-process failed:", err)
          ideaNote = "error"
        }
      }

      await ledger({
        verdict: `mission:${finalMission.id}`,
        mission: finalMission.id,
        outcome,
        token_cost: tokenCost,
        over_budget: overBudget,
        gate: "digest",
        reason: finalReason,
        ...(sessionId ? { session: sessionId } : {}),
        result_status: resultStatus,
        result_missing: resultMissing,
        ...(drainTool ? { tool_status: drainTool.status, tool_session: drainTool.session } : {}),
        ...(toolSkippedButCompleted ? { tool_skipped_but_completed: true } : {}),
        ...(reroll ? { reroll } : {}),
        ...(declined.length ? { declined } : {}),
        ...(ideaNote ? { idea: ideaNote } : {}),
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
        ...(sessionId ? { session: sessionId } : {}),
      }
      if (ledgerForTick) await ledgerForTick({ verdict: null, mission: null, ...line })
      else await logTick({ tick: null, ...line })
      return "fired"
    } finally {
      ticking = false
      if (lockHeld) await releaseHeartbeatLock(lockFile).catch(() => {})
      // Close the live marker: idle once the tick ends (success, error, or a
      // lock-held skip) — the dashboard never shows a stale in-flight state.
      await setCurrent({
        state: "idle",
        phase: null,
        mission: null,
        mission_title: null,
        session: null,
        started_at: null,
      })
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

  // First wake deferred so plugin init returns first (startup-catch-up
  // pattern); the due check inside means an overdue interval
  // fires once soon after boot — coalesce, never replay (§12.1).
  setTimeout(() => {
    void loop()
  }, 0).unref?.()

  // --- Mission tools --------------------------------------------------------
  // `mission_result` is the only accepted decline signal; `drain_run` is the
  // deterministic drain capability bound by `runner: drain-pipe`.
  const schema = tool.schema

  const missionResultTool = tool({
    description:
      "Record the final result of this heartbeat mission. Call exactly once before stopping. " +
      "Use status \"declined\" when the mission cannot proceed (and stop without side effects).",
    args: {
      status: schema
        .enum(["completed", "declined", "error"])
        .describe("completed = did the work; declined = nothing to do / precondition unmet; error = failed."),
      summary: schema.string().describe("One-line outcome summary."),
      reason: schema.string().optional().describe("Short decline/error reason."),
    },
    async execute(args: any) {
      return JSON.stringify({ ok: true, received: args })
    },
  })

  const drainRunTool = tool({
    description:
      "Run the memory-consolidation drain once. Returns status completed or skipped plus outcome, " +
      "summary, tokens, writer session, and cursor counts. A skipped result means the mission should " +
      "decline via mission_result.",
    args: {},
    async execute() {
      try {
        const drainCfg = await readDrainConfig(dir)
        const memoryCfg = await readMemoryConfig(dir)
        const provider = resolveProvider(memoryCfg.provider, {
          directory: dir,
          stateDir,
          vaultDir,
          drain: drainCfg,
          dbFile: drainDbFile,
          onWarn: (msg, err) => void diag.warn(`[heartbeat-hook] ${msg}`, err),
        })
        const result = await runDrainForMission({
          directory: dir,
          stateDir,
          vaultDir,
          config: drainCfg,
          client: client as unknown as DrainPipeClient,
          provider,
          waitForIdle: waitForChildIdle,
          registerChild: (sid) => automationChildSessions.add(sid),
          dbFile: drainDbFile,
          ledger: createDrainLedger({ logDir, home: homedir() }),
          onWarn: (msg, err) => void diag.warn(`[heartbeat-hook] ${msg}`, err),
        })
        return JSON.stringify(result)
      } catch (err) {
        void diag.error("[heartbeat-hook] drain_run failed:", err)
        return JSON.stringify({
          status: "completed",
          reason: null,
          outcome: "error",
          summary: "drain:error",
          tokens: 0,
          session: null,
          cursor_before: null,
          cursor_after: null,
          sessions: 0,
          items: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })

  // --- Hook surface ---------------------------------------------------------
  return {
    tool: {
      mission_result: missionResultTool,
      drain_run: drainRunTool,
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid) return
      childIdleResolvers.get(sid)?.()
    },
  }
}) satisfies Plugin
