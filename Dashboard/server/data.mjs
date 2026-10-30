// Read-only data layer over the live agent harness: state files, NDJSON logs,
// and the opencode SQLite database (cost / model / timestamps).
//
// Every function degrades to null/empty when a source is missing. Nothing here
// writes except the explicit settings/mission helpers in settings.mjs.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { readConfig, readMissions, getPath } from './settings.mjs';

const WORK_PRIORITY = {
  mission: 0,
  'drain-pass': 1,
  'quiet-hours': 2,
  staleness: 3,
  'profile-update': 4,
  'soul-update': 5,
};

const KIND_ORDER = ['mission', 'drain-pass', 'quiet-hours', 'staleness', 'profile-update', 'soul-update'];
const DEFAULT_WEIGHTS = {
  mission: 4,
  'drain-pass': 3,
  'quiet-hours': 1,
  staleness: 1,
  'profile-update': 1,
  'soul-update': 1,
};

function schedulerSnapshot(raw, items, now) {
  if (!raw || Array.isArray(raw) || !raw.scheduler) return null;
  const source = raw.scheduler;
  const weights = { ...DEFAULT_WEIGHTS };
  for (const kind of KIND_ORDER) {
    const value = source.weights?.[kind];
    if (Number.isInteger(value) && value >= 0) weights[kind] = value;
  }
  const credits = {};
  const served = {};
  for (const kind of KIND_ORDER) {
    const c = source.credits?.[kind];
    if (Number.isFinite(c)) credits[kind] = c;
    const s = source.served?.[kind];
    if (Number.isFinite(s) && s >= 0) served[kind] = s;
  }
  const runnable = KIND_ORDER.filter(
    (kind) => weights[kind] > 0 && items.some((item) => item.kind === kind && item.due),
  );
  const totalWeight = runnable.reduce((sum, kind) => sum + weights[kind], 0);
  const next = { ...credits };
  for (const kind of runnable) next[kind] = (next[kind] ?? 0) + weights[kind];
  let nextKind = null;
  for (const kind of runnable) {
    if (nextKind === null || next[kind] > next[nextKind]) nextKind = kind;
  }
  const maxGap = {};
  for (const kind of runnable) maxGap[kind] = Math.ceil(totalWeight / weights[kind]);
  return {
    fair: source.fair !== false,
    weights,
    credits,
    served,
    last_kind: KIND_ORDER.includes(source.last_kind) ? source.last_kind : null,
    next_kind: nextKind,
    runnable,
    max_gap: maxGap,
    total_weight: totalWeight,
    updated_ms: Number.isFinite(source.updated_ms) ? source.updated_ms : null,
    available: true,
  };
}

const DEFAULT_PATHS = {
  vault: 'Brain',
  diagrams: 'diagrams',
  log: '.opencode/logs',
  state: '.opencode/state',
};

/* ------------------------------------------------------------------ helpers */

export function expandHome(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export function resolveLeaf(root, value) {
  const v = expandHome(value);
  if (!v) return root;
  return isAbsolute(v) ? v : resolve(root, v);
}

export function loadPaths(dir) {
  const { data } = readConfig(dir);
  const p = data?.paths ?? {};
  return {
    vault: resolveLeaf(dir, p.vault ?? DEFAULT_PATHS.vault),
    diagrams: resolveLeaf(dir, p.diagrams ?? DEFAULT_PATHS.diagrams),
    logs: resolveLeaf(dir, p.log ?? DEFAULT_PATHS.log),
    state: resolveLeaf(dir, p.state ?? DEFAULT_PATHS.state),
  };
}

export function safeJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function safeText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function lines(file, limit = 500) {
  const text = safeText(file);
  if (!text) return [];
  const all = text.split('\n').filter((line) => line.trim() !== '');
  return limit > 0 ? all.slice(-limit) : all;
}

export function parseLines(file, limit = 500) {
  return lines(file, limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    })
    .filter((row) => row && typeof row === 'object');
}

export function fileInfo(file) {
  try {
    const st = statSync(file);
    let lineCount = 0;
    try {
      const buf = readFileSync(file);
      for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) lineCount += 1;
      if (buf.length && buf[buf.length - 1] !== 10) lineCount += 1;
    } catch { /* unreadable */ }
    return { name: file.split('/').pop(), bytes: st.size, lines: lineCount, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export function parseDuration(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d+)([mh])$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000);
}

export function parseTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

export function parseModel(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* plain string */ }
  return { id: String(raw), providerID: null };
}

export function modelLabel(model) {
  if (!model) return null;
  if (typeof model === 'string') return model;
  const provider = model.providerID ?? model.provider ?? '';
  const id = model.id ?? model.modelID ?? '';
  const variant = model.variant && model.variant !== 'default' ? `#${model.variant}` : '';
  return provider ? `${provider}/${id}${variant}` : `${id}${variant}` || null;
}

export function pct(part, total) {
  return total ? (part / total) * 100 : 0;
}

export function percentile(values, p) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

function quietNow(window, now) {
  const m = typeof window === 'string' ? window.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/) : null;
  if (!m) return false;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

/* ---------------------------------------------------------------------- DB */

let dbCache = null;
let dbChecked = false;

function openDb() {
  if (dbChecked) return dbCache;
  dbChecked = true;
  const file = process.env['DASHBOARD_DB'] || join(homedir(), '.local/share/opencode/opencode.db');
  try {
    if (!existsSync(file)) return null;
    dbCache = new DatabaseSync(file, { readOnly: true });
  } catch {
    dbCache = null;
  }
  return dbCache;
}

