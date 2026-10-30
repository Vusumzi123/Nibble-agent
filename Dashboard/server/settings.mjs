// Settings schema + safe YAML editing for the live agent harness.
//
// The schema mirrors the keys the running plugin actually reads (config.ts /
// autonomy.ts / heartbeat.ts / drain/config.ts and the other section readers).
// Writes go through a YAML Document so comments and ordering survive; every
// value is type-checked and cross-field invariants are enforced.

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';

const f = (path, type, opts = {}) => ({ path, type, ...opts });

function rotation(prefix = '') {
  return [
    f(`${prefix}log_rotate_bytes`, 'int', { min: 0, default: 1048576, label: 'rotate bytes' }),
    f(`${prefix}log_keep_generations`, 'int', { min: 0, default: 5, label: 'keep generations' }),
    f(`${prefix}log_retention_days`, 'int', { min: 0, default: 90, label: 'retention days' }),
    f(`${prefix}log_compress`, 'bool', { default: true, label: 'compress' }),
    f(`${prefix}log_compress_after`, 'int', { min: 0, default: 1, label: 'compress after' }),
    f(`${prefix}log_compress_level`, 'int', { min: 1, max: 9, default: 6, label: 'compress level' }),
    f(`${prefix}log_rotate_by`, 'enum', { options: ['size', 'daily', 'weekly'], default: 'size', label: 'rotate by' }),
  ];
}

