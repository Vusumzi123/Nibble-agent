import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
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
import { acquireOwnership, ownershipFile, type OwnershipHandle } from "./lib/ownership.ts"
import {
  DEFAULT_HEARTBEAT_CONFIG,
  HEARTBEAT_CURRENT_FILE,
  HEARTBEAT_STATE_FILE,
  HEARTBEAT_WAKE_CAP_MS,
  assembleMissionBrief,
  buildDigestChoiceRequest,
  computeDigest,
  computeWakeDelayMs,
  deterministicDigestFallback,
  digestVerdictFromResult,
  effectiveFrequencyMs,
  frequencyToMs,
  idleHeartbeatCurrent,
  missionStallMs,
  missionTimeoutMs,
  readHeartbeatConfig,
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
import {
  MAX_REQUEUES,
  WORK_QUEUE_FILE,
  type FairPick,
  type SchedulerState,
  type WorkItem,
  dequeueById,
  enqueueWork,
  loadWorkQueueState,
  pickFair,
  pickNext,
  pruneWork,
  queueDepth,
  queueEmpty,
  refundFairPick,
  saveWorkQueueState,
  stallResumeItem,
} from "./lib/work-queue.ts"
import { readSchedulerConfig } from "./lib/scheduler-config.ts"
import {
  type ProducerCtx,
  collectWork,
  itemRunnable,
  itemStillDue,
  missionIdOf,
  missionItemId,
} from "./lib/work-producers.ts"
import { parseMissionResult, type MissionResult } from "./lib/mission-result.ts"
import {
  deterministicResumeSummary,
  renderMissionTranscript,
  resumeContextBlock,
  summarizeMissionAttempt,
  type ResumePayload,
} from "./lib/mission-resume.ts"
import { readDrainConfig } from "./lib/drain/config.ts"
import { drainDue, runDrainStep } from "./lib/drain/step.ts"
import { runSteps, type StepKind } from "./lib/step-registry.ts"
import { readMemoryConfig } from "./lib/memory/config.ts"
import { resolveProvider } from "./lib/memory/registry.ts"
import { createDrainLedger } from "./lib/drain/ledger.ts"
import { findDrainToolResult, runDrainForMission, type DrainToolResult } from "./lib/drain/tool.ts"
import type { DrainPipeClient } from "./lib/drain/pipe.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools } from "./lib/sessions.ts"
import { createStateStore } from "./lib/state.ts"
import { nowIso, sleep } from "./lib/util.ts"

/** Post-abort idle confirmation budget (plan 5.2) — never the tick budget. */
const HEARTBEAT_ABORT_CONFIRM_MS = 10_000

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
//   4. Acquire the in-process single-flight flag + the cross-instance
//      ownership lease `.opencode/state/ownership.lock` (short TTL, renewed
//      while held; a stale lease is stealable). A live lease skips the tick —
//      one mission at a time even when a TUI-embedded server and a separate
//      `opencode serve` both load this plugin.
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
// `.opencode/state/heartbeat.json`, the cross-instance lease in
// `.opencode/state/ownership.lock`.

/** A mission child session that never idles is abandoned after this budget
 *  unless `heartbeat.mission_timeout_minutes` overrides it (hot-read per tick;
 *  0 = never time out). The lock's stale steal is the crash backstop. */
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

  // One short-lease ownership guard (deconcurrency plan, Phase 1): the only
  // cross-instance exclusion. A live holder that stops refreshing is
  // stealable after the TTL, so a hung instance cannot stall the project.
  const ownershipPath = ownershipFile(stateDir)
  const workQueueFile = join(stateDir, WORK_QUEUE_FILE)
  // Live status marker for the UI (§9.2, card 16): written on every
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
  // Test-injection seam: shrink the stall window so a watchdog abort (and the
  // lane-queue requeue path) is testable. Production input never carries it;
  // otherwise the window hot-reads from `heartbeat.mission_stall_minutes` at
  // the start of each tick.
  const tickStallOverride = (rest as { tickTimeoutMs?: number }).tickTimeoutMs
  let tickStallMs = tickStallOverride ?? missionStallMs(DEFAULT_HEARTBEAT_CONFIG)
  // Test-injection seam for the optional hard ceiling. Production never
  // carries it; the real value hot-reads from `heartbeat.mission_timeout_minutes`.
  const tickCeilingOverride = (rest as { tickCeilingMs?: number }).tickCeilingMs
  let tickCeilingMs = tickCeilingOverride ?? missionTimeoutMs(DEFAULT_HEARTBEAT_CONFIG)
  // Test-injection seam: shrink the post-abort idle confirmation so a failed
  // abort is observable without waiting the real 10 s. Production input never
  // carries it.
  const abortConfirmMs =
    (rest as { abortConfirmMs?: number }).abortConfirmMs ?? HEARTBEAT_ABORT_CONFIRM_MS
  // Test-injection seam: point the drain pipe at a fixture SQLite store
  // instead of the real opencode data dir. Production input never carries it.
  const drainDbFile = (rest as { drainDbFile?: string }).drainDbFile

  // In-process single-flight (the file lock covers cross-instance overlap).
  let ticking = false

  // Child-idle waiters, resolved from the event hook below (never a poll
  // loop). Registered BEFORE the prompt so the child's first idle is caught.
  const childIdleResolvers = new Map<string, () => void>()

  // --- Stall watchdog (docs/heartbeat-timeout-lock-resume.md §5.2) ---------
  // Silence is measured per tracked child; activity in a descendant session
  // bubbles up to its ancestors through `parentID`, so a working sub-agent
  // keeps its mission alive and a silent one stalls it. Only shell-type open
  // tools are exempt in v1 (a long silent compile is not a hang); a `task`
  // call is deliberately not exempt.
  type ChildActivity = { at: number; kind: string }
  const childActivity = new Map<string, ChildActivity>()
  const childParent = new Map<string, string>()
  const openShellCount = new Map<string, number>()
  const openShellCalls = new Map<string, Set<string>>()
  const childStop = new Map<
    string,
    { reason: "stall" | "ceiling"; stalledForMs: number; lastActivity: string }
  >()
  const SHELL_TOOLS = new Set(["bash", "shell"])

  /** The session plus every ancestor known from `session.created`. */
  const ancestryOf = (sessionID: string): string[] => {
    const chain: string[] = []
    const seen = new Set<string>()
    let sid: string | undefined = sessionID
    while (sid && !seen.has(sid)) {
      seen.add(sid)
      chain.push(sid)
      sid = childParent.get(sid)
    }
    return chain
  }

  // Descendants opencode's task listener already cancelled emit `session.idle`
  // before the mission abort; they must not be aborted a second time (P3a-f2).
  const settledSessions = new Set<string>()

  /** Every known session below `rootID` (excluding the root itself). */
  const descendantsOf = (rootID: string): string[] => {
    const out: string[] = []
    for (const sid of childParent.keys()) {
      if (sid !== rootID && ancestryOf(sid).includes(rootID)) out.push(sid)
    }
    return out
  }

  /** Any event for a session (or a descendant) resets its ancestors' clocks. */
  const touchActivity = (sessionID: string, kind: string): void => {
    const at = Date.now()
    for (const sid of ancestryOf(sessionID)) {
      if (childActivity.has(sid)) childActivity.set(sid, { at, kind })
    }
  }

  const trackChild = (childID: string): void => {
    childActivity.set(childID, { at: Date.now(), kind: "session" })
  }

  /** Open/close a shell-type tool call; count it against every ancestor. */
  const setOpenShell = (sessionID: string, callID: string, open: boolean): void => {
    let calls = openShellCalls.get(sessionID)
    if (open) {
      if (calls?.has(callID)) return
      if (!calls) {
        calls = new Set()
        openShellCalls.set(sessionID, calls)
      }
      calls.add(callID)
    } else {
      if (!calls?.delete(callID)) return
    }
    const delta = open ? 1 : -1
    for (const sid of ancestryOf(sessionID)) {
      openShellCount.set(sid, Math.max(0, (openShellCount.get(sid) ?? 0) + delta))
    }
  }

  /** Drop all watchdog state for a settled child and its descendants. */
  const releaseChild = (childID: string): void => {
    const doomed = new Set([childID])
    let grew = true
    while (grew) {
      grew = false
      for (const [sid, parent] of childParent) {
        if (doomed.has(parent) && !doomed.has(sid)) {
          doomed.add(sid)
          grew = true
        }
      }
    }
    for (const sid of doomed) {
      childActivity.delete(sid)
      childStop.delete(sid)
      childParent.delete(sid)
      settledSessions.delete(sid)
      openShellCount.delete(sid)
      openShellCalls.delete(sid)
    }
  }

  const taskAgentName = (part: any): string => {
    const input = part?.state?.input ?? {}
    const name = input.subagent_type ?? input.agent ?? input.description
    return typeof name === "string" && name.length > 0 ? name : "task"
  }

  /**
   * Wait for a child to go idle. `confirmMs` is the post-abort confirmation:
   * a plain bounded wait (activity must not extend it). Otherwise resolve
   * false only after `stallMs` of silence with no exempt open shell tool, or
   * after the optional wall-clock `ceilingMs`.
   */
  const waitForChildIdle = (
    childID: string,
    opts: { stallMs?: number; ceilingMs?: number; confirmMs?: number } = {},
  ): Promise<boolean> =>
    new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null
      const startedAt = Date.now()
      const finish = (idle: boolean): void => {
        if (timer) clearTimeout(timer)
        childIdleResolvers.delete(childID)
        if (idle) releaseChild(childID)
        resolve(idle)
      }
      if (!childActivity.has(childID)) trackChild(childID)
      childIdleResolvers.set(childID, () => finish(true))

      if (opts.confirmMs !== undefined) {
        timer = setTimeout(() => finish(false), opts.confirmMs)
        timer.unref?.()
        return
      }

      const stallMs = opts.stallMs ?? tickStallMs
      const ceilingMs = opts.ceilingMs ?? tickCeilingMs
      const checkEveryMs =
        stallMs > 0 ? Math.max(10, Math.min(30_000, Math.floor(stallMs / 4))) : 30_000
      const check = (): void => {
        const now = Date.now()
        const last = childActivity.get(childID)
        const stalledForMs = now - (last?.at ?? startedAt)
        if (ceilingMs > 0 && now - startedAt >= ceilingMs) {
          childStop.set(childID, {
            reason: "ceiling",
            stalledForMs,
            lastActivity: last?.kind ?? "session",
          })
          finish(false)
          return
        }
        if (stallMs > 0 && (openShellCount.get(childID) ?? 0) === 0 && stalledForMs >= stallMs) {
          childStop.set(childID, {
            reason: "stall",
            stalledForMs,
            lastActivity: last?.kind ?? "session",
          })
          finish(false)
          return
        }
        timer = setTimeout(check, checkEveryMs)
        timer.unref?.()
      }
      timer = setTimeout(check, checkEveryMs)
      timer.unref?.()
    })

  /**
   * Cancel descendant task sessions after a confirmed mission abort (P3a-f2).
   * opencode only cascades to FOREGROUND task children; background (and
   * promoted) tasks attach no abort listener and would keep running/writing.
   * Best effort and bounded: each abort is a single SDK call, no idle confirm,
   * so a descendant that never reports idle cannot stretch the tick. A failed
   * call is recorded, never counted as stopped.
   */
  const abortDescendants = async (
    ids: string[],
  ): Promise<{ aborted: string[]; error?: string }> => {
    const aborted: string[] = []
    const errors: string[] = []
    await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await (client as any).session.abort({
            path: { id },
            query: { directory: dir },
          })
          if (res?.error || (res?.response && !res.response.ok)) {
            const message =
              (res?.error as { message?: string } | undefined)?.message ??
              `session.abort failed (status ${res?.response?.status ?? "unknown"})`
            errors.push(`${id}: ${message}`)
            return
          }
          aborted.push(id)
        } catch (err) {
          errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    )
    aborted.sort()
    return { aborted, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) }
  }

  /**
   * Stop a stalled child (docs/heartbeat-timeout-lock-resume.md §5.2).
   * Aborts via the v2 SDK, then confirms the stop with a FRESH bounded idle
   * wait. A failed abort reports `ok: false` so the caller records an error
   * and never claims a clean stop. On a confirmed stop, descendant task
   * sessions are cancelled too (P3a-f2); their ids are captured up front
   * because the primary confirm releases the session tree.
   */
  const abortSession = async (
    childID: string,
    reason: string,
  ): Promise<{
    ok: boolean
    error?: string
    orphans?: { aborted: string[]; error?: string }
  }> => {
    const orphans = descendantsOf(childID).filter((id) => !settledSessions.has(id))
    try {
      const res = await (client as any).session.abort({
        path: { id: childID },
        query: { directory: dir },
      })
      if (res?.error || (res?.response && !res.response.ok)) {
        const message =
          (res?.error as { message?: string } | undefined)?.message ??
          `session.abort failed (status ${res?.response?.status ?? "unknown"})`
        return { ok: false, error: message }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const confirmed = await waitForChildIdle(childID, { confirmMs: abortConfirmMs })
    if (!confirmed) {
      return {
        ok: false,
        error: `session did not go idle within ${abortConfirmMs}ms of ${reason} abort`,
      }
    }
    if (orphans.length === 0) return { ok: true }
    return { ok: true, orphans: await abortDescendants(orphans) }
  }

  const logTick = async (entry: Record<string, unknown>): Promise<void> => {
    try {
      await logger.append({ ts: nowIso(), event: "tick", pid: process.pid, ...entry })
    } catch (err) {
      void diag.error("[heartbeat-hook] tick log failed:", err)
    }
  }

  // Drain is a STEP of this loop (deconcurrency plan, Phase 1): no consumer
  // timer, no drain.lock. The tick runs at most one drain pass, and only when
  // no mission work is waiting — mission > drain-pass in the priority order.
  const drainLedger = createDrainLedger({ logDir, home: homedir() })
  const runDrainWork = async () =>
    runDrainStep({
      directory: dir,
      stateDir,
      vaultDir,
      client: client as unknown as DrainPipeClient,
      waitForIdle: waitForChildIdle,
      registerChild: (sid) => automationChildSessions.add(sid),
      ...(drainDbFile === undefined ? {} : { dbFile: drainDbFile }),
      ledger: drainLedger,
      resolveProvider: async () => {
        const memoryCfg = await readMemoryConfig(dir)
        return resolveProvider(memoryCfg.provider, {
          directory: dir,
          stateDir,
          vaultDir,
          drain: await readDrainConfig(dir),
          dbFile: drainDbFile,
          onWarn: (msg, err) => void diag.warn(`[heartbeat-hook] ${msg}`, err),
        })
      },
      onWarn: (msg, err) => void diag.warn(`[heartbeat-hook] ${msg}`, err),
    })

  // Drain health for the tick ledger line (§5.3): the consumer's live marker is
  // gone, so this is a tolerant read of a legacy file — never a DB call on the
  // tick's critical path.
  const drainHealth = async (): Promise<{
    pending: number | null
    oldest_age_ms: number | null
    last_wake_age_ms: number | null
  } | null> => {
    try {
      const cfg = await readDrainConfig(dir)
      if (!cfg.enabled) return null
      const raw = await readFile(join(stateDir, "drain.current.json"), "utf8")
      const marker = JSON.parse(raw) as {
        pending?: number | null
        oldest_pending_age_ms?: number | null
        updated_at?: string
      }
      const updatedMs = marker.updated_at ? Date.parse(marker.updated_at) : NaN
      return {
        pending: typeof marker.pending === "number" ? marker.pending : null,
        oldest_age_ms:
          typeof marker.oldest_pending_age_ms === "number" ? marker.oldest_pending_age_ms : null,
        last_wake_age_ms: Number.isFinite(updatedMs) ? Math.max(0, Date.now() - updatedMs) : null,
      }
    } catch {
      return null
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
    /** Present only when a timeout triggered an abort attempt. */
    aborted?: boolean
    abortError?: string
    /** Why the child was stopped (`stall` | `ceiling`) and the evidence. */
    stopReason?: "stall" | "ceiling"
    stalledForMs?: number
    lastActivity?: string
    /** Descendant sessions cancelled after a confirmed abort (P3a-f2). */
    orphanAborted?: string[]
    orphanAbortError?: string
    /** ISO time the stall watchdog stopped the child (resume payload). */
    stoppedAt?: string
    /** Transcript rows sampled after the stop (summary source, P4c). */
    transcriptRows?: unknown[]
    /** Id of the resume item this run re-enqueued (P4c ledger). */
    resumeItem?: string
    /** Which summary path fed the resume item; null when capped before summarizing. */
    summarizer?: "llm" | "fallback" | null
    /** The resume ceiling dropped this run's item instead of re-enqueueing it. */
    resumeAbandoned?: boolean
  }

  const runMissionChild = async (args: {
    mission: Mission
    prompt: string
    agent: string
    /** Which lane's marker fields this run patches (docs/heartbeat-lanes.md). */
    slot?: "primary" | "side"
  }): Promise<ChildRun> => {
    let sessionId: string | null = null
    let outcome: ChildOutcome = "error"
    let tokenCost = 0
    let summary = ""
    let runError: ReturnType<typeof heartbeatErrorFields> | undefined
    let result: MissionResult | null = null
    let drainTool: DrainToolResult | null = null
    let aborted: boolean | undefined
    let abortError: string | undefined
    let stopReason: "stall" | "ceiling" | undefined
    let stalledForMs: number | undefined
    let lastActivity: string | undefined
    let orphanAborted: string[] | undefined
    let orphanAbortError: string | undefined
    let stoppedAt: string | undefined
    let transcriptRows: unknown[] | undefined
    const slot = args.slot ?? "primary"

    try {
      const created = await (client as any).session.create({
        body: { title: `heartbeat:${args.mission.id}` },
        query: { directory: dir },
      })
      const childID: string = created?.data?.id
      if (!childID) throw new Error("session.create returned no id")
      sessionId = childID
      automationChildSessions.add(childID)
      trackChild(childID)
      await setCurrent(
        slot === "side"
          ? {
              phase: "mission",
              side_mission: args.mission.id,
              side_mission_title: args.mission.title,
              side_session: childID,
            }
          : {
              phase: "mission",
              mission: args.mission.id,
              mission_title: args.mission.title,
              session: childID,
            },
      )

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
      } else if (await idled) {
        outcome = "completed"
      } else {
        // Stalled (or past the optional ceiling): stop the child before
        // sampling its transcript, and keep the lock only for the bounded
        // abort confirm (plan §5.2).
        const stop = childStop.get(childID)
        stopReason = stop?.reason ?? "stall"
        stalledForMs = stop?.stalledForMs
        lastActivity = stop?.lastActivity
        stoppedAt = new Date().toISOString()
        const abort = await abortSession(childID, stopReason)
        aborted = abort.ok
        if (abort.orphans) {
          orphanAborted = abort.orphans.aborted
          orphanAbortError = abort.orphans.error
        }
        if (abort.ok) {
          outcome = "timeout"
        } else {
          outcome = "error"
          abortError = abort.error ?? "abort failed"
          runError = heartbeatErrorFields("mission", new Error(abortError))
        }
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
      transcriptRows = rows
    } catch (err) {
      void diag.error("[heartbeat-hook] mission run failed:", err)
      outcome = "error"
      runError = heartbeatErrorFields("mission", err)
    }

    if (sessionId) releaseChild(sessionId)

    return {
      outcome,
      tokenCost,
      summary,
      runError,
      sessionId,
      result,
      tool: drainTool,
      ...(aborted === undefined ? {} : { aborted }),
      ...(abortError === undefined ? {} : { abortError }),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(stalledForMs === undefined ? {} : { stalledForMs }),
      ...(lastActivity === undefined ? {} : { lastActivity }),
      ...(orphanAborted === undefined ? {} : { orphanAborted }),
      ...(orphanAbortError === undefined ? {} : { orphanAbortError }),
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
      ...(transcriptRows === undefined ? {} : { transcriptRows }),
    }
  }

  type Decided = {
    verdict: DigestVerdict
    reason: string
    error?: ReturnType<typeof heartbeatErrorFields>
  }

  const decideDigest = async (digest: HeartbeatDigest): Promise<Decided> => {
    // No primary candidates: the verdict is decided already — never spend a
    // JEV call on a choice list of one (`no_reply`).
    if (digest.candidates.length === 0) {
      return { verdict: { kind: "no_reply" }, reason: "no-candidates" }
    }
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
      let verdict = digestVerdictFromResult(
        outcome.result,
        digest.candidates.map((c) => c.id),
      )
      let reason =
        outcome.reason !== "none"
          ? outcome.reason
          : verdict.kind === "no_reply"
            ? "jev-no-reply"
            : "none"
      // A provider fallback (abstain/error/shape) that resolves to silence
      // must not starve warranted work: dispatch the highest-weight
      // pending-work candidate instead. Confident no_reply (no fallback) and
      // usable mission verdicts are untouched.
      if (outcome.fallback && verdict.kind === "no_reply") {
        const pending = deterministicDigestFallback(digest)
        if (pending) {
          verdict = pending
          reason = `${outcome.reason}:pending-work`
        }
      }
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
    let ownership: OwnershipHandle | null = null
    // Troubleshooting trail: which stage the tick is in, and the ledger
    // closure once it exists — so ANY failure below leaves one
    // `outcome: "error"` ledger line with a phase-tagged error, never silent.
    let phase: HeartbeatPhase = "pre-gate"
    let ledgerForTick: ((extra: Record<string, unknown>) => Promise<void>) | null = null
    // Child/writer session that produced this tick, persisted in the ledger
    // so the UI can open its transcript from a Recent-ticks row.
    let sessionId: string | null = null
    try {
      // 1-2. Hot-read the kill switch and the dial. A malformed frequency
      // parses to null and sleeps — a garbage dial must never fire the
      // heartbeat.
      const hbCfg = await readHeartbeatConfig(dir)
      if (!hbCfg.enabled) return "sleeping"
      // Hot-read the child budget: a config flip applies from the next tick
      // (the test seam wins when injected so timeout/requeue stays testable).
      // Hot-read the watchdog dials: a config flip applies from the next tick
      // (the test seams win when injected so timeout/requeue stays testable).
      if (tickStallOverride === undefined) tickStallMs = missionStallMs(hbCfg)
      if (tickCeilingOverride === undefined) tickCeilingMs = missionTimeoutMs(hbCfg)

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

      // 4. Cross-instance lease; a live holder means another instance is
      // inside a tick (overrun semantics) — skip, retry next wake.
      const lease = await acquireOwnership(ownershipPath, { nowMs })
      if (!lease) return "lock-held"
      ownership = lease
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
      // or an explicit JEV no_reply choice. Each line carries the drain
      // consumer's health (plan §5.3) so the tick view never needs drain.log.
      let drainHealthCache: Awaited<ReturnType<typeof drainHealth>> | undefined
      let schedulerFields: Record<string, unknown> = {}
      const ledger = (extra: Record<string, unknown>): Promise<void> =>
        (async () => {
          if (drainHealthCache === undefined) drainHealthCache = await drainHealth()
          return logTick({
            tick,
            digest_hash: digest.digest_hash,
            level: digest.level,
            quiet: digest.quiet,
            candidates: digest.candidates.map((c) => `${c.id}:${c.weight.toFixed(2)}`),
            bias: digest.bias,
            ...schedulerFields,
            ...extra,
            ...(drainHealthCache ? { drain: drainHealthCache } : {}),
            mood_event: moodEvent,
            // Exec time for the UI's metrics widget (card 16): ms from
            // tick start to this ledger write.
            duration_ms: Date.now() - nowMs,
          })
        })()
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

      // 6a. The single work queue: producers collect deterministic work — zero
      // LLM calls. The tick producer projects the digest's candidate missions;
      // brain-stale adds a staleness item. Drain is a queued `drain-pass` kind.
      phase = "queues"
      await setCurrent({ phase })
      const drainCfgForTick = await readDrainConfig(dir).catch(() => null)
      const allMissions = await loadMissions(dir).catch(() => [])
      const drainCfgForProducers = drainCfgForTick
      const drainConsumerOwnsDrain = Boolean(drainCfgForProducers?.enabled && drainCfgForProducers?.consumer)
      const producerCtx: ProducerCtx = {
        nowMs,
        level: digest.level,
        quiet: digest.quiet,
        signals: digest.signals,
        missions: allMissions,
        candidates: digest.candidates,
        lastMission: state.last_mission,
        drainConsumer: drainConsumerOwnsDrain,
      }
      const schedulerCfg = await readSchedulerConfig(dir).catch(() => ({
        fair: true,
        weights: { mission: 4, "drain-pass": 3, "quiet-hours": 1, staleness: 1, "profile-update": 1, "soul-update": 1 },
      }))
      const queueState = await loadWorkQueueState(workQueueFile)
      let work = enqueueWork(queueState.items, collectWork(producerCtx))
      work = pruneWork(work, nowMs, (item) => itemStillDue(producerCtx, item)).queue
      const fair = schedulerCfg.fair
      let scheduler: SchedulerState = { ...queueState.scheduler, fair }

      // Drain is work, not a loop: enqueue the kind when the backlog triggers.
      if (drainCfgForTick?.enabled && drainCfgForTick.consumer) {
        const due = await drainDue({
          directory: dir,
          stateDir,
          ...(drainDbFile === undefined ? {} : { dbFile: drainDbFile }),
        })
        if (due.due) {
          work = enqueueWork(work, [
            { id: "drain-pass", kind: "drain-pass", producer: "scheduler", enqueued_ms: nowMs, requeue_count: 0 },
          ])
        }
      }

      let fairPick: FairPick | null = null
      let nextWork: WorkItem | null = null
      if (fair) {
        fairPick = pickFair(
          work,
          scheduler,
          nowMs,
          (item) => itemRunnable(producerCtx, item),
          schedulerCfg.weights,
        )
        if (!fairPick) {
          await saveWorkQueueState(workQueueFile, work, scheduler)
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: "silent",
            token_cost: 0,
            gate: "queues",
            reason: "empty",
            queues: queueDepth(work),
            scheduler_fair: true,
          })
          await recordNoop(digest.digest_hash)
          return "fired"
        }
        scheduler = fairPick.scheduler
        schedulerFields = {
          scheduler_fair: true,
          scheduled_kind: fairPick.kind,
          scheduler_runnable: fairPick.runnable,
          scheduler_credit_before: fairPick.credit_before,
          scheduler_credit_after: fairPick.credit_after,
        }
        if (!itemRunnable(producerCtx, fairPick.item)) {
          scheduler = refundFairPick(scheduler, fairPick)
          fairPick = pickFair(
            work,
            scheduler,
            nowMs,
            (item) => itemRunnable(producerCtx, item),
            schedulerCfg.weights,
          )
          if (!fairPick) {
            await saveWorkQueueState(workQueueFile, work, scheduler)
            await ledger({
              verdict: "no_reply",
              mission: null,
              outcome: "silent",
              token_cost: 0,
              gate: "queues",
              reason: "empty",
              queues: queueDepth(work),
              scheduler_fair: true,
            })
            await recordNoop(digest.digest_hash)
            return "fired"
          }
          scheduler = fairPick.scheduler
          schedulerFields = {
            scheduler_fair: true,
            scheduled_kind: fairPick.kind,
            scheduler_runnable: fairPick.runnable,
            scheduler_credit_before: fairPick.credit_before,
            scheduler_credit_after: fairPick.credit_after,
          }
        }
        await saveWorkQueueState(workQueueFile, work, scheduler)

        if (fairPick.kind === "drain-pass") {
          const picked = dequeueById(work, fairPick.item.id)
          if (picked) work = picked.rest
          await saveWorkQueueState(workQueueFile, work, scheduler)
          phase = "drain"
          await setCurrent({ phase })
          const step = await runDrainWork()
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: step.ran ? (step.result.outcome === "error" ? "error" : "completed") : "silent",
            token_cost: step.ran ? step.result.tokens ?? 0 : 0,
            gate: "drain",
            reason: step.ran ? `drain:${step.result.outcome}` : `drain:${step.reason}`,
          })
          if (step.ran) await recordExecution()
          else await recordNoop(digest.digest_hash)
          return "fired"
        }

        if (fairPick.kind !== "mission" && fairPick.kind !== "staleness") {
          const picked = dequeueById(work, fairPick.item.id)
          if (picked) work = picked.rest
          await saveWorkQueueState(workQueueFile, work, scheduler)
          phase = fairPick.kind
          await setCurrent({ phase })
          const errors: string[] = []
          await runSteps([fairPick.kind as StepKind], (kind, err) => {
            errors.push(kind)
            void diag.error(`[heartbeat-hook] step ${kind} failed:`, err)
          })
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: errors.length ? "error" : "completed",
            token_cost: 0,
            gate: fairPick.kind,
            reason: errors.length ? "step-error" : "step",
          })
          await recordExecution()
          return "fired"
        }
      } else {
        // Rollback path: strict priority, preserving the legacy side lane.
        nextWork = pickNext(work, nowMs, (item) => itemRunnable(producerCtx, item))
        schedulerFields = { scheduler_fair: false }
        if (nextWork?.kind === "drain-pass") {
          const picked = dequeueById(work, nextWork.id)
          if (picked) work = picked.rest
          await saveWorkQueueState(workQueueFile, work, scheduler)
          phase = "drain"
          await setCurrent({ phase })
          const step = await runDrainWork()
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: step.ran ? (step.result.outcome === "error" ? "error" : "completed") : "silent",
            token_cost: step.ran ? step.result.tokens ?? 0 : 0,
            gate: "drain",
            reason: step.ran ? `drain:${step.result.outcome}` : `drain:${step.reason}`,
          })
          if (step.ran) await recordExecution()
          else await recordNoop(digest.digest_hash)
          return "fired"
        }
      }

      // No mission.lock (Phase 1): the single loop is the executor, so the
      // dispatch section cannot overlap anything else in this process.

      await saveWorkQueueState(workQueueFile, work, scheduler)

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
      // P4c (§5.5): a dequeued item that carries a resume payload injects the
      // continuation block AFTER the mission context header, for both lanes.
      const resumeBlockFor = (item: WorkItem | null | undefined): string => {
        const payload = item?.payload as Partial<ResumePayload> | undefined
        if (!payload || payload.resume !== true || !payload.summary) return ""
        try {
          return resumeContextBlock(payload as ResumePayload)
        } catch {
          // A malformed legacy payload must never fail the dispatch.
          return ""
        }
      }

      // Nothing queued: nothing to do this tick — silent, zero LLM calls.
      if (queueEmpty(work)) {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: "silent",
          token_cost: 0,
          gate: "queues",
          reason: "empty",
          queues: queueDepth(work),
        })
        await recordNoop(digest.digest_hash)
        return "fired"
      }

      // 6c. Side lane: exactly one dequeue per tick, FIFO among runnable
      // items (a menu-window-blocked item stays queued). The side child runs
      // to completion BEFORE the primary lane starts, so the lanes never
      // race on vault writes.
      type LaneRun = { mission: Mission; run: ChildRun; item: WorkItem }
      let sideRun: LaneRun | null = null
      const fairStaleness = fair && fairPick?.kind === "staleness"
      const sideItem = fair
        ? fairStaleness
          ? fairPick!.item
          : null
        : pickNext(work, nowMs, (item) =>
            item.kind === "staleness" && itemRunnable(producerCtx, item),
          )
      const sidePick = sideItem ? dequeueById(work, sideItem.id) : null
      if (sidePick) {
        work = sidePick.rest
        await saveWorkQueueState(workQueueFile, work, scheduler)
        const sideMission = allMissions.find((m) => m.id === missionIdOf(sidePick.item))
        const sideBrief = sideMission
          ? assembleMissionBrief(
              { kind: "mission", id: sideMission.id },
              sideMission,
              undefined,
              contextFor(digest),
              resumeBlockFor(sidePick.item),
            )
          : null
        if (sideMission && sideBrief) {
          // Record the attempt before dispatch (same discipline as primary):
          // the no-repeat suppression reads it back through `last_mission`.
          await stateStore.update((s) => ({ ...s, last_mission: sideMission.id }))
          phase = "dispatch"
          await setCurrent({ phase })
          const run = await runMissionChild({
            mission: sideMission,
            prompt: sideBrief.prompt,
            agent: sideBrief.agent,
            slot: "side",
          })
          sideRun = { mission: sideMission, run, item: sidePick.item }
        }
      }

      // 7a. JEV digest decision. Fail-open to no_reply: decisions disabled,
      // error, abstain, or unknown id all mean silence — never invent work.
      phase = "digest"
      await setCurrent({ phase })
      let decided = fairStaleness
        ? { verdict: { kind: "no_reply" } as DigestVerdict, reason: "staleness", error: undefined }
        : await decideDigest(digest)
      let verdict = decided.verdict
      let reason = decided.reason
      let digestError = decided.error

      // Every mission is a child session. `runner` is a tool binding; the
      // body names the tool. A null result means the verdict/mission pair
      // could not be assembled (no_reply or a mismatch).
      const selected = async (
        d: HeartbeatDigest,
        v: DigestVerdict,
      ): Promise<{ mission: Mission; run: ChildRun; item: WorkItem | null } | null> => {
        const id = v.kind === "mission" ? v.id : null
        if (!id) return null
        const mission = allMissions.find((m) => m.id === id)
        if (!mission) return null
        // The dequeued item is needed BEFORE the brief is assembled: a resume
        // item injects the === RESUMED MISSION === block (plan §5.5).
        const pick = dequeueById(work, missionItemId(mission.id))
        if (pick) work = pick.rest
        const brief = assembleMissionBrief(
          v,
          mission,
          undefined,
          contextFor(d),
          resumeBlockFor(pick?.item),
        )
        if (!brief) return null
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
          slot: "primary",
        })
        return { mission, run, item: pick?.item ?? null }
      }

      // Item settlement (docs/heartbeat-lanes.md): a timeout re-enqueues at
      // the queue tail with the reason recorded; error/declined/completed
      // drop. Past MAX_REQUEUES a timeout drops too.
      // P4c (§5.3/§5.6): summarize the stopped attempt UNDER the mission.lock
      // hold before the item is re-enqueued. The summarizer has its own bound
      // (`mission_summary_timeout_ms`) and always degrades to the deterministic
      // summary instead of blocking or throwing the tick away.
      const summarizeResume = async (
        mission: Mission,
        run: ChildRun,
      ): Promise<{
        payload: Omit<ResumePayload, "resume" | "timeout_count">
        summarizer: "llm" | "fallback"
      }> => {
        const rows = run.transcriptRows ?? []
        let summarized: Awaited<ReturnType<typeof summarizeMissionAttempt>>
        try {
          summarized = await summarizeMissionAttempt(
            {
              transcript: renderMissionTranscript(rows),
              mission: { id: mission.id, title: mission.title },
              rows,
            },
            {
              client: client as any,
              directory: dir,
              timeoutMs: hbCfg.mission_summary_timeout_ms,
              // A plain bounded wait (not the stall window): activity may not
              // extend the summarizer's own budget.
              waitForIdle: (sid, ms) => waitForChildIdle(sid, { confirmMs: Math.max(1, ms) }),
              registerChild: (sid) => automationChildSessions.add(sid),
              onWarn: (msg, err) => void diag.warn(`[heartbeat-hook] ${msg}`, err),
            },
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          summarized = {
            summary: deterministicResumeSummary(rows, message),
            degraded: "summarizer-fallback",
            error: message,
            promptBytes: 0,
            wallMs: 0,
          }
        }
        return {
          payload: {
            prior_session: run.sessionId ?? "unknown",
            stopped_at: run.stoppedAt ?? new Date().toISOString(),
            aborted: run.aborted === true,
            summary: summarized.summary,
            ...(run.stalledForMs === undefined ? {} : { stalled_for_ms: run.stalledForMs }),
            ...(run.lastActivity === undefined ? {} : { last_activity: run.lastActivity }),
          },
          summarizer: summarized.degraded === "summarizer-fallback" ? "fallback" : "llm",
        }
      }
      const settleItem = async (laneRun: {
        item: WorkItem | null
        mission: Mission
        run: ChildRun
      }): Promise<boolean> => {
        if (!laneRun.item || laneRun.run.outcome !== "timeout") return false
        const run = laneRun.run
        // Past the resume ceiling the item drops: do not spend an LLM call on
        // a summary nobody will consume, and journal resume_abandoned.
        if (laneRun.item.requeue_count >= MAX_REQUEUES) {
          run.summarizer = null
          run.resumeAbandoned = true
          return false
        }
        const resume = await summarizeResume(laneRun.mission, run)
        run.summarizer = resume.summarizer
        const requeued = stallResumeItem(laneRun.item, resume.payload, Date.now())
        if (!requeued) {
          run.summarizer = null
          run.resumeAbandoned = true
          return false
        }
        run.resumeItem = requeued.id
        work = enqueueWork(work, [requeued])
        return true
      }
      const resultStatusOf = (r: ChildRun): MissionResult["status"] | "missing" =>
        r.result?.status ?? (r.outcome === "completed" ? "missing" : "error")
      const overBudgetOf = (tokens: number): boolean =>
        autonomy.mission_token_budget !== "unlimited" && tokens > autonomy.mission_token_budget
      const runEntry = (
        mission: Mission,
        lane: "primary" | "side",
        r: ChildRun,
        requeued: boolean,
      ): Record<string, unknown> => ({
        mission: mission.id,
        lane,
        outcome: r.outcome,
        token_cost: r.tokenCost,
        over_budget: overBudgetOf(r.tokenCost),
        session: r.sessionId,
        result_status: resultStatusOf(r),
        result_missing: !r.result,
        requeued,
        ...(r.aborted === undefined ? {} : { aborted: r.aborted }),
        ...(r.abortError === undefined ? {} : { abort_error: r.abortError }),
        ...(r.stopReason === undefined ? {} : { stop_reason: r.stopReason }),
        ...(r.stalledForMs === undefined ? {} : { stalled_for_ms: r.stalledForMs }),
        ...(r.lastActivity === undefined ? {} : { last_activity: r.lastActivity }),
        ...(r.orphanAborted === undefined
          ? {}
          : { orphan_abort: r.orphanAborted.length }),
        ...(r.orphanAbortError === undefined ? {} : { orphan_abort_error: r.orphanAbortError }),
        ...(r.outcome === "timeout" ? { timeout_stopped: true } : {}),
        ...(r.outcome === "timeout" && r.sessionId ? { prior_session: r.sessionId } : {}),
        ...(r.resumeItem === undefined ? {} : { resume_item: r.resumeItem }),
        ...(r.summarizer === undefined ? {} : { summarizer: r.summarizer }),
        ...(r.resumeAbandoned === undefined ? {} : { resume_abandoned: r.resumeAbandoned }),
        ...(r.tool
          ? {
              tool_status: r.tool.status,
              tool_session: r.tool.session,
              tool_outcome: r.tool.outcome,
              ...(r.tool.error ? { tool_error: r.tool.error } : {}),
            }
          : {}),
      })
      /** Legacy top-level drain-tool fields: whichever run carried the tool. */
      const toolFields = (tool: DrainToolResult | null | undefined): Record<string, unknown> =>
        tool
          ? {
              tool_status: tool.status,
              tool_session: tool.session,
              tool_outcome: tool.outcome,
              ...(tool.error ? { tool_error: tool.error } : {}),
            }
          : {}
      const sideFields = (laneRun: LaneRun, requeued: boolean): Record<string, unknown> => {
        const r = laneRun.run
        return {
          side_mission: laneRun.mission.id,
          side_outcome: r.outcome,
          side_token_cost: r.tokenCost,
          side_session: r.sessionId,
          side_result_status: resultStatusOf(r),
          side_requeued: requeued,
          ...(r.aborted === undefined ? {} : { side_aborted: r.aborted }),
          ...(r.abortError === undefined ? {} : { side_abort_error: r.abortError }),
          ...(r.orphanAborted === undefined
            ? {}
            : { side_orphan_abort: r.orphanAborted.length }),
          ...(r.orphanAbortError === undefined
            ? {}
            : { side_orphan_abort_error: r.orphanAbortError }),
        }
      }

      if (fairStaleness) {
        const sideRequeued = sideRun ? await settleItem(sideRun) : false
        await saveWorkQueueState(workQueueFile, work, scheduler)
        if (sideRun) {
          const sideResultStatus = resultStatusOf(sideRun.run)
          const sideDrainFailed =
            sideRun.run.tool?.outcome === "error" || sideRun.run.tool?.outcome === "dropped"
          const sideOk =
            sideRun.run.outcome === "completed" && sideResultStatus !== "error" && !sideDrainFailed
          if (!sideOk) {
            await moodFeed.apply("mission_failure")
            moodEvent = "mission_failure"
          }
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: sideRun.run.outcome,
            token_cost: sideRun.run.tokenCost,
            over_budget: overBudgetOf(sideRun.run.tokenCost),
            gate: "staleness",
            reason: "staleness",
            queues: queueDepth(work),
            runs: [runEntry(sideRun.mission, "side", sideRun.run, sideRequeued)],
            ...sideFields(sideRun, sideRequeued),
            ...toolFields(sideRun.run.tool),
          })
          await recordExecution()
        } else {
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: "silent",
            token_cost: 0,
            gate: "staleness",
            reason: "unrunnable",
            queues: queueDepth(work),
          })
          await recordNoop(digest.digest_hash)
        }
        return "fired"
      }

      const first = await selected(digest, verdict)
      if (!first) {
        // No primary mission this tick (JEV silence). The side lane may
        // still have done the tick's work — never book that as "silent".
        const sideRequeued = sideRun ? await settleItem(sideRun) : false
        await saveWorkQueueState(workQueueFile, work, scheduler)
        if (sideRun) {
          const sideResultStatus = resultStatusOf(sideRun.run)
          const sideDrainFailed =
            sideRun.run.tool?.outcome === "error" || sideRun.run.tool?.outcome === "dropped"
          const sideOk =
            sideRun.run.outcome === "completed" && sideResultStatus !== "error" && !sideDrainFailed
          if (!sideOk) {
            await moodFeed.apply("mission_failure")
            moodEvent = "mission_failure"
          }
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: sideRun.run.outcome,
            token_cost: sideRun.run.tokenCost,
            over_budget: overBudgetOf(sideRun.run.tokenCost),
            gate: "digest",
            reason,
            queues: queueDepth(work),
            runs: [runEntry(sideRun.mission, "side", sideRun.run, sideRequeued)],
            ...sideFields(sideRun, sideRequeued),
            ...toolFields(sideRun.run.tool),
            ...(digestError ? { error: digestError } : {}),
          })
          // Side work executed this tick: an executed mission resets the B7
          // backoff streak (§17.8 reset rule).
          await recordExecution()
        } else {
          await ledger({
            verdict: "no_reply",
            mission: null,
            outcome: "silent",
            token_cost: 0,
            gate: "digest",
            reason,
            queues: queueDepth(work),
            ...(digestError ? { error: digestError } : {}),
          })
          // Waiting side work must not be delayed by the identical-digest
          // backoff; a primary item the JEV keeps declining backs off
          // normally (its expiry re-offers it fresh).
          if (work.some((i) => i.kind === "staleness")) await recordExecution()
          else await recordNoop(digest.digest_hash)
        }
        return "fired"
      }

      let chosen = first
      let secondRun: { mission: Mission; run: ChildRun; item: WorkItem | null } | null = null
      let totalTokens = first.run.tokenCost + (sideRun?.run.tokenCost ?? 0)
      let reroll: { from: string; reason: string } | null = null
      const declined: string[] = []
      let finalReason = reason
      let finalDecision: "mission" | "no_reply" = "mission"
      let noReplyReason = "mission-declined"

      // A drain that failed at the pipe level must not be laundered into a
      // decline (which would reroll or silence the tick without a failure).
      const firstDrainFailed =
        first.run.tool?.outcome === "error" || first.run.tool?.outcome === "dropped"
      if (first.run.result?.status === "declined" && !firstDrainFailed) {
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
            secondRun = second
            chosen = second
            totalTokens += second.run.tokenCost
            const secondDrainFailed =
              second.run.tool?.outcome === "error" || second.run.tool?.outcome === "dropped"
            if (second.run.result?.status === "declined" && !secondDrainFailed) {
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

      // Settle every dispatched item: a timeout re-enqueues at the queue tail
      // with the reason recorded; completed/error/declined drop.
      const sideRequeued = sideRun ? await settleItem(sideRun) : false
      const firstRequeued = await settleItem(first)
      const secondRequeued = secondRun ? await settleItem(secondRun) : false
      await saveWorkQueueState(workQueueFile, work, scheduler)

      const run = chosen.run
      const finalMission = chosen.mission
      const finalResult = run.result
      // Legacy top-level drain-tool fields describe whichever run carried the
      // tool (drain rides the side lane today).
      const tickTool = sideRun?.run.tool ?? run.tool
      const outcome = run.outcome
      const tokenCost = totalTokens
      const overBudget = overBudgetOf(tokenCost)
      const runError = run.runError
      const resultStatus: MissionResult["status"] | "missing" =
        finalResult?.status ?? (outcome === "completed" ? "missing" : "error")
      const resultMissing = !finalResult
      // The drain tool reports pipe failures as `status: "completed"` with
      // `outcome: "error" | "dropped"`, so the mission result alone cannot be
      // trusted: the observed tool outcome is the authoritative signal.
      const drainFailed = tickTool?.outcome === "error" || tickTool?.outcome === "dropped"
      const toolFromSide = Boolean(sideRun?.run.tool)
      const toolOwnerResultStatus = toolFromSide ? resultStatusOf(sideRun!.run) : resultStatus
      const toolFailedButCompleted = drainFailed && toolOwnerResultStatus === "completed"
      const summary = drainFailed && tickTool?.summary ? tickTool.summary : run.summary
      const toolSkippedButCompleted =
        tickTool?.status === "skipped" && toolOwnerResultStatus === "completed"
      sessionId = run.sessionId

      const sideResultStatus = sideRun ? resultStatusOf(sideRun.run) : null
      const sideDrainFailed =
        sideRun?.run.tool?.outcome === "error" || sideRun?.run.tool?.outcome === "dropped"
      const sideOk =
        !sideRun ||
        (sideRun.run.outcome === "completed" && sideResultStatus !== "error" && !sideDrainFailed)
      const dispatchedRuns = [
        ...(sideRun ? [runEntry(sideRun.mission, "side", sideRun.run, sideRequeued)] : []),
        runEntry(first.mission, "primary", first.run, firstRequeued),
        ...(secondRun ? [runEntry(secondRun.mission, "primary", secondRun.run, secondRequeued)] : []),
      ]

      if (finalDecision === "no_reply") {
        await ledger({
          verdict: "no_reply",
          mission: null,
          outcome: sideRun ? sideRun.run.outcome : "silent",
          token_cost: tokenCost,
          over_budget: overBudget,
          gate: "digest",
          reason: noReplyReason,
          queues: queueDepth(work),
          runs: dispatchedRuns,
          ...(sideRun ? sideFields(sideRun, sideRequeued) : {}),
          ...(sessionId ? { session: sessionId } : {}),
          result_status: resultStatus,
          result_missing: resultMissing,
          ...toolFields(tickTool),
          ...(toolFailedButCompleted ? { tool_failed_but_completed: true } : {}),
          ...(reroll ? { reroll } : {}),
          ...(declined.length ? { declined } : {}),
          ...(runError ?? digestError ? { error: runError ?? digestError } : {}),
        })
        // A declined mission is not a mood failure; a broken side run is.
        if (!sideOk) {
          await moodFeed.apply("mission_failure")
          moodEvent = "mission_failure"
        }
        // Executed side work — or side work still waiting — resets the B7
        // backoff; a primary item the JEV keeps declining backs off normally.
        if (sideRun || work.some((i) => i.kind === "staleness")) await recordExecution()
        else await recordNoop(digest.digest_hash)
        return "fired"
      }

      const primaryToolFailed =
        run.tool?.outcome === "error" || run.tool?.outcome === "dropped"
      const missionOk =
        outcome === "completed" &&
        resultStatus !== "declined" &&
        resultStatus !== "error" &&
        !primaryToolFailed

      phase = "post"
      await setCurrent({ phase })
      if (!missionOk || !sideOk) {
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
        queues: queueDepth(work),
        runs: dispatchedRuns,
        ...(sideRun ? sideFields(sideRun, sideRequeued) : {}),
        ...(sessionId ? { session: sessionId } : {}),
        result_status: resultStatus,
        result_missing: resultMissing,
        ...toolFields(tickTool),
        ...(toolSkippedButCompleted ? { tool_skipped_but_completed: true } : {}),
        ...(toolFailedButCompleted ? { tool_failed_but_completed: true } : {}),
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
      // The ownership lease is the only release left (Phase 1).
      if (ownership) await ownership.release().catch(() => {})
      // Close the live marker: idle once the tick ends (success, error, or a
      // lock-held skip) — the UI never shows a stale in-flight state.
      await setCurrent({
        state: "idle",
        phase: null,
        mission: null,
        mission_title: null,
        session: null,
        side_mission: null,
        side_mission_title: null,
        side_session: null,
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
    // Background steps (dream, staleness, profile-update, soul-update) run in
    // this same loop, after the heartbeat released its lease. Each self-gates.
    try {
      await runSteps(undefined, (kind, err) =>
        void diag.error(`[heartbeat-hook] step ${kind} failed:`, err),
      )
    } catch (err) {
      void diag.error("[heartbeat-hook] step run failed:", err)
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
      const properties = (event as any).properties ?? {}
      if (event.type === "session.idle") {
        const sid = properties.sessionID
        if (sid) {
          settledSessions.add(sid)
          childIdleResolvers.get(sid)?.()
        }
        return
      }
      if (event.type === "session.created") {
        // `parentID` is what makes descendant liveness bubble up (§5.2) and
        // what lets an abort cascade to background task children (P3a-f2).
        const info = properties.info ?? {}
        if (typeof info.id === "string" && typeof info.parentID === "string") {
          childParent.set(info.id, info.parentID)
        }
        if (typeof info.id === "string") {
          settledSessions.delete(info.id)
          touchActivity(info.id, "session")
        }
        return
      }
      if (event.type === "message.part.updated") {
        const part = properties.part ?? {}
        const sid = part.sessionID
        if (typeof sid !== "string") return
        if (part.type === "tool") {
          const tool = typeof part.tool === "string" ? part.tool : "tool"
          const callID = String(part.callID ?? part.id ?? tool)
          const status = part.state?.status
          if (SHELL_TOOLS.has(tool)) {
            setOpenShell(sid, callID, status === "running" || status === "pending")
          }
          touchActivity(sid, tool === "task" ? `task:${taskAgentName(part)}` : `tool:${tool}`)
        } else {
          touchActivity(sid, part.type === "text" ? "text" : String(part.type ?? "part"))
        }
        return
      }
      if (event.type === "message.updated") {
        const info = properties.info ?? {}
        if (typeof info.sessionID === "string") touchActivity(info.sessionID, "model")
        return
      }
      if (event.type === "session.updated") {
        const info = properties.info ?? {}
        if (typeof info.id === "string") touchActivity(info.id, "session")
        return
      }
      const sid = properties.sessionID ?? properties.info?.sessionID ?? properties.info?.id
      if (typeof sid === "string") touchActivity(sid, "event")
    },
  }
}) satisfies Plugin
