// Work-kind handler contract (Phase 0 of the user-task plan).
//
// The heartbeat owns policy only: tick timing, the producer pool, pruning,
// the SWRR pick, dequeue, queue persistence, and shared outcome accounting.
// Every work kind owns its own intent and execution in a module under
// `work-kinds/`, and the heartbeat dispatches through a registry.
//
// Handlers never mutate the queue. A timeout/retry returns a `requeue` item
// and the heartbeat applies it, so there is still exactly one queue writer.
//
// Loaded via relative import only.
import type { AutonomyConfig } from "../autonomy.ts"
import type { Diagnostics } from "../logging.ts"
import type { HeartbeatDigest, HeartbeatError, HeartbeatPhase, HeartbeatSignals } from "../heartbeat.ts"
import type { IdeaConfig } from "../idea.ts"
import type { Mission } from "../missions.ts"
import type { MissionResult } from "../mission-result.ts"
import type { MoodState } from "../mood.ts"
import type { SleepPrompts } from "../sleep-prompts.ts"
import type { ResumePayload } from "../mission-resume.ts"
import type { DrainStepResult } from "../drain/step.ts"
import type { ProducerCtx } from "./shared.ts"
import type { WorkItem, WorkKind } from "../work-queue.ts"

export type ChildOutcome = "completed" | "timeout" | "error"

/** One child session's outcome, shared by every handler that dispatches. */
export type ChildRun = {
  outcome: ChildOutcome
  tokenCost: number
  summary: string
  runError?: HeartbeatError
  sessionId: string | null
  result: MissionResult | null
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

export type ResumeSummary = {
  payload: Omit<ResumePayload, "resume" | "timeout_count">
  summarizer: "llm" | "fallback"
}

/** Per-tick state plus the services a handler may use. Built once per tick. */
export type DispatchContext = {
  tick: number
  nowMs: number
  level: number
  quiet: boolean
  signals: HeartbeatSignals
  digest: HeartbeatDigest
  missions: Mission[]
  autonomy: AutonomyConfig
  ideaCfg: IdeaConfig
  /** Externalized `[sleepState]` directives (loaded once per tick). */
  sleepPrompts: SleepPrompts
  dir: string
  stateDir: string
  logDir: string
  vaultDir: string
  diag: Diagnostics
  /** Update the live marker AND the tick's error phase. */
  setPhase(phase: HeartbeatPhase): Promise<void>
  runChild(args: { mission: Mission; prompt: string; agent: string }): Promise<ChildRun>
  runDrain(): Promise<DrainStepResult>
  summarizeResume(mission: Mission, run: ChildRun): Promise<ResumeSummary>
  /** Record the mission attempt before dispatch (`min-gap:` + no-repeat). */
  recordDispatch(missionId: string): Promise<void>
  /** Shared mood feed: dreams apply their tone delta inside the handler so the
   *  bucket metadata carries the real before/after snapshot. */
  applyMood(event: string): Promise<void>
  viewMood(): MoodState
  /** Count one dispatched dream toward `nightly_dream_cap`. */
  bumpDreamsTonight(): Promise<void>
  /** Explicit opencode DB path (tests/E2E); defaults to the data dir. */
  dbFile?: string
  idea: {
    storeGenerated(summary: string, cfg: IdeaConfig): Promise<string>
    recordGenerated(): Promise<void>
    recordExpressed(): Promise<void>
  }
}

/** What a handler tells the heartbeat to record after dispatch. */
export type DispatchResult = {
  /** Ledger fields; the heartbeat adds `queues`, drain health, and timing. */
  ledger: Record<string, unknown>
  /** true → reset the B7 no-op streak; false → extend it. */
  executed: boolean
  /** Timeout/resume item to put back on the queue (handler never writes it). */
  requeue?: WorkItem | null
  /** Optional mood event (e.g. `mission_failure`). */
  mood?: string
  /** Optional backlog record; the heartbeat applies it when backlog is enabled. */
  backlog?: {
    title: string
    detail: string
    failed: boolean
    summary: string
    token_cost: number
  }
  session_id?: string | null
}

export type WorkKindHandler = {
  kind: WorkKind
  /** Producer-side intent; a kind with no producer emits nothing. */
  produce?(ctx: ProducerCtx): WorkItem[] | Promise<WorkItem[]>
  /** Dequeue-time re-check; absent → always runnable. */
  runnable?(ctx: ProducerCtx, item: WorkItem): boolean
  /** Prune-time "is this work still needed"; absent → always. */
  stillDue?(ctx: ProducerCtx, item: WorkItem): boolean
  run(ctx: DispatchContext, item: WorkItem): Promise<DispatchResult>
}