export const SECTIONS = [
  {
    id: 'autonomy',
    label: 'Autonomy',
    description: 'Capability dial, approval gates, idle chatter and quiet-hours dreams. Hot-read per call.',
    writable: true,
    restart: false,
    fields: [
      f('level', 'int', { min: 0, max: 4, default: 3, help: '0 observe → 4 autonomous. Raising above the current level is refused while auth is off.' }),
      f('gate_mode', 'enum', { options: ['shadow', 'gate'], default: 'gate', help: 'shadow logs only; gate enforces.' }),
      f('gate_scope', 'enum', { options: ['main', 'all'], default: 'main' }),
      f('heartbeat.frequency', 'duration', { default: '15m', allowOff: true, help: 'off | <n>m | <n>h' }),
      f('heartbeat.in_progress_lock', 'bool', { default: true }),
      f('mission_token_budget', 'budget', { default: 32000, help: 'K-tokens per mission turn, or unlimited.' }),
      f('root_classes', 'list', { default: [], help: 'L4 root allowlist; irreversibility floor still applies.' }),
      f('class_overrides', 'list', { default: [], help: 'kind:name:class triples.' }),
      f('batch.max_actions', 'int', { min: 0, default: 8 }),
      f('session_grant', 'enum', { options: ['off', 'target', 'class'], default: 'off' }),
      f('session_grant_ttl', 'int', { min: 0, default: 0, help: 'Minutes; 0 = session lifetime.' }),
      f('enforcement', 'enum', { options: ['per-command', 'per-task'], default: 'per-task' }),
      f('chatter.enabled', 'bool', { default: false }),
      f('chatter.max_pokes', 'int', { min: 0, default: 3 }),
      f('chatter.daily_budget', 'int', { min: 0, default: 2 }),
      f('chatter.cooldown', 'duration', { default: '12h' }),
      f('chatter.reply_window', 'duration', { default: '24h' }),
      f('quiet.window', 'string', { default: '23:00-08:00', help: 'HH:MM-HH:MM' }),
      f('quiet.dream_cadence', 'duration', { default: '30m' }),
      f('quiet.resume_cooldown', 'duration', { default: '60m' }),
      f('quiet.dream_chance', 'float', { min: 0, max: 1, default: 0.5 }),
      f('quiet.dream_token_budget', 'int', { min: 0, default: 8000 }),
      f('quiet.nightly_dream_cap', 'int', { min: 0, default: 3 }),
      f('quiet.backoff', 'bool', { default: true }),
    ],
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    description: 'Scheduler, mission lock/stall/resume and the per-tick ledger. Hot-read at tick start.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('long_silence_factor', 'int', { min: 0, default: 3 }),
      f('log', 'string', { default: 'heartbeat.log', readOnly: true }),
      f('mission_stall_minutes', 'int', { min: 0, default: 10, help: '0 = watchdog off; cannot be off together with timeout.' }),
      f('mission_timeout_minutes', 'int', { min: 0, default: 0, help: '0 = no wall-clock ceiling.' }),
      f('mission_lock_stale_ms', 'int', { min: 0, default: 1800000, help: 'Lifted to at least 3× refresh.' }),
      f('mission_lock_refresh_ms', 'int', { min: 0, default: 60000 }),
      f('mission_summary_timeout_ms', 'int', { min: 0, default: 90000 }),
      f('mission_max_resumes', 'int', { min: 0, default: 3 }),
      ...rotation(),
    ],
  },
  {
    id: 'scheduler',
    label: 'Scheduler',
    description: 'SWRR work-kind weights and the legacy-priority rollback. Hot-read at tick start.',
    writable: true,
    restart: false,
    fields: [
      f('fair', 'bool', { default: true, help: 'true = smooth weighted round-robin; false = legacy static priority.' }),
      f('weights.mission', 'int', { min: 0, default: 4, help: 'Relative mission share. 0 disables the kind.' }),
      f('weights.drain-pass', 'int', { min: 0, default: 3, help: 'Relative drain share. 0 disables drain.' }),
      f('weights.quiet-hours', 'int', { min: 0, default: 1 }),
      f('weights.staleness', 'int', { min: 0, default: 1 }),
      f('weights.profile-update', 'int', { min: 0, default: 1 }),
      f('weights.soul-update', 'int', { min: 0, default: 1 }),
    ],
  },
  {
    id: 'drain',
    label: 'Drain',
    description: 'Cursor-backed conversation consolidation as a heartbeat work item. Hot-read.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('consumer', 'bool', { default: true }),
      f('cursor_file', 'string', { default: 'drain-cursor.json', readOnly: true }),
      f('writer_model', 'string', { default: '', help: 'Empty = agent default.' }),
      f('summarize_model', 'string', { default: '', help: 'Empty = agent default.' }),
      f('batch_sessions', 'int', { min: 1, default: 5 }),
      f('initial_lookback_hours', 'int', { min: 0, default: 24 }),
      f('max_turns_per_session', 'int', { min: 1, default: 40 }),
      f('max_session_bytes', 'int', { min: 0, default: 24000 }),
      f('max_items_per_session', 'int', { min: 1, default: 6 }),
      f('max_items_per_batch', 'int', { min: 1, default: 8 }),
      f('prefetch_candidates', 'int', { min: 0, default: 3 }),
      f('continuity_turns', 'int', { min: 0, default: 6 }),
      f('continuity_sessions', 'int', { min: 0, default: 20 }),
      f('poison_attempts', 'int', { min: 0, default: 3 }),
      f('drain_prompt_max_bytes', 'int', { min: 0, default: 60000 }),
      f('exclude_missions', 'list', { default: ['drain', 'staleness', 'dream'] }),
      f('trigger_pending', 'int', { min: 1, default: 12 }),
      f('trigger_max_age_hours', 'int', { min: 1, default: 2 }),
      f('settle_seconds', 'int', { min: 0, default: 120 }),
      f('poll_seconds', 'int', { min: 1, default: 60 }),
      f('max_wall_minutes', 'int', { min: 1, default: 15 }),
      f('token_budget', 'int', { min: 0, default: 80000 }),
      f('wake_token_budget', 'int', { min: 0, default: 250000 }),
      f('max_passes_per_wake', 'int', { min: 1, default: 6 }),
      f('lock_refresh_ms', 'int', { min: 1000, default: 60000 }),
      f('lock_stale_ms', 'int', { min: 1000, default: 180000 }),
      f('cursor_migration', 'enum', { options: ['carry', 'recover'], default: 'carry' }),
    ],
  },
  {
    id: 'mood',
    label: 'Mood',
    description: 'Feeling system. Hot-read.',
    writable: true,
    restart: false,
    fields: [
      f('dispatch_influence', 'bool', { default: true }),
      f('decay_half_life', 'duration', { default: '6h' }),
    ],
  },
  {
    id: 'comms',
    label: 'Comms',
    description: 'Notification / approval channels. Hot-read.',
    writable: true,
    restart: false,
    fields: [
      f('default_channel', 'enum', { options: ['telegram', 'email'], default: 'telegram' }),
      f('session_ttl', 'duration', { default: '24h' }),
      f('telegram.enabled', 'bool', { default: false }),
      f('telegram.bot_token_file', 'string', { default: '' }),
      f('telegram.chat_id_file', 'string', { default: '' }),
      f('email.enabled', 'bool', { default: false }),
      f('email.account', 'string', { default: '' }),
      f('email.reply_window_hours', 'int', { min: 0, default: 48 }),
    ],
  },
  {
    id: 'idea',
    label: 'Ideas',
    description: 'Daily idea draw, dedupe/review gate and expression spacing.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('bucket_file', 'string', { default: 'Ideas.md' }),
      f('daily_weights', 'string', { default: '25,55,20' }),
      f('category_weights', 'string', { default: '1,1,1' }),
      f('dedupe_threshold', 'float', { min: 0, max: 1, default: 0.6 }),
      f('review', 'bool', { default: true }),
      f('review_threshold', 'float', { min: 0, max: 1, default: 0.6 }),
      f('express_min_gap_hours', 'int', { min: 0, default: 48 }),
      f('log', 'string', { default: 'idea.log', readOnly: true }),
      ...rotation(),
    ],
  },
  {
    id: 'decisions',
    label: 'Decisions',
    description: 'Typed-decision JEV provider used by gates and idle choices.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('mode', 'enum', { options: ['shadow', 'gate'], default: 'gate' }),
      f('provider', 'enum', { options: ['rules', 'openjev'], default: 'openjev' }),
      f('backend', 'string', { default: 'clef-openrouter' }),
      f('model', 'string', { default: '' }),
      f('temperature_scaling', 'float', { min: 0, max: 2, default: 1 }),
      f('abstain_threshold', 'float', { min: 0, max: 1, default: 0.45 }),
      f('noul_threshold', 'float', { min: 0, max: 1, default: 0.8 }),
      f('timeout_ms', 'int', { min: 0, default: 30000 }),
      f('n_probs', 'int', { min: 1, default: 20 }),
      f('structured_max_tokens', 'int', { min: 0, default: 512 }),
      f('fallback', 'enum', { options: ['rules'], default: 'rules' }),
      f('ledger', 'string', { default: 'decisions.log', readOnly: true }),
      ...rotation(),
    ],
  },
  {
    id: 'retrieval',
    label: 'Retrieval',
    description: 'Per-turn Brain-First self-RAG gate. Fail-closed.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('gate', 'bool', { default: true }),
      f('noul_threshold', 'float', { min: 0, max: 1, default: 0.8 }),
      f('timeout_ms', 'int', { min: 0, default: 30000 }),
      f('max_bytes', 'int', { min: 0, default: 4000 }),
      f('summary_words', 'int', { min: 0, default: 400 }),
      f('force_intent', 'bool', { default: true }),
      f('inject', 'bool', { default: true }),
      f('prompts_file', 'string', { default: '.opencode/decision-prompts.yaml' }),
      f('log', 'string', { default: 'retrieval.log', readOnly: true }),
      ...rotation(),
    ],
  },
  {
    id: 'browser',
    label: 'Browser scan',
    description: 'Deterministic injection scan for webfetch/websearch. Read once at startup.',
    writable: true,
    restart: true,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('injection_policy', 'enum', { options: ['flag', 'block'], default: 'flag' }),
      f('max_scan_bytes', 'int', { min: 0, default: 200000 }),
      f('scan_log', 'string', { default: 'web-scan.log' }),
      ...rotation(),
    ],
  },
  {
    id: 'profile',
    label: 'Profile writer',
    description: 'Persona/user note injection and the idle profile-writer gate.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('agent_file', 'string', { default: 'Agent.md' }),
      f('user_file', 'string', { default: 'User.md' }),
      f('inject', 'bool', { default: true }),
      f('inject_max_bytes', 'int', { min: 0, default: 4000 }),
      f('refresh_every_turns', 'int', { min: 0, default: 5 }),
      f('decide', 'bool', { default: true }),
      f('cooldown_turns', 'int', { min: 0, default: 3 }),
      f('decision_turns', 'int', { min: 0, default: 3 }),
      f('decision_max_bytes', 'int', { min: 0, default: 24000 }),
      f('skip_triage', 'bool', { default: true }),
      f('skip_triage_max_bytes', 'int', { min: 0, default: 800 }),
      f('writer_agent', 'string', { default: 'profile-writer' }),
      f('child_timeout_ms', 'int', { min: 0, default: 90000 }),
      f('note_max_bytes', 'int', { min: 0, default: 6000 }),
      f('prompts_file', 'string', { default: '.opencode/profile-prompts.json' }),
      f('review', 'bool', { default: true }),
      f('review_threshold', 'float', { min: 0, max: 1, default: 0.6 }),
      f('log', 'string', { default: 'profile-hook.log', readOnly: true }),
      ...rotation(),
    ],
  },
  {
    id: 'soul',
    label: 'Soul writer',
    description: 'First-person identity, journal injection and fold-down writer.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('soul_file', 'string', { default: 'Soul.md' }),
      f('journal_file', 'string', { default: 'Agent Journal.md' }),
      f('inject', 'bool', { default: true }),
      f('inject_max_bytes', 'int', { min: 0, default: 4000 }),
      f('decide', 'bool', { default: true }),
      f('cooldown_turns', 'int', { min: 0, default: 3 }),
      f('journal_tail_bytes', 'int', { min: 0, default: 6000 }),
      f('writer_agent', 'string', { default: 'self-writer' }),
      f('child_timeout_ms', 'int', { min: 0, default: 90000 }),
      f('note_max_bytes', 'int', { min: 0, default: 6000 }),
      f('review', 'bool', { default: true }),
      f('review_threshold', 'float', { min: 0, max: 1, default: 0.6 }),
      f('log', 'string', { default: 'soul-hook.log', readOnly: true }),
      ...rotation(),
    ],
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    description: 'Delegation usage ledgers. Read once at startup.',
    writable: true,
    restart: true,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('watch_agents', 'list', { default: ['rag-search', 'safe-browser', 'deep-browser'] }),
      f('brain_log', 'string', { default: 'rag-search.log' }),
      f('web_log', 'string', { default: 'web-usage.log' }),
      ...rotation(),
    ],
  },
  {
    id: 'backlog',
    label: 'Backlog',
    description: 'Action queue store and the generated human view.',
    writable: true,
    restart: false,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('file', 'string', { default: 'backlog.ndjson' }),
      f('view_file', 'string', { default: 'Backlog.md' }),
      f('dedupe', 'bool', { default: true }),
      f('max_view', 'int', { min: 0, default: 200 }),
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Active memory provider. Restart opencode to apply.',
    writable: true,
    restart: true,
    fields: [
      f('provider', 'enum', { options: ['both', 'rag-brain', 'memory-explorer', 'none'], default: 'both' }),
    ],
  },
  {
    id: 'dashboard',
    label: 'Harness dashboard',
    description: 'The harness dashboard target (this console is a separate process). Hot-read by the harness.',
    writable: true,
    restart: true,
    fields: [
      f('bind_address', 'string', { default: '127.0.0.1', help: 'Loopback only; non-loopback is refused.' }),
      f('port', 'int', { min: 0, max: 65535, default: 0 }),
      f('serve_port', 'int', { min: 0, max: 65535, default: 0 }),
      f('serve_url', 'string', { default: '', help: 'Empty = live pointer; otherwise loopback only.' }),
      f('display_name', 'string', { default: '', help: 'Agent name shown in the console and run transcripts. Empty = project directory name.' }),
      f('accent', 'enum', { options: ['lime', 'amber', 'cyan', 'violet', 'rose'], default: 'lime', help: 'Console accent color. A pick made in the UI overrides it for that browser.' }),
      f('auth.mode', 'enum', { options: ['off', 'login', 'login+2fa'], default: 'off', readOnly: true }),
      f('auth.require_tls', 'bool', { default: false, readOnly: true }),
    ],
  },
  {
    id: 'audit',
    label: 'Audit',
    description: 'L5 command audit trail. Rotation is initialised once.',
    writable: false,
    restart: true,
    fields: [
      f('enabled', 'bool', { default: true }),
      f('log', 'string', { default: 'audit.log', readOnly: true }),
      ...rotation(),
    ],
  },
  {
    id: 'paths',
    label: 'Paths',
    description: 'Canonical roots. Edit the config file directly if these must move.',
    writable: false,
    restart: true,
    fields: [
      f('vault', 'string', { default: 'Brain', readOnly: true }),
      f('diagrams', 'string', { default: 'diagrams', readOnly: true }),
      f('log', 'string', { default: '.opencode/logs', readOnly: true }),
      f('state', 'string', { default: '.opencode/state', readOnly: true }),
    ],
  },
  {
    id: 'vault',
    label: 'Vault policy',
    description: 'Agent-forbidden, user-write-only vault folders.',
    writable: false,
    restart: false,
    fields: [f('readonly', 'list', { default: ['Journal'], readOnly: true })],
  },
];