function query(sql, params = []) {
  const db = openDb();
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function sessionColumns() {
  return `id, parent_id AS parentID, title, agent, model, cost,
          tokens_input AS tokensIn, tokens_output AS tokensOut,
          tokens_reasoning AS tokensReasoning,
          tokens_cache_read AS cacheRead, tokens_cache_write AS cacheWrite,
          time_created AS created, time_updated AS updated`;
}

export function sessionsSince(dir, sinceMs, limit = 500) {
  return query(
    `select ${sessionColumns()} from session
     where directory = ? and time_created >= ?
     order by time_created desc limit ?`,
    [dir, sinceMs, limit],
  ).map((row) => ({ ...row, modelInfo: parseModel(row.model), modelLabel: modelLabel(parseModel(row.model)) }));
}

export function sessionsByIds(dir, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => '?').join(',');
  const rows = query(
    `select ${sessionColumns()} from session where directory = ? and id in (${placeholders})`,
    [dir, ...unique],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { ...row, modelInfo: parseModel(row.model), modelLabel: modelLabel(parseModel(row.model)) },
    ]),
  );
}

export function sessionAggregate(dir, sinceMs) {
  const rows = query(
    `select model, count(*) as sessions, sum(cost) as cost,
            sum(tokens_input) as tokensIn, sum(tokens_output) as tokensOut,
            sum(tokens_input + tokens_output + tokens_reasoning) as tokens
     from session where directory = ? and time_created >= ?
     group by model order by cost desc`,
    [dir, sinceMs],
  );
  const merged = new Map();
  for (const row of rows) {
    const model = modelLabel(parseModel(row.model)) ?? 'unknown';
    const entry = merged.get(model) ?? {
      model,
      modelInfo: parseModel(row.model),
      sessions: 0,
      cost: 0,
      tokens: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    entry.sessions += row.sessions;
    entry.cost += row.cost ?? 0;
    entry.tokens += row.tokens ?? 0;
    entry.tokensIn += row.tokensIn ?? 0;
    entry.tokensOut += row.tokensOut ?? 0;
    merged.set(model, entry);
  }
  return [...merged.values()].sort((a, b) => b.cost - a.cost);
}

export function dayAggregate(dir, sinceMs) {
  const rows = query(
    `select strftime('%Y-%m-%d', time_created/1000, 'unixepoch', 'localtime') as day,
            count(*) as sessions, sum(cost) as cost,
            sum(tokens_input + tokens_output + tokens_reasoning) as tokens
     from session where directory = ? and time_created >= ?
     group by day order by day`,
    [dir, sinceMs],
  );
  return rows.map((row) => ({ day: row.day, sessions: row.sessions, cost: row.cost ?? 0, tokens: row.tokens ?? 0 }));
}

export function pendingTurns(dir, watermark, excludeMissions = [], cursor = null) {
  // Mirror lib/drain/db.ts `unconsumedCount`: top-level sessions only, exact
  // automation titles, text parts only, and per-session cursor marks.
  const valid = cursor && (cursor.version === 2 || cursor.version === 3);
  const watermarkTs =
    valid && Number.isFinite(cursor.watermark_ts)
      ? cursor.watermark_ts
      : Number.isFinite(watermark)
        ? watermark
        : 0;
  const marks = {};
  if (valid && cursor.sessions && typeof cursor.sessions === 'object') {
    for (const [sid, mark] of Object.entries(cursor.sessions)) {
      if (mark && Number.isFinite(mark.last_ts)) marks[sid] = mark.last_ts;
    }
  }
  const titles = [
    'drain-summarize',
    'knowledge-consolidate',
    ...excludeMissions.flatMap((id) => [`heartbeat:${id}`, `dream:${id}`]),
  ];
  const placeholders = titles.map(() => '?').join(',');
  const rows = query(
    `WITH marks AS (
       SELECT key AS sid, CAST(value AS INTEGER) AS ts FROM json_each(?)
     )
     SELECT count(*) AS turns, count(distinct m.session_id) AS sessions,
            count(distinct m.id) AS messages,
            min(m.time_created) AS oldest, max(m.time_created) AS newest
     FROM message m
     JOIN part p ON p.message_id = m.id
     JOIN session s ON s.id = m.session_id
     LEFT JOIN marks mk ON mk.sid = s.id
     WHERE s.parent_id IS NULL
       AND s.directory = ?
       AND m.time_created > max(?, COALESCE(mk.ts, 0))
       AND s.title NOT IN (${placeholders})
       AND json_extract(p.data, '$.type') = 'text'
       AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
       AND COALESCE(trim(json_extract(p.data, '$.text')), '') <> ''`,
    [JSON.stringify(marks), dir, watermarkTs, ...titles],
  );
  const row = rows[0] ?? {};
  return {
    turns: row.turns ?? 0,
    sessions: row.sessions ?? 0,
    messages: row.messages ?? 0,
    oldest: row.oldest ?? null,
    newest: row.newest ?? null,
    watermark: watermarkTs,
    marked_sessions: Object.keys(marks).length,
  };
}

/* ------------------------------------------------------------------- state */

export function readState(paths) {
  return {
    heartbeat: safeJson(join(paths.state, 'heartbeat.json')),
    current: safeJson(join(paths.state, 'heartbeat.current.json')),
    mood: safeJson(join(paths.state, 'mood.json')),
    sleep: safeJson(join(paths.state, 'sleep.json')),
    idea: safeJson(join(paths.state, 'idea.json')),
    drain: safeJson(join(paths.state, 'drain.current.json')),
    cursor: safeJson(join(paths.state, 'drain-cursor.json')),
    queue: safeJson(join(paths.state, 'work-queue.json')),
    runtime: safeJson(join(paths.state, 'runtime.json')),
    serveUrl: safeText(join(paths.state, 'serve-url')).trim(),
  };
}

export function readQueue(paths, missions) {
  const raw = safeJson(join(paths.state, 'work-queue.json'));
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.primary) || Array.isArray(raw?.side)
        ? [
            ...(Array.isArray(raw.primary) ? raw.primary : []),
            ...(Array.isArray(raw.side) ? raw.side.map((item) => ({ ...item, kind: 'staleness' })) : []),
          ]
        : [];
  const byId = new Map(missions.map((m) => [m.id, m]));
  const now = Date.now();

  const items = list
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => {
      const kind = item.kind === 'dream' ? 'quiet-hours' : item.kind ?? 'mission';
      const missionId = typeof item.payload?.mission === 'string'
        ? item.payload.mission
        : item.id.startsWith('mission:')
          ? item.id.slice('mission:'.length)
          : null;
      const mission = missionId ? byId.get(missionId) : null;
      const enqueued = Number.isFinite(item.enqueued_ms) ? item.enqueued_ms : null;
      const notBefore = Number.isFinite(item.not_before_ms) ? item.not_before_ms : null;
      const expires = Number.isFinite(item.expires_ms) ? item.expires_ms : null;
      return {
        id: item.id,
        kind,
        mission: missionId,
        title: mission?.title ?? (typeof item.payload?.title === 'string' ? item.payload.title : item.id),
        producer: item.producer ?? 'unknown',
        priority: WORK_PRIORITY[kind] ?? 99,
        enqueued_ms: enqueued,
        age_ms: enqueued === null ? null : Math.max(0, now - enqueued),
        not_before_ms: notBefore,
        due: notBefore === null || now >= notBefore,
        expires_ms: expires,
        ttl_ms: expires === null ? null : Math.max(0, expires - now),
        requeue_count: item.requeue_count ?? 0,
        requeue_reason: item.requeue_reason ?? null,
        payload: item.payload ?? null,
      };
    })
    .sort((a, b) => a.priority - b.priority || (a.enqueued_ms ?? 0) - (b.enqueued_ms ?? 0));

  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;

  return {
    items,
    counts,
    total: items.length,
    oldest_ms: items.reduce((max, item) => Math.max(max, item.age_ms ?? 0), 0),
    due: items.filter((item) => item.due).length,
    scheduler: schedulerSnapshot(raw, items, now),
  };
}

