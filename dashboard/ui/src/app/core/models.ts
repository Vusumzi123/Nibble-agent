// Wire types for the Nibble dashboard backend (cards 8/9/16). Kept loose where
// the harness may add fields — the UI renders what is present and degrades on
// what is not.

export interface Health {
  ok: boolean;
  directory: string;
  serve_url: string;
  writable_sections: string[];
  auth: string;
}

export interface AutonomyConfig {
  level: number;
  gate_mode: 'shadow' | 'gate';
  gate_scope: 'main' | 'all';
  heartbeat: { frequency: string; in_progress_lock: boolean };
  mission_token_budget: number | 'unlimited';
  [key: string]: unknown;
}

export interface HeartbeatConfig {
  enabled: boolean;
  long_silence_factor: number;
  log: string;
  log_rotate_bytes: number;
  log_keep_generations: number;
  log_retention_days: number;
  log_compress: boolean;
  log_compress_after: number;
  log_compress_level: number;
  log_rotate_by: string;
  /** Mission lock / timeout / resume dials (plan §4.1). */
  mission_timeout_minutes: number;
  mission_lock_stale_ms: number;
  mission_lock_refresh_ms: number;
  mission_summary_timeout_ms: number;
  mission_max_resumes: number;
}

export interface DrainConfig {
  enabled: boolean;
  consumer: boolean;
  trigger_pending: number;
  trigger_max_age_hours: number;
  settle_seconds: number;
  poll_seconds: number;
  [key: string]: unknown;
}

export interface ConfigSnapshot {
  autonomy: AutonomyConfig;
  heartbeat: HeartbeatConfig;
  mood: Record<string, unknown>;
  comms: Record<string, unknown>;
  dashboard: Record<string, unknown>;
  /** Absent on backends older than the drain-trigger panel. */
  drain?: DrainConfig;
}

export type HeartbeatState = 'idle' | 'in-flight';
export type HeartbeatPhase = 'pre-gate' | 'digest' | 'dispatch' | 'mission' | 'post';

export interface HeartbeatCurrent {
  state: HeartbeatState;
  tick: number | null;
  phase: HeartbeatPhase | null;
  mission: string | null;
  mission_title: string | null;
  session: string | null;
  started_at: string | null;
  updated_at: string;
  level: number | null;
}

export interface HeartbeatSchedule {
  enabled: boolean;
  level: number;
  frequency: string;
  base_interval_ms: number | null;
  interval_ms: number | null;
  noop_streak: number;
  last_tick: string | null;
  next_tick: string | null;
  remaining_ms: number | null;
  due: boolean;
  paused: boolean;
  off: boolean;
}

export interface HeartbeatSnapshot {
  ts: string;
  current: HeartbeatCurrent | null;
  lock: boolean;
  lock_stale: boolean;
  /** Projected schedule; absent on backends older than the next-tick widget. */
  schedule?: HeartbeatSchedule;
}

export interface LedgerInfo {
  name: string;
  bytes: number;
  lines: number;
}

export interface MoodState {
  valence: number;
  arousal: number;
  [key: string]: unknown;
}

export interface Metrics {
  ts: string;
  config: ConfigSnapshot;
  mood: (MoodState & { file: string }) | null;
  backlog: { total: number; by_status: Record<string, number> } | null;
  ledgers: LedgerInfo[];
  heartbeat: { lock: boolean; lock_stale: boolean };
}

// Drain backlog: eligible text parts newer than the consolidation cursor.
// `pending_turns` is null when the opencode database could not be read.
export interface MemoryPending {
  ts: string;
  enabled: boolean;
  provider: 'both' | 'rag-brain' | 'memory-explorer' | 'none';
  writer: boolean;
  paused: boolean;
  pending_turns: number | null;
  cursor_last_ts: number | null;
  cursor_updated_at: string | null;
  seeded: boolean;
  // Consumer-loop dials (drain-consumer-plan §6.1).
  consumer?: boolean;
  trigger_pending?: number;
  trigger_max_age_hours?: number;
  next_due?: number | null;
  oldest_pending_age_ms?: number | null;
  available: boolean;
  error?: string;
}

// Drain consumer loop (`state/drain.current.json` + the last drain.log lines).
export interface DrainSnapshot {
  ts: string;
  enabled: boolean;
  consumer: boolean;
  state: 'idle' | 'running' | 'unknown';
  trigger: string | null;
  pass: number;
  pending: number | null;
  oldest_pending_age_ms: number | null;
  trigger_pending: number;
  trigger_max_age_hours: number;
  next_due: number | null;
  wake: { passes: number; wake_tokens: number; wall_ms: number; stopped: string | null } | null;
  last_pass: {
    ts: string;
    wall_ms: number;
    tokens: number;
    sessions: number;
    items: number;
    outcome: string;
  } | null;
  available: boolean;
  error?: string;
}

export interface HeartbeatError {
  phase: HeartbeatPhase | string;
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
}