export const FIELD_INDEX = new Map();
for (const section of SECTIONS) {
  for (const field of section.fields) {
    FIELD_INDEX.set(`${section.id}.${field.path}`, { section, field });
  }
}

const CONFIG_FILE = '.opencode/sysop-config.yaml';

export function configPath(dir) {
  return join(dir, CONFIG_FILE);
}

export function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export function readConfig(dir) {
  const file = configPath(dir);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { file, text: '', doc: parseDocument(''), data: {} };
  }
  const doc = parseDocument(text);
  const data = doc.toJS({ maxAliasCount: -1 }) ?? {};
  return { file, text, doc, data };
}

function humanize(path) {
  const text = path.replace(/[._]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function settingsResponse(dir) {
  const { file, data } = readConfig(dir);
  const sections = SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    description: section.description,
    writable: section.writable,
    restart: section.restart,
    fields: section.fields.map((field) => {
      const full = `${section.id}.${field.path}`;
      const current = getPath(data, full);
      return {
        path: full,
        key: field.path,
        label: field.label ?? humanize(field.path),
        type: field.type,
        value: current === undefined ? (field.default ?? null) : current,
        default: field.default ?? null,
        set: current !== undefined,
        options: field.options ?? null,
        min: field.min ?? null,
        max: field.max ?? null,
        allowOff: field.allowOff ?? false,
        help: field.help ?? '',
        readOnly: field.readOnly === true || !section.writable,
        restart: section.restart,
      };
    }),
  }));
  return { file, sections };
}