export function readDrain(dir, paths, state, now = Date.now()) {
  const { data } = readConfig(dir);
  const cfg = data?.drain ?? {};
  const cursor = state.cursor ?? {};
  const validCursor = cursor.version === 2 || cursor.version === 3;
  const cursorPresent =
    validCursor && Number.isFinite(cursor.watermark_ts) && cursor.watermark_ts > 0;
  const watermark = cursorPresent ? cursor.watermark_ts : null;
  const exclude = Array.isArray(cfg.exclude_missions) ? cfg.exclude_missions : ['drain', 'staleness', 'dream'];
  // No cursor yet (fresh install, wiped state, or watermark 0): report an empty
  // backlog instead of counting every turn in history from epoch. The pipe
  // writes the real cursor on its next pass.
  const pending = cursorPresent
    ? pendingTurns(dir, watermark, exclude, cursor)
    : { turns: 0, sessions: 0, messages: 0, oldest: null, newest: null, watermark: null, marked_sessions: 0 };
  const current = state.drain ?? {};
  const queue = Array.isArray(state.queue)
    ? state.queue
    : Array.isArray(state.queue?.items)
      ? state.queue.items
      : [];
  const drainPass = queue.find((item) => item && item.kind === 'drain-pass') ?? null;
  const queuedSince = drainPass && Number.isFinite(drainPass.enqueued_ms) ? drainPass.enqueued_ms : null;
  const queuedAge = queuedSince === null ? null : Math.max(0, now - queuedSince);
  const passes = drainPasses(paths);
  const lastPass = passes.length ? passes[passes.length - 1] : null;
  const nextDue = Number.isFinite(current.next_due) ? current.next_due : null;

  return {
    ts: new Date(now).toISOString(),
    enabled: cfg.enabled !== false,
    consumer: cfg.consumer !== false,
    state: current.state ?? (cfg.consumer === false ? 'disabled' : drainPass ? 'queued' : 'idle'),
    trigger: current.trigger ?? null,
    queued: Boolean(drainPass),
    queued_since: queuedSince === null ? null : new Date(queuedSince).toISOString(),
    queued_age_ms: queuedAge,
    pass: Number.isFinite(current.pass) ? current.pass : passes.length,
    pending: pending.turns,
    pending_sessions: pending.sessions,
    pending_messages: pending.messages,
    marked_sessions: pending.marked_sessions,
    pending_definition: cursorPresent
      ? 'top-level text turns above the cursor watermark and each session mark'
      : 'no drain cursor yet — backlog reports 0 until the first drain pass',
    oldest_pending_age_ms: pending.oldest ? Math.max(0, now - pending.oldest) : null,
    next_due: nextDue,
    trigger_pending: Number.isFinite(cfg.trigger_pending) ? cfg.trigger_pending : 12,
    trigger_max_age_hours: Number.isFinite(cfg.trigger_max_age_hours) ? cfg.trigger_max_age_hours : 2,
    watermark_ts: watermark,
    cursor_present: cursorPresent,
    cursor_version: cursor.version ?? null,
    last_pass: lastPass
      ? {
          ts: lastPass.ts,
          wall_ms: lastPass.wall_ms ?? null,
          tokens: lastPass.tokens ?? 0,
          cost: lastPass.cost ?? 0,
          sessions: lastPass.sessions ?? 0,
          items: lastPass.items ?? 0,
          outcome: lastPass.outcome ?? 'unknown',
        }
      : null,
    recent: passes.slice(-8).reverse().map((row) => ({
      ts: row.ts,
      outcome: row.outcome ?? 'unknown',
      tokens: row.tokens ?? 0,
      cost: row.cost ?? 0,
      sessions: row.sessions ?? 0,
      items: row.items ?? 0,
      wall_ms: row.wall_ms ?? null,
      pending_before: row.pending_before ?? null,
      pending_after: row.pending_after ?? null,
    })),
    series: passes
      .slice(-24)
      .map((row) => ({
        ts: row.ts,
        pending: row.pending_after ?? row.pending_before ?? null,
        outcome: row.outcome ?? 'unknown',
      }))
      .filter((point) => point.pending !== null),
    available: true,
  };
}