// One line of logs/heartbeat.log (the per-tick NDJSON ledger).
export interface HeartbeatTick {
  ts: string;
  event?: string;
  tick?: number | null;
  digest_hash?: string;
  level?: number;
  quiet?: boolean;
  candidates?: string[];
  bias?: { mood: number; dispatch_influence: boolean };
  verdict?: string | null;
  mission?: string | null;
  outcome?: string;
  token_cost?: number;
  duration_ms?: number;
  /** Mission child session that produced the tick. */
  session?: string | null;
  /** Writer/tool session (drain_run); preferred for the transcript drawer. */
  tool_session?: string | null;
  result_status?: 'completed' | 'declined' | 'error' | 'missing';
  result_missing?: boolean;
  tool_status?: 'completed' | 'skipped';
  tool_skipped_but_completed?: boolean;
  reroll?: { from?: string; reason?: string } | null;
  declined?: string[];
  mood_event?: string | null;
  gate?: string;
  reason?: string;
  idea?: string;
  error?: HeartbeatError;
  [key: string]: unknown;
}

export interface BacklogEntry {
  id: string;
  source?: string;
  kind?: string;
  payload?: { title?: string; detail?: string };
  status?: string;
  result?: { ok?: boolean; summary?: string; token_cost?: number; ts?: string } | null;
  [key: string]: unknown;
}

export interface BacklogSnapshot {
  total: number;
  entries: BacklogEntry[];
}

export interface WriteResult {
  section: string;
  applied: Record<string, unknown>;
}

// Missions widget (backend card 8 extension). The mission list is the
// filesystem (`.opencode/missions/*.md`); the restrict-only overlay
// `autonomy.missions.<id>.*` can disable a mission but never re-enable one the
// file itself disables.
export interface MissionOverlay {
  enabled?: boolean;
  min_level?: number;
  frequency?: string;
  menus?: string[];
  [key: string]: unknown;
}

export interface MissionView {
  id: string;
  title: string;
  frequency: string;
  menus: string[];
  min_level: number;
  approval: string;
  candidacy: string;
  agent: string;
  /** Effective enabled state after the overlay. */
  enabled: boolean;
  /** The mission file's own `enabled` — false means the overlay cannot turn it on. */
  file_enabled: boolean;
  overlay: MissionOverlay | null;
}

export interface MissionsSnapshot {
  missions: MissionView[];
}

export interface MissionToggleResult {
  id: string;
  enabled: boolean;
}

// Lane queues (`state/lanes.json`) — queue-monitoring plan.
// `drain` appears in runs/tokens only — the consumer loop left the queues
// (drain-consumer-plan §6.1).
export type LaneName = 'primary' | 'side' | 'drain';

export interface QueueItemView {
  id: string;
  title: string | null;
  kind: string;
  lane: LaneName;
  producer: string;
  enqueued_ms: number | null;
  age_ms: number | null;
  expires_ms: number | null;
  ttl_ms: number | null;
  requeue_count: number;
  requeue_reason: string | null;
}

export interface QueuesSnapshot {
  ts: string;
  primary: QueueItemView[];
  side: QueueItemView[];
  running: {
    mission: string | null;
    mission_title: string | null;
    side_mission: string | null;
    side_mission_title: string | null;
  };
  // Drain consumer pointer (drain-consumer-plan §6.1): the loop's live
  // state beside the lanes — absent on older backends.
  drain?: {
    consumer: boolean;
    state: 'idle' | 'running' | 'unknown';
    pending: number | null;
    next_due: number | null;
  } | null;
  available: boolean;
  error?: string;
}

// One child run flattened from `logs/heartbeat.log` (`runs[]`, legacy fallback).
export interface RunRow {
  ts: string;
  tick: number | null;
  mission: string | null;
  mission_title: string | null;
  lane: LaneName;
  outcome: string | null;
  token_cost: number | null;
  over_budget: boolean;
  result_status: string | null;
  result_missing: boolean;
  requeued: boolean;
  session: string | null;
  tool_session: string | null;
  tool_outcome: string | null;
  duration_ms: number | null;
}

export interface RunsSnapshot {
  ts: string;
  runs: RunRow[];
  available: boolean;
  error?: string;
}

export type TokenBucket = 'tick' | 'hour' | 'day';

export interface TokenPoint {
  bucket: string;
  tokens: number;
  runs: number;
  over_runs: number;
  tick?: number;
}

export interface TokenSeries {
  ts: string;
  bucket: TokenBucket;
  budget_per_run: number | null;
  points: TokenPoint[];
  totals: { tokens: number; runs: number; over_runs: number };
  available: boolean;
  error?: string;
}

// opencode serve shapes (proxied through /api/serve) — structurally loose.
export interface SessionInfo {
  id: string;
  title?: string;
  time?: { created?: number; updated?: number };
  parentID?: string | null;
  [key: string]: unknown;
}

export interface MessageInfo {
  id?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  [key: string]: unknown;
}

export interface MessagePart {
  type?: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string;
  callID?: string;
  state?: { status?: string; title?: string; input?: unknown; output?: unknown; error?: unknown };
  [key: string]: unknown;
}

export interface MessageRow {
  info?: MessageInfo;
  parts?: MessagePart[];
  [key: string]: unknown;
}