function validateField(entry, value, config) {
  const { section, field } = entry;
  const full = `${section.id}.${field.path}`;

  if (!section.writable) return { ok: false, reason: `${section.id} is read-only from the dashboard` };
  if (field.readOnly) return { ok: false, reason: `${full} is read-only` };

  switch (field.type) {
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, reason: `${full} must be true or false` };
      return { ok: true, value };
    case 'int':
      if (!Number.isInteger(value)) return { ok: false, reason: `${full} must be an integer` };
      if (field.min !== undefined && value < field.min) return { ok: false, reason: `${full} must be >= ${field.min}` };
      if (field.max !== undefined && value > field.max) return { ok: false, reason: `${full} must be <= ${field.max}` };
      return { ok: true, value };
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `${full} must be a number` };
      if (field.min !== undefined && value < field.min) return { ok: false, reason: `${full} must be >= ${field.min}` };
      if (field.max !== undefined && value > field.max) return { ok: false, reason: `${full} must be <= ${field.max}` };
      return { ok: true, value };
    case 'enum':
      if (!field.options.includes(value)) return { ok: false, reason: `${full} must be one of ${field.options.join(', ')}` };
      return { ok: true, value };
    case 'duration': {
      if (typeof value !== 'string') return { ok: false, reason: `${full} must be a duration string` };
      const trimmed = value.trim();
      if (field.allowOff && trimmed === 'off') return { ok: true, value: trimmed };
      if (!/^\d+[mh]$/.test(trimmed)) return { ok: false, reason: `${full} must look like 30m or 6h` };
      return { ok: true, value: trimmed };
    }
    case 'budget':
      if (value === 'unlimited') return { ok: true, value };
      if (!Number.isInteger(value) || value < 0) return { ok: false, reason: `${full} must be a non-negative integer or unlimited` };
      return { ok: true, value };
    case 'list': {
      const list = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value.split(',').map((s) => s.trim()).filter(Boolean)
          : null;
      if (!list) return { ok: false, reason: `${full} must be a list` };
      if (field.options && list.some((item) => !field.options.includes(item))) {
        return { ok: false, reason: `${full} contains an unsupported value` };
      }
      return { ok: true, value: list };
    }
    case 'string':
    default: {
      if (typeof value !== 'string') return { ok: false, reason: `${full} must be a string` };
      if (value.includes('\n') || value.includes('\r')) return { ok: false, reason: `${full} must be a single line` };
      if (full === 'dashboard.bind_address' && !['127.0.0.1', 'localhost', '::1'].includes(value.trim())) {
        return { ok: false, reason: 'dashboard.bind_address must stay loopback' };
      }
      if (full === 'dashboard.serve_url' && value.trim() !== '') {
        const url = value.trim();
        if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/.test(url)) {
          return { ok: false, reason: 'dashboard.serve_url must be empty or loopback' };
        }
      }
      return { ok: true, value };
    }
  }
}