export function readHeartbeat(dir, state, now = Date.now()) {
  const { data } = readConfig(dir);
  const cfg = data?.heartbeat ?? {};
  const autonomy = data?.autonomy ?? {};
  const current = state.current ?? null;
  const stored = state.heartbeat ?? {};
  const interval = parseDuration(autonomy?.heartbeat?.frequency);
  const enabled = cfg.enabled !== false && autonomy?.heartbeat?.frequency !== 'off';
  const lastTick = Number.isFinite(stored.last_tick) ? stored.last_tick : null;
  const nextTick = enabled && lastTick !== null && interval ? lastTick + interval : null;
  const remaining = nextTick === null ? null : Math.max(0, nextTick - now);
  const updated = parseTime(current?.updated_at);
  const staleMs = Number.isFinite(cfg.mission_lock_stale_ms) ? cfg.mission_lock_stale_ms : 1800000;
  const inFlight = current?.state === 'in-flight';
  const liveSide = inFlight ? current?.side_mission ?? null : null;

  return {
    ts: new Date(now).toISOString(),
    current: current
      ? {
          state: current.state,
          tick: current.tick ?? null,
          phase: current.phase ?? null,
          mission: current.mission ?? null,
          mission_title: current.mission_title ?? null,
          session: current.session ?? null,
          side_mission: liveSide,
          side_mission_title: liveSide ? current.side_mission_title ?? null : null,
          side_session: liveSide ? current.side_session ?? null : null,
          started_at: current.started_at ?? null,
          updated_at: current.updated_at ?? null,
          level: current.level ?? null,
        }
      : null,
    lock: inFlight,
    lock_stale: Boolean(inFlight && updated && now - updated > staleMs),
    schedule: {
      enabled,
      level: Number.isFinite(autonomy.level) ? autonomy.level : 1,
      frequency: autonomy?.heartbeat?.frequency ?? 'off',
      base_interval_ms: interval,
      interval_ms: interval,
      noop_streak: stored.noop_streak ?? 0,
      last_tick: lastTick === null ? null : new Date(lastTick).toISOString(),
      next_tick: nextTick === null ? null : new Date(nextTick).toISOString(),
      remaining_ms: remaining,
      due: nextTick !== null && remaining === 0,
      paused: !enabled,
      off: autonomy?.heartbeat?.frequency === 'off',
    },
    counters: {
      ticks: stored.ticks ?? 0,
      noop_streak: stored.noop_streak ?? 0,
      last_mission: stored.last_mission ?? null,
    },
  };
}

export function readMood(paths, now = Date.now()) {
  const mood = safeJson(join(paths.state, 'mood.json'));
  if (!mood) return { valence: null, arousal: null, label: 'unknown', since: null, age_ms: null };
  const since = parseTime(mood.since);
  return {
    valence: typeof mood.valence === 'number' ? mood.valence : null,
    arousal: typeof mood.arousal === 'number' ? mood.arousal : null,
    label: mood.label ?? 'flat',
    baseline: mood.baseline ?? null,
    since: mood.since ?? null,
    age_ms: since === null ? null : Math.max(0, now - since),
  };
}

export function readSleep(dir, paths, now = Date.now()) {
  const { data } = readConfig(dir);
  const sleep = safeJson(join(paths.state, 'sleep.json'));
  const window = data?.autonomy?.quiet?.window ?? '23:00-08:00';
  if (sleep) {
    return {
      status: sleep.status ?? 'awake',
      since: sleep.since ?? null,
      woken_at: sleep.woken_at ?? null,
      dreams_tonight: sleep.dreams_tonight ?? 0,
      last_tick: sleep.last_tick ?? null,
      window,
      quiet: sleep.status === 'sleeping' || sleep.status === 'dreaming',
      available: true,
    };
  }
  const quiet = quietNow(window, now);
  return {
    status: quiet ? 'quiet' : 'awake',
    since: null,
    woken_at: null,
    dreams_tonight: 0,
    last_tick: null,
    window,
    quiet,
    available: false,
  };
}

export function readIdea(paths) {
  const idea = safeJson(join(paths.state, 'idea.json'));
  return idea ?? { dayKey: null, dailyTarget: 0, generatedToday: 0, lastExpressedAt: null };
}

export function readBacklog(dir, paths, limit = 100) {
  const { data } = readConfig(dir);
  const cfg = data?.backlog ?? {};
  const file = resolveLeaf(paths.state, cfg.file ?? 'backlog.ndjson');
  const rows = parseLines(file, 0).filter((row) => !row.raw);
  const counts = {};
  for (const row of rows) counts[row.status ?? 'unknown'] = (counts[row.status ?? 'unknown'] ?? 0) + 1;
  return {
    total: rows.length,
    open: rows.filter((row) => ['open', 'queued', 'running'].includes(row.status)).length,
    counts,
    entries: rows.slice(-limit).reverse(),
  };
}

export function readLocks(paths, now = Date.now()) {
  const names = ['heartbeat.lock', 'mission.lock', 'drain.lock', 'run.lock', 'ownership.lock'];
  return names.map((name) => {
    const file = join(paths.state, name);
    const st = fileInfo(file);
    return {
      name,
      present: Boolean(st),
      bytes: st?.bytes ?? 0,
      age_ms: st ? Math.max(0, now - st.mtime) : null,
      content: st && st.bytes < 2048 ? safeText(file).trim() : '',
    };
  });
}

