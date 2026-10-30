import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiService, errorText } from './api';
import { fmtDuration } from './format';
import { mapSessionMessages } from './transcript-map';
import {
  Activity,
  Backlog,
  CostReport,
  Drain,
  ErrorReport,
  Health,
  Heartbeat,
  Idea,
  LedgerInfo,
  LockInfo,
  Mission,
  Mood,
  Overview,
  QueueWait,
  Queues,
  RunRow,
  SettingsSnapshot,
  Sleep,
  Throughput,
  TokenSeries,
  TranscriptEntry,
} from './models';

export type Scope = 'flight' | 'metrics' | 'queues' | 'missions' | 'logs' | 'setup';

const SCOPES: Scope[] = ['flight', 'metrics', 'queues', 'missions', 'logs', 'setup'];
const POLLING_SCOPES = new Set<Scope>(['flight', 'metrics', 'queues', 'missions']);

export function scopeForUrl(url: string): Scope {
  const path = url.split('?')[0].split('/').filter(Boolean)[0] ?? 'flight';
  return (SCOPES as string[]).includes(path) ? (path as Scope) : 'flight';
}

@Injectable({ providedIn: 'root' })
export class DashboardStore {
  private readonly api = inject(ApiService);

  readonly online = signal(false);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly now = signal(Date.now());
  readonly lastUpdated = signal<number | null>(null);
  readonly refreshing = signal(false);

  /** Number of blocking (non-poll) HTTP loads in flight; > 0 shows the overlay. */
  readonly blockingCount = signal(0);
  readonly blockingLabel = signal('loading…');

  readonly health = signal<Health | null>(null);
  readonly overview = signal<Overview | null>(null);
  readonly heartbeat = signal<Heartbeat | null>(null);
  readonly mood = signal<Mood | null>(null);
  readonly sleep = signal<Sleep | null>(null);
  readonly idea = signal<Idea | null>(null);
  readonly queues = signal<Queues | null>(null);
  readonly drain = signal<Drain | null>(null);
  readonly runs = signal<RunRow[]>([]);
  readonly tokens = signal<TokenSeries | null>(null);
  readonly cost = signal<CostReport | null>(null);
  readonly errors = signal<ErrorReport | null>(null);
  readonly throughput = signal<Throughput | null>(null);
  readonly queueWait = signal<QueueWait | null>(null);
  readonly activity = signal<Activity | null>(null);
  readonly settings = signal<SettingsSnapshot | null>(null);
  readonly missions = signal<Mission[]>([]);
  readonly backlog = signal<Backlog | null>(null);
  readonly ledgers = signal<LedgerInfo[]>([]);
  readonly locks = signal<LockInfo[]>([]);
  readonly transcript = signal<TranscriptEntry[]>([]);

  readonly ledgerEntries = signal<Record<string, string[]>>({});
  readonly selectedLedger = signal<string>('heartbeat.log');
  readonly ledgerLoading = signal(false);

  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private coreTimer: ReturnType<typeof setInterval> | null = null;
  private stripTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private scopeTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private activeScope: Scope | null = null;
  private loadingScope: Scope | null = null;
  private lastSession: string | null = null;