function ensureContainers(doc, parts) {
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i);
    const node = doc.getIn(prefix);
    if (node === null || node === undefined || typeof node !== 'object' || typeof node.getIn !== 'function') {
      doc.setIn(prefix, doc.createNode({}));
    }
  }
}

function crossCheck(doc, full, value) {
  const data = doc.toJS({ maxAliasCount: -1 }) ?? {};
  const currentLevel = getPath(data, 'autonomy.level');
  if (full === 'autonomy.level' && typeof currentLevel === 'number' && value > currentLevel) {
    return 'raising autonomy.level requires auth login+2fa (currently off)';
  }
  if (full === 'heartbeat.mission_lock_refresh_ms' || full === 'heartbeat.mission_lock_stale_ms') {
    const refresh = full.endsWith('refresh_ms') ? value : getPath(data, 'heartbeat.mission_lock_refresh_ms') ?? 60000;
    const stale = full.endsWith('stale_ms') ? value : getPath(data, 'heartbeat.mission_lock_stale_ms') ?? 1800000;
    if (stale < refresh * 3) return 'mission_lock_stale_ms must be at least 3× mission_lock_refresh_ms';
  }
  if (full === 'heartbeat.mission_stall_minutes' || full === 'heartbeat.mission_timeout_minutes') {
    const stall = full.endsWith('stall_minutes') ? value : getPath(data, 'heartbeat.mission_stall_minutes') ?? 10;
    const timeout = full.endsWith('timeout_minutes') ? value : getPath(data, 'heartbeat.mission_timeout_minutes') ?? 0;
    if (stall === 0 && timeout === 0) return 'stall and timeout cannot both be off';
  }
  if (full.startsWith('scheduler.weights.')) {
    const weights = getPath(data, 'scheduler.weights') ?? {};
    const next = { ...weights, [full.slice('scheduler.weights.'.length)]: value };
    if (Object.values(next).every((w) => typeof w !== 'number' || w <= 0)) {
      return 'at least one scheduler weight must be > 0';
    }
  }
  if (full === 'drain.lock_stale_ms' || full === 'drain.lock_refresh_ms') {
    const refresh = full.endsWith('refresh_ms') ? value : getPath(data, 'drain.lock_refresh_ms') ?? 60000;
    const stale = full.endsWith('stale_ms') ? value : getPath(data, 'drain.lock_stale_ms') ?? 180000;
    if (stale < refresh) return 'drain.lock_stale_ms must be at least lock_refresh_ms';
  }
  return null;
}