export function listLedgers(paths) {
  let names = [];
  try {
    names = readdirSync(paths.logs);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.(log|ndjson|jsonl)$/i.test(name))
    .map((name) => fileInfo(join(paths.logs, name)))
    .filter(Boolean)
    .map(({ name, bytes, lines, mtime }) => ({ name, bytes, lines, mtime }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function tailLedger(paths, name, limit = 200) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) return { name, entries: [] };
  const file = join(paths.logs, safe);
  const rows = lines(file, limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
  return { name: safe, entries: rows };
}

/* -------------------------------------------------------------------- runs */

function drainPasses(paths) {
  const rows = parseLines(join(paths.logs, 'drain.log'), 0).filter((row) => !row.raw);
  const writers = rows
    .filter((row) => row.source === 'writer' && Number.isFinite(parseTime(row.ts)))
    .map((row) => ({ ...row, ts_ms: parseTime(row.ts) }));
  return rows
    .filter((row) => row.source === 'pipe')
    .map((row) => {
      const tsMs = parseTime(row.ts);
      const wall = Number.isFinite(row.wall_ms) ? row.wall_ms : null;
      const started = tsMs !== null && wall !== null ? tsMs - wall : tsMs;
      const related = writers.filter((writer) => {
        if (writer.cursor_before !== row.cursor_before) return false;
        if (row.trigger && writer.trigger && writer.trigger !== row.trigger) return false;
        if (started !== null && writer.ts_ms < started - 1000) return false;
        if (tsMs !== null && writer.ts_ms > tsMs) return false;
        return true;
      });
      const cost = related.reduce((sum, writer) => sum + (Number.isFinite(writer.cost) ? writer.cost : 0), 0);
      const lastWriter = related.length ? related[related.length - 1] : null;
      return {
        ...row,
        ts_ms: tsMs,
        started_ms: started,
        cost: Number.isFinite(row.cost) ? row.cost : related.length ? cost : null,
        session: row.session ?? lastWriter?.session ?? null,
        writer_model: lastWriter?.model ?? row.model ?? null,
      };
    })
    .filter((row) => row.ts_ms !== null);
}

export function readRuns(dir, paths, options = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 120));
  const hours = Math.min(24 * 30, Math.max(1, Number(options.hours) || 24 * 7));
  const since = Date.now() - hours * 3_600_000;
  const ticks = parseLines(join(paths.logs, 'heartbeat.log'), 0).filter((row) => !row.raw && Number.isFinite(row.tick));
  const missions = readMissions(dir);
  const missionMap = new Map(missions.map((m) => [m.id, m]));

  const rawRuns = [];
  for (const tick of ticks) {
    const tickTs = parseTime(tick.ts);
    if (tickTs !== null && tickTs < since) continue;
    const list = Array.isArray(tick.runs) && tick.runs.length
      ? tick.runs
      : tick.mission
        ? [{
            mission: tick.mission,
            lane: 'primary',
            outcome: tick.outcome,
            token_cost: tick.token_cost,
            over_budget: tick.over_budget,
            session: tick.session,
            result_status: tick.result_status,
            result_missing: tick.result_missing,
            requeued: tick.requeued,
          }]
        : [];
    for (const run of list) {
      rawRuns.push({ tick, tickTs, run });
    }
  }

  const drainRows = drainPasses(paths).filter((row) => row.ts_ms >= since);
  const sessionMap = sessionsByIds(dir, [
    ...rawRuns.map(({ run }) => run.session),
    ...drainRows.map((row) => row.session),
  ]);
  const missionRuns = rawRuns
    .map(({ tick, tickTs, run }) => {
      const session = run.session ? sessionMap.get(run.session) : null;
      const started = session?.created ?? tickTs;
      const finished = session?.updated ?? (tickTs !== null && Number.isFinite(tick.duration_ms) ? tickTs : null);
      const duration = started !== null && finished !== null && finished >= started ? finished - started : tick.duration_ms ?? null;
      const mission = run.mission ?? tick.mission ?? null;
      return {
        ts: tick.ts,
        ts_ms: tickTs,
        tick: tick.tick ?? null,
        mission,
        mission_title: missionMap.get(mission)?.title ?? mission,
        kind: run.lane === 'side' ? 'side' : 'mission',
        lane: run.lane ?? 'primary',
        outcome: run.outcome ?? null,
        token_cost: run.token_cost ?? null,
        over_budget: run.over_budget === true,
        cost: session?.cost ?? null,
        model: session?.modelLabel ?? null,
        tokens_in: session?.tokensIn ?? null,
        tokens_out: session?.tokensOut ?? null,
        tokens_total: session ? (session.tokensIn ?? 0) + (session.tokensOut ?? 0) + (session.tokensReasoning ?? 0) : run.token_cost ?? null,
        duration_ms: duration,
        started_ms: started,
        finished_ms: finished,
        result_status: run.result_status ?? null,
        result_missing: run.result_missing === true,
        requeued: run.requeued === true,
        session: run.session ?? null,
        aborted: run.aborted === true,
        stop_reason: run.stop_reason ?? null,
        stalled_for_ms: run.stalled_for_ms ?? null,
        error: run.stop_reason ?? run.abort_error ?? null,
      };
    });
  const drainRuns = drainRows.map((row) => {
    const session = row.session ? sessionMap.get(row.session) : null;
    return {
      ts: row.ts,
      ts_ms: row.ts_ms,
      tick: null,
      mission: 'drain',
      mission_title: missionMap.get('drain')?.title ?? 'Drain conversation backlog',
      kind: 'drain',
      lane: 'drain',
      outcome: row.outcome ?? null,
      token_cost: Number.isFinite(row.tokens) ? row.tokens : null,
      over_budget: false,
      cost: row.cost ?? session?.cost ?? null,
      model: session?.modelLabel ?? row.writer_model ?? row.model ?? null,
      tokens_in: session?.tokensIn ?? null,
      tokens_out: session?.tokensOut ?? null,
      tokens_total: session ? (session.tokensIn ?? 0) + (session.tokensOut ?? 0) + (session.tokensReasoning ?? 0) : row.tokens ?? null,
      duration_ms: Number.isFinite(row.wall_ms) ? row.wall_ms : null,
      started_ms: row.started_ms,
      finished_ms: row.ts_ms,
      result_status: row.outcome ?? null,
      result_missing: false,
      requeued: false,
      session: row.session ?? null,
      aborted: false,
      stop_reason: row.stopped ?? null,
      stalled_for_ms: null,
      error: row.error ?? null,
      trigger: row.trigger ?? null,
      pending_before: Number.isFinite(row.pending_before) ? row.pending_before : null,
      pending_after: Number.isFinite(row.pending_after) ? row.pending_after : null,
      batch_sessions: Number.isFinite(row.sessions) ? row.sessions : null,
      batch_items: Number.isFinite(row.items) ? row.items : null,
    };
  });
  const runs = [...missionRuns, ...drainRuns].sort((a, b) => (b.started_ms ?? 0) - (a.started_ms ?? 0));

  const filtered = runs.filter(
    (run) =>
      (!options.mission || run.mission === options.mission) &&
      (!options.kind || run.kind === options.kind) &&
      (!options.outcome || run.outcome === options.outcome) &&
      (!options.session || run.session === options.session),
  );

  return {
    ts: new Date().toISOString(),
    runs: filtered.slice(0, limit),
    total: filtered.length,
    available: runs.length > 0,
    hours,
  };
}