  /** Persona name for the console; config-driven, project-dir fallback. */
  readonly displayName = computed(() => this.health()?.display_name?.trim() || 'agent');
  readonly current = computed(() => this.heartbeat()?.current ?? null);
  readonly schedule = computed(() => this.heartbeat()?.schedule ?? null);
  readonly level = computed(() => this.heartbeat()?.schedule.level ?? null);
  readonly running = computed(() => this.queues()?.running ?? this.current());
  readonly queueItems = computed(() => this.queues()?.items ?? []);
  readonly queueDepth = computed(() => this.queues()?.total ?? 0);
  readonly oldestQueue = computed(() => this.queues()?.oldest_ms ?? 0);
  readonly lastRun = computed(() => this.runs()[0] ?? this.overview()?.last_run ?? null);
  readonly budget = computed(() => this.tokens()?.budget_per_run ?? this.overview()?.budget_per_run ?? null);
  readonly lastTokens = computed(() => this.lastRun()?.token_cost ?? this.overview()?.last_tokens ?? null);
  readonly burnTotal = computed(() => this.tokens()?.totals.tokens ?? 0);
  readonly burnSpark = computed(() => this.tokens()?.points.map((p) => p.tokens) ?? []);
  readonly costSpark = computed(() => this.tokens()?.points.map((p) => p.cost) ?? []);
  readonly drainLag = computed(() => this.drain()?.oldest_pending_age_ms ?? null);
  readonly drainSpark = computed(() => this.drain()?.series?.map((point) => point.pending ?? 0) ?? []);
  readonly pendingTurns = computed(() => this.drain()?.pending ?? 0);
  readonly overruns = computed(() => this.tokens()?.totals.over_runs ?? 0);
  readonly cadence = computed(() => this.schedule()?.interval_ms ?? null);
  readonly cadenceSpark = computed(() => this.throughput()?.points.map((p) => p.p50 ?? 0) ?? []);
  readonly overrunSpark = computed(() => this.tokens()?.points.map((p) => p.over_runs) ?? []);
  readonly errorSpark = computed(() => this.errors()?.series?.map((p) => p.errors) ?? []);
  readonly costTotal = computed(() => this.cost()?.total ?? this.overview()?.cost.total_24h ?? 0);
  readonly costPerRun = computed(() => this.cost()?.avg_per_run ?? this.overview()?.cost.avg_per_run ?? null);
  readonly errorRate = computed(() => this.errors()?.runs.rate ?? this.overview()?.errors.rate ?? 0);
  readonly errorCount = computed(() => this.errors()?.runs.errors ?? this.overview()?.errors.errors ?? 0);
  readonly runCount = computed(() => this.errors()?.runs.total ?? this.overview()?.errors.total ?? 0);
  readonly moodLabel = computed(() => this.mood()?.label ?? 'unknown');
  readonly quiet = computed(() => this.sleep()?.quiet ?? false);