export function applySettings(dir, updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, status: 400, error: 'no updates' };
  }
  if (updates.length > 100) return { ok: false, status: 400, error: 'too many updates' };

  const { file, text, doc } = readConfig(dir);
  if (!text) return { ok: false, status: 404, error: 'sysop-config.yaml not found' };

  const applied = [];
  for (const update of updates) {
    if (!update || typeof update.path !== 'string' || !('value' in update)) {
      return { ok: false, status: 400, error: 'each update needs path and value' };
    }
    const entry = FIELD_INDEX.get(update.path);
    if (!entry) return { ok: false, status: 400, error: `unknown setting: ${update.path}` };
    const checked = validateField(entry, update.value, doc.toJS());
    if (!checked.ok) return { ok: false, status: 400, error: checked.reason };
    const cross = crossCheck(doc, update.path, checked.value);
    if (cross) return { ok: false, status: 400, error: cross };

    const parts = update.path.split('.');
    ensureContainers(doc, parts);
    doc.setIn(parts, checked.value);
    applied.push({ path: update.path, value: checked.value });
  }

  // Re-check cross-field invariants against the fully mutated document.
  const finalDoc = doc;
  const data = finalDoc.toJS({ maxAliasCount: -1 }) ?? {};
  const stale = getPath(data, 'heartbeat.mission_lock_stale_ms');
  const refresh = getPath(data, 'heartbeat.mission_lock_refresh_ms');
  if (typeof stale === 'number' && typeof refresh === 'number' && stale < refresh * 3) {
    return { ok: false, status: 400, error: 'mission_lock_stale_ms must be at least 3× mission_lock_refresh_ms' };
  }
  const schedulerWeights = getPath(data, 'scheduler.weights');
  if (schedulerWeights && typeof schedulerWeights === 'object') {
    const values = Object.values(schedulerWeights).filter((w) => typeof w === 'number');
    if (values.length > 0 && values.every((w) => w <= 0)) {
      return { ok: false, status: 400, error: 'at least one scheduler weight must be > 0' };
    }
  }

  const rendered = finalDoc.toString();
  const tmp = `${file}.tmp-${process.pid}`;
  let mode = 0o600;
  try { mode = statSync(file).mode & 0o777; } catch { /* keep 600 */ }
  try {
    writeFileSync(tmp, rendered, { encoding: 'utf8', mode });
    renameSync(tmp, file);
  } catch (err) {
    try { writeFileSync(file, text, 'utf8'); } catch { /* best effort */ }
    return { ok: false, status: 500, error: `write failed: ${err.message}` };
  }

  try {
    mkdirSync(dirname(join(dir, '.opencode/logs/dashboard.log')), { recursive: true });
    appendFileSync(
      join(dir, '.opencode/logs/dashboard.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), event: 'settings', updates: applied })}\n`,
    );
  } catch { /* logging must not fail the write */ }

  return { ok: true, applied };
}