/** Single-run lookup for the drawer: one enriched run + its session breakdown. */
export function readRunDetail(dir, paths, params = {}) {
  const session = params.session || null;
  const rawTick = params.tick;
  const tick =
    rawTick !== null && rawTick !== undefined && rawTick !== '' && Number.isFinite(Number(rawTick))
      ? Number(rawTick)
      : null;
  const mission = params.mission || null;
  const snapshot = readRuns(dir, paths, {
    limit: 20,
    hours: 24 * 30,
    session: session || undefined,
    mission: !session && mission ? mission : undefined,
  });
  const run =
    snapshot.runs.find(
      (row) =>
        (!session || row.session === session) &&
        (tick === null || row.tick === tick) &&
        (session || !mission || row.mission === mission),
    ) ??
    (tick !== null && !session ? snapshot.runs.find((row) => row.tick === tick) ?? null : null);

  let sessionDetail = null;
  if (run?.session) {
    const row = sessionsByIds(dir, [run.session]).get(run.session);
    if (row) {
      sessionDetail = {
        id: row.id,
        title: row.title ?? null,
        agent: row.agent ?? null,
        model: row.modelLabel ?? null,
        cost: row.cost ?? null,
        tokens_in: row.tokensIn ?? null,
        tokens_out: row.tokensOut ?? null,
        tokens_reasoning: row.tokensReasoning ?? null,
        cache_read: row.cacheRead ?? null,
        cache_write: row.cacheWrite ?? null,
        started_ms: row.created ?? null,
        finished_ms: row.updated ?? null,
      };
    }
  }
  return { run: run ?? null, session: sessionDetail };
}

/* ----------------------------------------------------------------- metrics */