  readonly updatedLabel = computed(() => {
    const ts = this.lastUpdated();
    if (!ts) return '—';
    const delta = Math.max(0, this.now() - ts);
    return delta < 1500 ? 'now' : `${Math.floor(delta / 1000)}s ago`;
  });

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.clockTimer = setInterval(() => this.now.set(Date.now()), 1000);
    await this.tryConnect();
  }

  stop(): void {
    for (const timer of [
      this.clockTimer,
      this.coreTimer,
      this.stripTimer,
      this.healthTimer,
      this.scopeTimer,
    ]) {
      if (timer !== null) clearInterval(timer);
    }
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.clockTimer =
      this.coreTimer =
      this.stripTimer =
      this.healthTimer =
      this.scopeTimer =
      this.retryTimer =
        null;
    this.started = false;
    this.activeScope = null;
    this.loadingScope = null;
  }

  /** Route entry point: reloads the scope's data (blocking) and retargets its poller. */
  async setScope(scope: Scope): Promise<void> {
    const changed = this.activeScope !== scope;
    this.activeScope = scope;
    this.retargetScopeTimer();
    if (!changed || !this.started || !this.online()) return;
    await this.reloadScope(scope);
  }

  private async tryConnect(): Promise<void> {
    try {
      const health = await this.api.health();
      this.health.set(health);
      this.online.set(true);
      this.error.set(null);
      this.loading.set(false);
      await this.blocking('connecting…', async () => {
        await this.loadCore();
        await this.loadStrip();
        if (this.activeScope !== null) await this.loadScope(this.activeScope);
      });
      this.startTimers();
    } catch (err) {
      this.online.set(false);
      this.loading.set(false);
      this.error.set(errorText(err));
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryConnect();
    }, 4000);
  }

  private startTimers(): void {
    if (this.coreTimer !== null) return;
    this.coreTimer = setInterval(() => void this.loadCore(), 2000);
    this.stripTimer = setInterval(() => void this.loadStrip(), 15000);
    this.healthTimer = setInterval(() => void this.checkHealth(), 10000);
    this.startScopeTimer();
  }

  private stopTimers(): void {
    for (const timer of [this.coreTimer, this.stripTimer, this.healthTimer, this.scopeTimer]) {
      if (timer !== null) clearInterval(timer);
    }
    this.coreTimer = this.stripTimer = this.healthTimer = this.scopeTimer = null;
  }

  private startScopeTimer(): void {
    if (this.scopeTimer !== null) return;
    const scope = this.activeScope;
    if (scope === null || !POLLING_SCOPES.has(scope)) return;
    this.scopeTimer = setInterval(() => {
      const active = this.activeScope;
      if (active !== null && POLLING_SCOPES.has(active)) void this.loadScope(active);
    }, 5000);
  }

  private retargetScopeTimer(): void {
    if (this.scopeTimer !== null) {
      clearInterval(this.scopeTimer);
      this.scopeTimer = null;
    }
    if (this.started && this.online()) this.startScopeTimer();
  }

  private async checkHealth(): Promise<void> {
    try {
      const health = await this.api.health();
      this.health.set(health);
      if (!this.online()) {
        this.online.set(true);
        this.error.set(null);
        await this.blocking('reconnecting…', async () => {
          await this.loadCore();
          await this.loadStrip();
          if (this.activeScope !== null) await this.loadScope(this.activeScope);
        });
        this.startTimers();
      }
    } catch (err) {
      this.online.set(false);
      this.error.set(errorText(err));
      this.stopTimers();
      this.scheduleRetry();
    }
  }

  async reload(): Promise<void> {
    this.refreshing.set(true);
    try {
      if (!this.online()) {
        await this.tryConnect();
        return;
      }
      await this.blocking('reloading…', async () => {
        await Promise.all([this.loadCore(), this.loadStrip()]);
        if (this.activeScope !== null) await this.loadScope(this.activeScope);
      });
    } finally {
      this.refreshing.set(false);
    }
  }

  /** Blocking wrapper: increments the overlay counter for non-poll loads only. */
  private async blocking<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.blockingLabel.set(label);
    this.blockingCount.update((n) => n + 1);
    try {
      return await fn();
    } finally {
      this.blockingCount.update((n) => Math.max(0, n - 1));
    }
  }

  private async reloadScope(scope: Scope): Promise<void> {
    if (this.loadingScope === scope) return;
    this.loadingScope = scope;
    try {
      await this.blocking(`loading · ${scope}…`, () => this.loadScope(scope));
    } finally {
      if (this.loadingScope === scope) this.loadingScope = null;
    }
  }

  /** Core group: always loaded, polled every 2s (never blocking). */
  async loadCore(): Promise<void> {
    const [heartbeat, queues, drain, mood] = await Promise.allSettled([
      this.api.heartbeat(),
      this.api.queues(),
      this.api.drain(),
      this.api.mood(),
    ]);
    if (heartbeat.status === 'fulfilled') this.heartbeat.set(heartbeat.value);
    if (queues.status === 'fulfilled') this.queues.set(queues.value);
    if (drain.status === 'fulfilled') this.drain.set(drain.value);
    if (mood.status === 'fulfilled') this.mood.set(mood.value);
    this.lastUpdated.set(Date.now());
  }

  /** Strip group: status-strip metrics, polled every 15s (never blocking). */
  async loadStrip(): Promise<void> {
    const [overview, tokens, cost, errors, queueWait, throughput] = await Promise.allSettled([
      this.api.overview(),
      this.api.tokens(24, 'hour'),
      this.api.cost(24),
      this.api.errors(24),
      this.api.queueWait(),
      this.api.throughput(24),
    ]);
    if (overview.status === 'fulfilled') this.overview.set(overview.value);
    if (tokens.status === 'fulfilled') this.tokens.set(tokens.value);
    if (cost.status === 'fulfilled') this.cost.set(cost.value);
    if (errors.status === 'fulfilled') this.errors.set(errors.value);
    if (queueWait.status === 'fulfilled') this.queueWait.set(queueWait.value);
    if (throughput.status === 'fulfilled') this.throughput.set(throughput.value);
    this.lastUpdated.set(Date.now());
  }

  /** Per-scope group: fetched when its page opens (blocking) and while active (poll, silent). */
  async loadScope(scope: Scope): Promise<void> {
    switch (scope) {
      case 'flight': {
        const [activity, sleep, idea, backlog] = await Promise.allSettled([
          this.api.activity(6),
          this.api.sleep(),
          this.api.idea(),
          this.api.backlog(100),
        ]);
        if (activity.status === 'fulfilled') this.activity.set(activity.value);
        if (sleep.status === 'fulfilled') this.sleep.set(sleep.value);
        if (idea.status === 'fulfilled') this.idea.set(idea.value);
        if (backlog.status === 'fulfilled') this.backlog.set(backlog.value);
        await this.pollTranscript();
        break;
      }
      case 'metrics': {
        const [runs, tokens, cost, errors] = await Promise.allSettled([
          this.runsSnapshot(),
          this.api.tokens(24, 'hour'),
          this.api.cost(24),
          this.api.errors(24),
        ]);
        if (runs.status === 'fulfilled') this.runs.set(runs.value.runs);
        if (tokens.status === 'fulfilled') this.tokens.set(tokens.value);
        if (cost.status === 'fulfilled') this.cost.set(cost.value);
        if (errors.status === 'fulfilled') this.errors.set(errors.value);
        break;
      }
      case 'queues': {
        const [queues, runs, missions] = await Promise.allSettled([
          this.api.queues(),
          this.runsSnapshot(),
          this.api.missions(),
        ]);
        if (queues.status === 'fulfilled') this.queues.set(queues.value);
        if (runs.status === 'fulfilled') this.runs.set(runs.value.runs);
        if (missions.status === 'fulfilled') this.missions.set(missions.value.missions);
        break;
      }
      case 'missions': {
        const [missions, runs] = await Promise.allSettled([this.api.missions(), this.runsSnapshot()]);
        if (missions.status === 'fulfilled') this.missions.set(missions.value.missions);
        if (runs.status === 'fulfilled') this.runs.set(runs.value.runs);
        break;
      }
      case 'logs': {
        const ledgers = await Promise.allSettled([this.api.ledgers()]);
        if (ledgers[0].status === 'fulfilled') this.ledgers.set(ledgers[0].value.ledgers);
        break;
      }
      case 'setup': {
        const [settings, locks] = await Promise.allSettled([this.api.settings(), this.api.locks()]);
        if (settings.status === 'fulfilled') this.settings.set(settings.value);
        if (locks.status === 'fulfilled') this.locks.set(locks.value.locks);
        break;
      }
    }
    this.lastUpdated.set(Date.now());
  }

  private runsSnapshot(): ReturnType<ApiService['runs']> {
    return this.api.runs({ limit: 120, hours: 24 });
  }

  async pollTranscript(): Promise<void> {
    const directory = this.health()?.directory;
    if (!directory) return;
    const session =
      this.current()?.session ??
      this.current()?.side_session ??
      this.lastRun()?.session ??
      this.lastSession;
    if (!session) return;
    this.lastSession = session;
    try {
      const rows = await this.api.sessionMessages(session, directory);
      if (rows.length) this.transcript.set(mapSessionMessages(rows, this.displayName()));
    } catch {
      /* keep the last transcript */
    }
  }

  async saveSettings(updates: Array<{ path: string; value: unknown }>): Promise<number> {
    return this.blocking('saving settings…', async () => {
      const result = await this.api.saveSettings(updates);
      this.settings.set(result.settings);
      await this.loadScope('setup');
      return result.applied.length;
    });
  }

  async saveMission(body: {
    id: string;
    enabled?: boolean;
    min_level?: number;
    frequency?: string;
    menus?: string[];
  }): Promise<Mission> {
    return this.blocking('saving mission…', async () => {
      const result = await this.api.saveMission(body);
      this.missions.set(result.missions);
      await this.loadScope('missions');
      return result.mission;
    });
  }

  /** Silent (non-blocking) missions refresh for the command palette. */
  async ensureMissions(): Promise<void> {
    try {
      const result = await this.api.missions();
      this.missions.set(result.missions);
    } catch {
      /* offline or racing; palette shows whatever is cached */
    }
  }

  async loadLedger(name: string): Promise<void> {
    this.selectedLedger.set(name);
    this.ledgerLoading.set(true);
    try {
      const page = await this.api.ledger(name, 400);
      const lines = (page.entries as unknown[]).map((entry) => JSON.stringify(entry));
      this.ledgerEntries.update((map) => ({ ...map, [name]: lines }));
    } catch {
      this.ledgerEntries.update((map) => ({ ...map, [name]: [] }));
    } finally {
      this.ledgerLoading.set(false);
    }
  }

  selectLedger(name: string): void {
    void this.loadLedger(name);
  }

  tickRemaining(): string {
    const next = this.schedule()?.next_tick;
    if (!next) return '—';
    const delta = new Date(next).getTime() - this.now();
    return delta <= 0 ? 'due' : fmtDuration(delta);
  }
}