/* ------------------------------------------------------------------ missions */

function readFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  try {
    const doc = parseDocument(text.slice(3, end));
    return doc.toJS({ maxAliasCount: -1 }) ?? {};
  } catch {
    return {};
  }
}

const FREQ_RANK = { high: 1, mid: 2, low: 3 };

export function readMissions(dir) {
  const { data } = readConfig(dir);
  const overlayAll = data?.autonomy?.missions ?? {};
  const missionDir = join(dir, '.opencode/missions');
  let files = [];
  try {
    files = readdirSync(missionDir);
  } catch {
    files = [];
  }

  const missions = files
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const id = name.slice(0, -3);
      let text = '';
      try { text = readFileSync(join(missionDir, name), 'utf8'); } catch { return null; }
      const fm = readFrontmatter(text);
      const fileEnabled = fm.enabled !== false;
      const base = {
        id,
        title: typeof fm.title === 'string' ? fm.title : id,
        frequency: ['high', 'mid', 'low'].includes(fm.frequency) ? fm.frequency : 'mid',
        menus: Array.isArray(fm.menus) ? fm.menus : ['day'],
        min_level: typeof fm.min_level === 'number' ? fm.min_level : 0,
        approval: typeof fm.approval === 'string' ? fm.approval : 'n/a',
        candidacy: typeof fm.candidacy === 'string' ? fm.candidacy : 'always',
        agent: typeof fm.agent === 'string' ? fm.agent : '',
        file_enabled: fileEnabled,
        file_min_level: typeof fm.min_level === 'number' ? fm.min_level : 0,
        file_frequency: ['high', 'mid', 'low'].includes(fm.frequency) ? fm.frequency : 'mid',
      };
      const overlay = overlayAll[id] ?? null;
      const effective = { ...base };
      const rejects = [];
      if (overlay) {
        if (overlay.enabled === false) effective.enabled = false;
        else if (overlay.enabled === true && !fileEnabled) {
          rejects.push('overlay cannot enable a file-disabled mission');
        }
        if (typeof overlay.min_level === 'number') {
          if (overlay.min_level > base.min_level) effective.min_level = overlay.min_level;
          else if (overlay.min_level < base.min_level) rejects.push('min_level may only be raised');
        }
        if (typeof overlay.frequency === 'string' && overlay.frequency !== base.frequency) {
          if ((FREQ_RANK[overlay.frequency] ?? 0) > (FREQ_RANK[base.frequency] ?? 0)) effective.frequency = overlay.frequency;
          else rejects.push('frequency may only move toward low');
        }
        if (Array.isArray(overlay.menus)) {
          const fileWin = new Set(base.menus.includes('both') ? ['day', 'night'] : base.menus);
          const wanted = overlay.menus.includes('both') ? ['day', 'night'] : overlay.menus;
          if (wanted.some((m) => !fileWin.has(m))) rejects.push('menus may only be narrowed');
          else effective.menus = wanted;
        }
      }
      effective.enabled = fileEnabled && effective.enabled !== false;
      return {
        ...effective,
        base_menus: base.menus,
        enabled: effective.enabled,
        overlay,
        overlay_rejects: rejects,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));

  return missions;
}