export function tokenSeries(dir, paths, hours = 24, bucket = 'hour') {
  const { data } = readConfig(dir);
  const budget = data?.autonomy?.mission_token_budget;
  const runs = readRuns(dir, paths, { limit: 500, hours }).runs;
  const map = new Map();
  for (const run of runs) {
    const t = run.started_ms ?? run.ts_ms ?? Date.now();
    const d = new Date(t);
    const key =
      bucket === 'day'
        ? d.toISOString().slice(0, 10)
        : bucket === 'tick'
          ? `t${run.tick ?? 0}`
          : `${d.toISOString().slice(0, 13)}:00`;
    const point = map.get(key) ?? { bucket: key, tokens: 0, cost: 0, runs: 0, over_runs: 0 };
    point.tokens += run.token_cost ?? 0;
    point.cost += run.cost ?? 0;
    point.runs += 1;
    if (run.over_budget) point.over_runs += 1;
    map.set(key, point);
  }
  const points = [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return {
    ts: new Date().toISOString(),
    bucket,
    budget_per_run: typeof budget === 'number' ? budget : null,
    unlimited: budget === 'unlimited',
    points,
    totals: {
      tokens: points.reduce((a, p) => a + p.tokens, 0),
      cost: points.reduce((a, p) => a + p.cost, 0),
      runs: points.reduce((a, p) => a + p.runs, 0),
      over_runs: points.reduce((a, p) => a + p.over_runs, 0),
    },
    available: points.length > 0,
  };
}

export function costReport(dir, paths, hours = 24) {
  const since = Date.now() - hours * 3_600_000;
  const models = sessionAggregate(dir, since);
  const days = dayAggregate(dir, since);
  const runs = readRuns(dir, paths, { limit: 500, hours }).runs;
  const missionMap = new Map();
  for (const run of runs) {
    const key = run.mission ?? 'unknown';
    const row = missionMap.get(key) ?? { mission: key, runs: 0, tokens: 0, cost: 0, costed_runs: 0 };
    row.runs += 1;
    row.tokens += run.token_cost ?? 0;
    if (typeof run.cost === 'number') {
      row.cost += run.cost;
      row.costed_runs += 1;
    }
    missionMap.set(key, row);
  }
  const total = models.reduce((a, m) => a + m.cost, 0);
  const today = new Date().toLocaleDateString('sv-SE');
  const costed = runs.filter((run) => typeof run.cost === 'number');
  return {
    ts: new Date().toISOString(),
    hours,
    total,
    today: days.find((d) => d.day === today)?.cost ?? 0,
    sessions: models.reduce((a, m) => a + m.sessions, 0),
    models: models.map((m) => ({ ...m, share: pct(m.cost, total) })),
    days,
    missions: [...missionMap.values()].sort((a, b) => b.cost - a.cost),
    avg_per_run: costed.length ? costed.reduce((a, r) => a + r.cost, 0) / costed.length : null,
    run_cost_total: costed.reduce((a, r) => a + r.cost, 0),
    available: models.length > 0,
  };
}

export function errorReport(dir, paths, hours = 24) {
  const since = Date.now() - hours * 3_600_000;
  const runs = readRuns(dir, paths, { limit: 500, hours }).runs;
  const counts = {};
  for (const run of runs) counts[run.outcome ?? 'unknown'] = (counts[run.outcome ?? 'unknown'] ?? 0) + 1;
  const errors = runs.filter(
    (run) => ['error', 'timeout', 'aborted'].includes(run.outcome ?? '') || run.result_missing,
  );
  const seriesMap = new Map();
  for (const run of runs) {
    const t = run.started_ms ?? run.ts_ms ?? Date.now();
    const key = new Date(t).toISOString().slice(0, 13);
    const row = seriesMap.get(key) ?? { bucket: `${key}:00`, total: 0, errors: 0 };
    row.total += 1;
    if (['error', 'timeout', 'aborted'].includes(run.outcome ?? '') || run.result_missing) row.errors += 1;
    seriesMap.set(key, row);
  }
  const series = [...seriesMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  const gateRows = parseLines(join(paths.logs, 'autonomy-gate.log'), 0).filter(
    (row) => !row.raw && (parseTime(row.ts) ?? 0) >= since,
  );
  const gateVerdicts = {};
  const gateClasses = {};
  for (const row of gateRows) {
    if (row.event !== 'verdict') continue;
    gateVerdicts[row.verdict ?? 'unknown'] = (gateVerdicts[row.verdict ?? 'unknown'] ?? 0) + 1;
    gateClasses[row.cls ?? 'unknown'] = (gateClasses[row.cls ?? 'unknown'] ?? 0) + 1;
  }

  const auditRows = parseLines(join(paths.logs, 'audit.log'), 0).filter(
    (row) => !row.raw && (parseTime(row.ts) ?? 0) >= since,
  );
  const auditFailures = auditRows.filter((row) => typeof row.exit === 'number' && row.exit !== 0);

  const retrievalRows = parseLines(join(paths.logs, 'retrieval.log'), 0).filter(
    (row) => !row.raw && (parseTime(row.ts) ?? 0) >= since,
  );
  const retrievalErrors = retrievalRows.filter((row) => row.error);

  const drainRows = parseLines(join(paths.logs, 'drain.log'), 0).filter(
    (row) => !row.raw && (parseTime(row.ts) ?? 0) >= since,
  );
  const drainErrors = drainRows.filter((row) => row.outcome === 'error');

  return {
    ts: new Date().toISOString(),
    hours,
    runs: {
      total: runs.length,
      errors: errors.length,
      rate: pct(errors.length, runs.length),
      by_outcome: counts,
      recent: errors.slice(0, 20).map((run) => ({
        ts: run.ts,
        mission: run.mission,
        outcome: run.outcome,
        stop_reason: run.stop_reason,
        session: run.session,
      })),
    },
    gates: {
      total: Object.values(gateVerdicts).reduce((a, b) => a + b, 0),
      by_verdict: gateVerdicts,
      by_class: gateClasses,
    },
    audit: { total: auditRows.length, failures: auditFailures.length, recent: auditFailures.slice(-10).reverse() },
    retrieval: { total: retrievalRows.length, errors: retrievalErrors.length },
    drain: { total: drainRows.length, errors: drainErrors.length },
    series,
    available: runs.length > 0,
  };
}

export function throughputReport(dir, paths, hours = 24) {
  const runs = readRuns(dir, paths, { limit: 500, hours }).runs;
  const buckets = new Map();
  for (const run of runs) {
    const t = run.started_ms ?? run.ts_ms ?? Date.now();
    const key = new Date(t).toISOString().slice(0, 13);
    const row = buckets.get(key) ?? { bucket: `${key}:00`, runs: 0, tokens: 0, cost: 0, durations: [] };
    row.runs += 1;
    row.tokens += run.token_cost ?? 0;
    row.cost += run.cost ?? 0;
    if (typeof run.duration_ms === 'number') row.durations.push(run.duration_ms);
    buckets.set(key, row);
  }
  const points = [...buckets.values()]
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map(({ durations, ...row }) => ({
      ...row,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
    }));
  const durations = runs.map((r) => r.duration_ms).filter((v) => typeof v === 'number');
  const ticks = parseLines(join(paths.logs, 'heartbeat.log'), 0).filter(
    (row) => !row.raw && Number.isFinite(row.tick) && (parseTime(row.ts) ?? 0) >= Date.now() - hours * 3_600_000,
  );
  return {
    ts: new Date().toISOString(),
    hours,
    points,
    totals: {
      runs: runs.length,
      tokens: runs.reduce((a, r) => a + (r.token_cost ?? 0), 0),
      cost: runs.reduce((a, r) => a + (r.cost ?? 0), 0),
      ticks: ticks.length,
      p50_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95),
    },
    available: runs.length > 0,
  };
}

export function queueWaitReport(paths, missions) {
  const queue = readQueue(paths, missions);
  const ages = queue.items.map((item) => item.age_ms).filter((v) => typeof v === 'number');
  const byKind = {};
  for (const item of queue.items) {
    const row = byKind[item.kind] ?? { kind: item.kind, count: 0, oldest_ms: 0 };
    row.count += 1;
    row.oldest_ms = Math.max(row.oldest_ms, item.age_ms ?? 0);
    byKind[item.kind] = row;
  }
  return {
    ts: new Date().toISOString(),
    total: queue.total,
    oldest_ms: queue.oldest_ms,
    p50_ms: percentile(ages, 50),
    p95_ms: percentile(ages, 95),
    due: queue.due,
    by_kind: Object.values(byKind),
    historical: false,
    note: 'current queue age only; completed-run enqueue timestamps are not persisted',
  };
}

export function activityReport(paths, hours = 6) {
  const since = Date.now() - hours * 3_600_000;
  const events = [];
  const push = (row, type, title, detail, tone = 'info') => {
    const ts = parseTime(row.ts);
    if (ts === null || ts < since) return;
    events.push({ ts: row.ts, ts_ms: ts, type, title, detail, tone });
  };

  for (const row of parseLines(join(paths.logs, 'autonomy-gate.log'), 120)) {
    if (row.raw) continue;
    if (row.event === 'verdict') {
      push(
        row,
        'gate',
        `${row.tool ?? row.kind ?? 'tool'} → ${row.verdict ?? '?'}`,
        [row.cls, row.reason, row.mode].filter(Boolean).join(' · '),
        row.verdict === 'deny' ? 'danger' : row.verdict === 'ask' ? 'warning' : 'success',
      );
    }
  }
  for (const row of parseLines(join(paths.logs, 'decisions.log'), 60)) {
    if (row.raw || row.event !== 'decision') continue;
    push(
      row,
      'decision',
      `${row.kind ?? 'decision'} → ${row.value ?? '?'}`,
      `${row.model ?? '?'} · ${Math.round((row.confidence ?? 0) * 100)}%${row.fallback ? ' · fallback' : ''}`,
      row.abstained || row.error ? 'warning' : 'primary',
    );
  }
  for (const row of parseLines(join(paths.logs, 'retrieval.log'), 60)) {
    if (row.raw) continue;
    push(
      row,
      'retrieval',
      row.retrieve ? 'retrieved' : 'skipped',
      [row.reason, row.mode, row.model].filter(Boolean).join(' · '),
      row.error ? 'danger' : row.retrieve ? 'primary' : 'muted',
    );
  }
  for (const row of parseLines(join(paths.logs, 'audit.log'), 80)) {
    if (row.raw) continue;
    push(
      row,
      'audit',
      `bash exit ${row.exit ?? '?'}`,
      String(row.cmd ?? '').slice(0, 180),
      row.exit === 0 ? 'muted' : 'danger',
    );
  }
  for (const row of parseLines(join(paths.logs, 'drain.log'), 40)) {
    if (row.raw) continue;
    push(
      row,
      'drain',
      `${row.source ?? 'drain'} → ${row.outcome ?? '?'}`,
      `${row.tokens ?? 0} tokens · $${Number(row.cost ?? 0).toFixed(4)}${row.error ? ` · ${row.error}` : ''}`,
      row.outcome === 'error' ? 'danger' : 'success',
    );
  }
  for (const row of parseLines(join(paths.logs, 'rag-search.log'), 40)) {
    if (row.raw) continue;
    push(
      row,
      'delegate',
      `rag-search · ${row.description ?? row.delegate ?? 'delegate'}`,
      `${row.usage?.cost ? `$${Number(row.usage.cost).toFixed(4)}` : 'cost n/a'} · ${row.wallMs ?? 0}ms`,
      row.outcome === 'ok' ? 'muted' : 'warning',
    );
  }
  for (const row of parseLines(join(paths.logs, 'web-usage.log'), 40)) {
    if (row.raw) continue;
    push(
      row,
      'web',
      `${row.delegate ?? 'web'} · ${row.description ?? ''}`.trim(),
      `${row.domain ?? ''} ${row.usage?.cost ? `· $${Number(row.usage.cost).toFixed(4)}` : ''}`.trim(),
      'muted',
    );
  }
  for (const row of parseLines(join(paths.logs, 'mood.ndjson'), 40)) {
    if (row.raw) continue;
    push(
      row,
      'mood',
      row.event ?? 'mood',
      `${row.label_after ?? ''}${row.valence_after !== undefined ? ` · v ${Number(row.valence_after).toFixed(2)}` : ''}`,
      'primary',
    );
  }

  return {
    ts: new Date().toISOString(),
    hours,
    events: events.sort((a, b) => b.ts_ms - a.ts_ms).slice(0, 120),
    available: events.length > 0,
  };
}

/* -------------------------------------------------------------------- misc */

export function healthInfo(dir, state, paths) {
  const runtime = state.runtime;
  const serveUrl =
    (state.serveUrl || '').trim() ||
    runtime?.opencode?.url ||
    '';
  const dashboard = readConfig(dir).data?.dashboard ?? {};
  const configured = String(dashboard.display_name ?? '').trim();
  const accent = String(dashboard.accent ?? '').trim();
  return {
    ok: true,
    directory: dir,
    display_name: configured || basename(resolve(dir)),
    accent: accent || 'lime',
    serve_url: serveUrl || null,
    serve_ok: null,
    auth: 'csrf',
    version: 'v2',
    paths,
    writable_sections: ['autonomy', 'heartbeat', 'scheduler', 'drain', 'mood', 'comms', 'idea', 'decisions', 'retrieval', 'browser', 'profile', 'soul', 'telemetry', 'backlog', 'memory', 'dashboard'],
  };
}

export function overview(dir, paths, state, options = {}) {
  const now = Date.now();
  const missions = readMissions(dir);
  const heartbeat = readHeartbeat(dir, state, now);
  const queue = readQueue(paths, missions);
  const drain = readDrain(dir, paths, state, now);
  const runs = readRuns(dir, paths, { limit: 200, hours: 24 });
  const cost = costReport(dir, paths, 24);
  const errors = errorReport(dir, paths, 24);
  const mood = readMood(paths, now);
  const sleep = readSleep(dir, paths, now);
  const idea = readIdea(paths);
  const backlog = readBacklog(dir, paths, 1);
  const lastRun = runs.runs[0] ?? null;
  const costedRuns = runs.runs.filter((r) => typeof r.cost === 'number');
  const lastTokens = lastRun?.token_cost ?? null;
  const budget = (() => {
    const cfg = readConfig(dir).data;
    const b = cfg?.autonomy?.mission_token_budget;
    return typeof b === 'number' ? b : null;
  })();

  return {
    now,
    health: healthInfo(dir, state, paths),
    heartbeat,
    mood,
    sleep,
    idea,
    queue: {
      total: queue.total,
      due: queue.due,
      oldest_ms: queue.oldest_ms,
      counts: queue.counts,
      running: heartbeat.current,
      next: queue.items.slice(0, 6),
    },
    drain,
    backlog: { total: backlog.total, open: backlog.open, counts: backlog.counts },
    missions: {
      total: missions.length,
      enabled: missions.filter((m) => m.enabled).length,
      ids: missions.map((m) => ({ id: m.id, enabled: m.enabled, level: m.min_level, frequency: m.frequency })),
    },
    cost: {
      total_24h: cost.total,
      today: cost.today,
      avg_per_run: cost.avg_per_run,
      top_model: cost.models[0] ?? null,
    },
    errors: {
      rate: errors.runs.rate,
      errors: errors.runs.errors,
      total: errors.runs.total,
      gates: errors.gates.by_verdict,
      audit_failures: errors.audit.failures,
    },
    last_run: lastRun,
    budget_per_run: budget,
    last_tokens: lastTokens,
    quiet: sleep.quiet,
    locks: readLocks(paths, now),
  };
}
