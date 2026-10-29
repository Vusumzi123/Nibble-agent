// Wire types for the v2 dashboard backend (Dashboard/server). Shapes follow
// the live Kael harness: unified work queue, real session cost from opencode.db,
// gate/decision ledgers, and the full sysop-config schema.

export interface Health {
  ok: boolean;
  directory: string;
  serve_url: string | null;
  serve_ok: boolean | null;
  auth: string;
  version: string;
  paths: Record<string, string>;
  writable_sections: string[];
  uptime_ms?: number;
  now?: string;
}

export interface HeartbeatCurrent {
  state: string;
  tick: number | null;
  phase: string | null;
  mission: string | null;
  mission_title: string | null;
  session: string | null;
  side_mission: string | null;
  side_mission_title: string | null;
  side_session: string | null;
  started_at: string | null;
  updated_at: string | null;
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

export interface Heartbeat {
  ts: string;
  current: HeartbeatCurrent | null;
  lock: boolean;
  lock_stale: boolean;
  schedule: HeartbeatSchedule;
  counters: { ticks: number; noop_streak: number; last_mission: string | null };
}

export interface Mood {
  valence: number | null;
  arousal: number | null;
  label: string;
  baseline?: { valence: number; arousal: number } | null;
  since: string | null;
  age_ms: number | null;
}

export interface Sleep {
  status: string;
  since: string | null;
  woken_at: string | null;
  dreams_tonight: number;
  last_tick: number | null;
  window: string;
  quiet: boolean;
  available: boolean;
}

export interface Idea {
  dayKey: string | null;
  dailyTarget: number;
  generatedToday: number;
  lastExpressedAt: string | null;
}

export type WorkKind =
  | 'mission'
  | 'drain-pass'
  | 'quiet-hours'
  | 'staleness'
  | 'profile-update'
  | 'soul-update'
  | string;

export interface WorkItem {
  id: string;
  kind: WorkKind;
  mission: string | null;
  title: string;
  producer: string;
  priority: number;
  enqueued_ms: number | null;
  age_ms: number | null;
  not_before_ms: number | null;
  due: boolean;
  expires_ms: number | null;
  ttl_ms: number | null;
  requeue_count: number;
  requeue_reason: string | null;
  payload: Record<string, unknown> | null;
}

export interface DrainPass {
  ts: string;
  wall_ms: number | null;
  tokens: number;
  cost: number;
  sessions: number;
  items: number;
  outcome: string;
}

export interface Drain {
  ts: string;
  enabled: boolean;
  consumer: boolean;
  state: string;
  trigger: string | null;
  pass: number;
  pending: number;
  pending_sessions: number;
  pending_messages?: number;
  marked_sessions?: number;
  pending_definition?: string;
  oldest_pending_age_ms: number | null;
  next_due: number | null;
  trigger_pending: number;
  trigger_max_age_hours: number;
  watermark_ts: number | null;
  cursor_present?: boolean;
  cursor_version: number | null;
  last_pass: DrainPass | null;
  recent: DrainPass[];
  series: Array<{ ts: string; pending: number | null; outcome: string }>;
  available: boolean;
}

export interface SchedulerSnapshot {
  fair: boolean;
  weights: Record<string, number>;
  credits: Record<string, number>;
  served: Record<string, number>;
  last_kind: WorkKind | null;
  next_kind: WorkKind | null;
  runnable: WorkKind[];
  max_gap: Record<string, number>;
  total_weight: number;
  updated_ms: number | null;
  available: boolean;
}

export interface Queues {
  ts: string;
  items: WorkItem[];
  counts: Record<string, number>;
  total: number;
  due: number;
  oldest_ms: number;
  running: HeartbeatCurrent | null;
  drain: Drain;
  scheduler: SchedulerSnapshot | null;
  available: boolean;
}

export interface RunRow {
  ts: string;
  ts_ms: number | null;
  tick: number | null;
  mission: string | null;
  mission_title: string | null;
  kind: string;
  lane: string;
  outcome: string | null;
  token_cost: number | null;
  over_budget: boolean;
  cost: number | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_total: number | null;
  duration_ms: number | null;
  started_ms: number | null;
  finished_ms: number | null;
  result_status: string | null;
  result_missing: boolean;
  requeued: boolean;
  session: string | null;
  aborted: boolean;
  stop_reason: string | null;
  stalled_for_ms: number | null;
  error: string | null;
  trigger?: string | null;
  pending_before?: number | null;
  pending_after?: number | null;
  batch_sessions?: number | null;
  batch_items?: number | null;
}

export interface RunsSnapshot {
  ts: string;
  runs: RunRow[];
  total: number;
  available: boolean;
  hours: number;
}

export interface TokenPoint {
  bucket: string;
  tokens: number;
  cost: number;
  runs: number;
  over_runs: number;
}

export interface TokenSeries {
  ts: string;
  bucket: string;
  budget_per_run: number | null;
  unlimited: boolean;
  points: TokenPoint[];
  totals: { tokens: number; cost: number; runs: number; over_runs: number };
  available: boolean;
}

export interface ModelSpend {
  model: string;
  modelInfo?: unknown;
  sessions: number;
  cost: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  share: number;
}

export interface CostReport {
  ts: string;
  hours: number;
  total: number;
  today: number;
  sessions: number;
  models: ModelSpend[];
  days: Array<{ day: string; sessions: number; cost: number; tokens: number }>;
  missions: Array<{ mission: string; runs: number; tokens: number; cost: number; costed_runs: number }>;
  avg_per_run: number | null;
  run_cost_total: number;
  available: boolean;
}

export interface ErrorReport {
  ts: string;
  hours: number;
  runs: {
    total: number;
    errors: number;
    rate: number;
    by_outcome: Record<string, number>;
    recent: Array<{ ts: string; mission: string | null; outcome: string | null; stop_reason: string | null; session: string | null }>;
  };
  gates: { total: number; by_verdict: Record<string, number>; by_class: Record<string, number> };
  audit: { total: number; failures: number; recent: Array<Record<string, unknown>> };
  retrieval: { total: number; errors: number };
  drain: { total: number; errors: number };
  series: Array<{ bucket: string; total: number; errors: number }>;
  available: boolean;
}

export interface ThroughputPoint {
  bucket: string;
  runs: number;
  tokens: number;
  cost: number;
  p50: number | null;
  p95: number | null;
}

export interface Throughput {
  ts: string;
  hours: number;
  points: ThroughputPoint[];
  totals: { runs: number; tokens: number; cost: number; ticks: number; p50_ms: number | null; p95_ms: number | null };
  available: boolean;
}

export interface QueueWait {
  ts: string;
  total: number;
  oldest_ms: number;
  p50_ms: number | null;
  p95_ms: number | null;
  due: number;
  by_kind: Array<{ kind: string; count: number; oldest_ms: number }>;
  historical: boolean;
  note: string;
}

export interface ActivityEvent {
  ts: string;
  ts_ms: number;
  type: string;
  title: string;
  detail: string;
  tone: string;
}

export interface Activity {
  ts: string;
  hours: number;
  events: ActivityEvent[];
  available: boolean;
}

export interface Mission {
  id: string;
  title: string;
  frequency: string;
  menus: string[];
  base_menus: string[];
  min_level: number;
  approval: string;
  candidacy: string;
  agent: string;
  enabled: boolean;
  file_enabled: boolean;
  file_min_level: number;
  file_frequency: string;
  overlay: Record<string, unknown> | null;
  overlay_rejects: string[];
}

export interface SettingField {
  path: string;
  key: string;
  label: string;
  type: 'bool' | 'int' | 'float' | 'string' | 'enum' | 'duration' | 'budget' | 'list';
  value: unknown;
  default: unknown;
  set: boolean;
  options: string[] | null;
  min: number | null;
  max: number | null;
  allowOff: boolean;
  help: string;
  readOnly: boolean;
  restart: boolean;
}

export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  writable: boolean;
  restart: boolean;
  fields: SettingField[];
}