export function updateMission(dir, body) {
  const { file, text, doc } = readConfig(dir);
  if (!text) return { ok: false, status: 404, error: 'sysop-config.yaml not found' };
  const mission = readMissions(dir).find((m) => m.id === body?.id);
  if (!mission) return { ok: false, status: 404, error: `unknown mission: ${body?.id}` };

  const warnings = [];
  if (typeof body.enabled === 'boolean') {
    if (body.enabled && !mission.file_enabled) {
      return { ok: false, status: 400, error: 'overlay cannot enable a mission the file disables' };
    }
    if (body.enabled) {
      doc.deleteIn(['autonomy', 'missions', mission.id, 'enabled']);
    } else {
      ensureContainers(doc, ['autonomy', 'missions', mission.id]);
      doc.setIn(['autonomy', 'missions', mission.id, 'enabled'], false);
    }
  }

  if (body.min_level !== undefined) {
    if (!Number.isInteger(body.min_level) || body.min_level < 0 || body.min_level > 4) {
      return { ok: false, status: 400, error: 'min_level must be 0..4' };
    }
    if (body.min_level < mission.file_min_level) {
      return { ok: false, status: 400, error: `min_level may only be raised (file: ${mission.file_min_level})` };
    }
    if (body.min_level === mission.file_min_level) {
      doc.deleteIn(['autonomy', 'missions', mission.id, 'min_level']);
    } else {
      ensureContainers(doc, ['autonomy', 'missions', mission.id]);
      doc.setIn(['autonomy', 'missions', mission.id, 'min_level'], body.min_level);
    }
  }

  if (body.frequency !== undefined) {
    if (!['high', 'mid', 'low'].includes(body.frequency)) {
      return { ok: false, status: 400, error: 'frequency must be high, mid or low' };
    }
    if ((FREQ_RANK[body.frequency] ?? 0) < (FREQ_RANK[mission.file_frequency] ?? 0)) {
      return { ok: false, status: 400, error: `frequency may only move toward low (file: ${mission.file_frequency})` };
    }
    if (body.frequency === mission.file_frequency) {
      doc.deleteIn(['autonomy', 'missions', mission.id, 'frequency']);
    } else {
      ensureContainers(doc, ['autonomy', 'missions', mission.id]);
      doc.setIn(['autonomy', 'missions', mission.id, 'frequency'], body.frequency);
    }
  }

  if (body.menus !== undefined) {
    const wanted = Array.isArray(body.menus) ? body.menus : [];
    if (wanted.some((m) => !['day', 'night', 'both'].includes(m))) {
      return { ok: false, status: 400, error: 'menus must be day, night or both' };
    }
    const width = (list) => (list.includes('both') ? ['day', 'night'] : list);
    const base = new Set(width(mission.base_menus));
    if (width(wanted).some((m) => !base.has(m))) {
      return { ok: false, status: 400, error: `menus may only be narrowed (file: ${mission.base_menus.join(', ')})` };
    }
    const baseWidth = width(mission.base_menus);
    if (wanted.length === baseWidth.length && wanted.every((m) => baseWidth.includes(m))) {
      doc.deleteIn(['autonomy', 'missions', mission.id, 'menus']);
    } else {
      ensureContainers(doc, ['autonomy', 'missions', mission.id]);
      doc.setIn(['autonomy', 'missions', mission.id, 'menus'], wanted);
    }
  }

  // Drop an empty mission block so the config stays clean.
  const block = doc.getIn(['autonomy', 'missions', mission.id]);
  if (block && typeof block.toJSON === 'function' && Object.keys(block.toJSON() ?? {}).length === 0) {
    doc.deleteIn(['autonomy', 'missions', mission.id]);
  }

  const rendered = doc.toString();
  const tmp = `${file}.tmp-${process.pid}`;
  let mode = 0o600;
  try { mode = statSync(file).mode & 0o777; } catch { /* keep 600 */ }
  try {
    writeFileSync(tmp, rendered, { encoding: 'utf8', mode });
    renameSync(tmp, file);
  } catch (err) {
    return { ok: false, status: 500, error: `write failed: ${err.message}` };
  }

  try {
    mkdirSync(dirname(join(dir, '.opencode/logs/dashboard.log')), { recursive: true });
    appendFileSync(
      join(dir, '.opencode/logs/dashboard.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), event: 'mission', id: mission.id, patch: body })}\n`,
    );
  } catch { /* logging must not fail the write */ }

  return { ok: true, mission: readMissions(dir).find((m) => m.id === mission.id), warnings };
}