export interface SettingsSnapshot {
  file: string;
  sections: SettingsSection[];
}

export interface SettingsResult {
  ok: boolean;
  applied: Array<{ path: string; value: unknown }>;
  settings: SettingsSnapshot;
}

export interface Overview {
  now: number;
  health: Health;
  heartbeat: Heartbeat;
  mood: Mood;
  sleep: Sleep;
  idea: Idea;
  queue: {
    total: number;
    due: number;
    oldest_ms: number;
    counts: Record<string, number>;
    running: HeartbeatCurrent | null;
    next: WorkItem[];
  };
  drain: Drain;
  backlog: { total: number; open: number; counts: Record<string, number> };
  missions: { total: number; enabled: number; ids: Array<{ id: string; enabled: boolean; level: number; frequency: string }> };
  cost: { total_24h: number; today: number; avg_per_run: number | null; top_model: ModelSpend | null };
  errors: { rate: number; errors: number; total: number; gates: Record<string, number>; audit_failures: number };
  last_run: RunRow | null;
  budget_per_run: number | null;
  last_tokens: number | null;
  quiet: boolean;
  locks: LockInfo[];
}

export interface LockInfo {
  name: string;
  present: boolean;
  bytes: number;
  age_ms: number | null;
  content: string;
}

export interface BacklogEntry {
  id: string;
  created?: string;
  updated?: string;
  source?: string;
  kind?: string;
  payload?: { title?: string; detail?: string };
  status?: string;
  level_required?: number;
  result?: { ok?: boolean; summary?: string; token_cost?: number; ts?: string } | null;
  [key: string]: unknown;
}

export interface Backlog {
  total: number;
  open: number;
  counts: Record<string, number>;
  entries: BacklogEntry[];
}

export interface LedgerInfo {
  name: string;
  bytes: number;
  lines: number;
  mtime: number;
}

export interface TranscriptEntry {
  id: string;
  role: string;
  kind: 'text' | 'thought' | 'tool';
  label: string;
  body: string;
  ts: number | null;
  status?: string;
}

export interface MessageRow {
  info?: { id?: string; role?: string; time?: { created?: number } };
  parts?: Array<{
    type?: string;
    text?: string;
    tool?: string;
    state?: { status?: string; title?: string; input?: unknown; output?: unknown };
  }>;
}
