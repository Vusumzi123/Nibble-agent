import { Component, OnInit, computed, inject, signal } from '@angular/core';

import { ApiService, errorText } from '../../core/api.service';
import { fmtDuration, fmtNumber, fmtTime, fmtTokens } from '../../core/format';
import { DrainSnapshot, HeartbeatTick, TokenBucket, TokenPoint, TokenSeries } from '../../core/models';
import { DashboardStore } from '../../core/store';

interface MissionStat {
  mission: string;
  count: number;
  tokens: number;
  completed: number;
  failed: number;
}

interface Cadence {
  avg: number;
  min: number;
  max: number;
  n: number;
}

interface ChartBar {
  x: number;
  y: number;
  h: number;
  w: number;
  refY: number | null;
  point: TokenPoint;
}

interface Chart {
  width: number;
  height: number;
  baseline: number;
  bars: ChartBar[];
}

@Component({
  selector: 'app-metrics-page',
  templateUrl: './metrics.html',
  styleUrl: './metrics.css',
})
export class MetricsPage implements OnInit {
  protected readonly store = inject(DashboardStore);
  private readonly api = inject(ApiService);

  protected readonly series = signal<TokenSeries | null>(null);
  protected readonly seriesError = signal<string | null>(null);
  protected readonly seriesLoading = signal(false);

  // Drain consumer health (plan §6.2): current pending/oldest-age/next-due.
  // The historical series lives in drain.log; this is the live readout.
  protected readonly drain = signal<DrainSnapshot | null>(null);

  protected readonly bucket = signal<TokenBucket>('hour');
  protected readonly hours = signal<number>(24);
  protected readonly lane = signal<'all' | 'primary' | 'side' | 'drain'>('all');
  protected readonly mission = signal<string>('');
  protected readonly missionType = signal<string>('');

  protected readonly buckets: TokenBucket[] = ['tick', 'hour', 'day'];
  protected readonly lanes: Array<'all' | 'primary' | 'side' | 'drain'> = ['all', 'primary', 'side', 'drain'];
  protected readonly ranges = [
    { hours: 24, label: '24 h' },
    { hours: 24 * 7, label: '7 d' },
    { hours: 24 * 30, label: '30 d' },
  ];

  ngOnInit(): void {
    void this.loadSeries();
    void this.loadDrain();
  }

  /** Template helper for "due now" checks (Angular templates can't call Date). */
  protected readonly now = (): number => Date.now();

  protected async loadDrain(): Promise<void> {
    try {
      this.drain.set(await this.api.drain());
    } catch {
      this.drain.set(null); // older backend — strip hidden
    }
  }

  protected async loadSeries(): Promise<void> {
    if (this.seriesLoading()) return;
    this.seriesLoading.set(true);
    try {
      const snapshot = await this.api.tokens({
        bucket: this.bucket(),
        hours: this.hours(),
        ...(this.lane() === 'all' ? {} : { lane: this.lane() }),
        ...(this.mission() === '' ? {} : { mission: this.mission() }),
        ...(this.missionType() === '' ? {} : { type: this.missionType() }),
      });
      this.series.set(snapshot);
      this.seriesError.set(snapshot.available ? null : (snapshot.error ?? 'token series unavailable'));
    } catch (err) {
      this.series.set(null);
      this.seriesError.set(errorText(err));
    } finally {
      this.seriesLoading.set(false);
    }
  }

  protected setBucket(bucket: TokenBucket): void {
    if (this.bucket() === bucket) return;
    this.bucket.set(bucket);
    void this.loadSeries();
  }

  protected setHours(hours: number): void {
    if (this.hours() === hours) return;
    this.hours.set(hours);
    void this.loadSeries();
  }

  protected setLane(lane: 'all' | 'primary' | 'side' | 'drain'): void {
    if (this.lane() === lane) return;
    this.lane.set(lane);
    void this.loadSeries();
  }

  protected setMission(mission: string): void {
    if (this.mission() === mission) return;
    this.mission.set(mission);
    void this.loadSeries();
  }

  protected readonly missionTypes = computed(() => {
    const seen = new Set<string>();
    for (const m of this.store.missions()?.missions ?? []) {
      if (m.frequency) seen.add(m.frequency);
    }
    return [...seen].sort();
  });

  protected setMissionType(type: string): void {
    if (this.missionType() === type) return;
    this.missionType.set(type);
    void this.loadSeries();
  }

  protected readonly chart = computed<Chart | null>(() => {
    const s = this.series();
    if (!s || s.points.length === 0) return null;
    const width = 720;
    const height = 200;
    const padX = 8;
    const padTop = 10;
    const baseline = height - 24;
    const plotH = baseline - padTop;
    const n = s.points.length;
    const gap = 2;
    const barW = Math.max(2, (width - padX * 2 - gap * (n - 1)) / n);
    const budget = s.budget_per_run;
    const max = Math.max(
      1,
      ...s.points.map((p) => Math.max(p.tokens, budget === null ? 0 : budget * p.runs)),
    );
    const bars: ChartBar[] = s.points.map((p, i) => {
      const x = padX + i * (barW + gap);
      const h = (p.tokens / max) * plotH;
      const ref = budget === null ? null : (budget * p.runs) / max * plotH;
      return { x, y: baseline - h, h, w: barW, refY: ref === null ? null : baseline - ref, point: p };
    });
    return { width, height, baseline, bars };
  });

  protected chartLabel(point: TokenPoint): string {
    const label = this.bucket() === 'tick' ? `tick ${point.tick ?? '—'}` : point.bucket;
    return `${label} · ${fmtTokens(point.tokens)} tokens · ${point.runs} run(s)${point.over_runs ? ` · ${point.over_runs} over budget` : ''}`;
  }


  protected readonly fmtTime = fmtTime;
  protected readonly fmtDuration = fmtDuration;
  protected readonly fmtNumber = fmtNumber;
  protected readonly fmtTokens = fmtTokens;

  private readonly ticks = computed<HeartbeatTick[]>(() => this.store.ticks());

  protected readonly totalTokens = computed(() =>
    this.ticks().reduce((sum, t) => sum + (typeof t.token_cost === 'number' ? t.token_cost : 0), 0),
  );

  protected readonly completed = computed(() => this.ticks().filter((t) => t.outcome === 'completed').length);
  protected readonly errors = computed(() => this.ticks().filter((t) => t.outcome === 'error').length);
  protected readonly timeouts = computed(() => this.ticks().filter((t) => t.outcome === 'timeout').length);
  protected readonly silent = computed(() => this.ticks().filter((t) => t.outcome === 'silent').length);
  protected readonly runs = computed(
    () => this.ticks().filter((t) => typeof t.mission === 'string' && t.mission !== '').length,
  );

  protected readonly avgDuration = computed<number | null>(() => {
    const d = this.ticks()
      .map((t) => t.duration_ms)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    if (d.length === 0) return null;
    return d.reduce((a, b) => a + b, 0) / d.length;
  });

  protected readonly cadence = computed<Cadence | null>(() => {
    const times = this.ticks()
      .map((t) => Date.parse(t.ts))
      .filter((n) => Number.isFinite(n));
    if (times.length < 2) return null;
    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
    return {
      avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
      min: Math.min(...deltas),
      max: Math.max(...deltas),
      n: deltas.length,
    };
  });

  protected readonly missions = computed<MissionStat[]>(() => {
    const map = new Map<string, MissionStat>();
    for (const t of this.ticks()) {
      if (typeof t.mission !== 'string' || t.mission === '') continue;
      const stat = map.get(t.mission) ?? { mission: t.mission, count: 0, tokens: 0, completed: 0, failed: 0 };
      stat.count += 1;
      if (typeof t.token_cost === 'number') stat.tokens += t.token_cost;
      if (t.outcome === 'completed') stat.completed += 1;
      if (t.outcome === 'error' || t.outcome === 'timeout') stat.failed += 1;
      map.set(t.mission, stat);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  });

  protected readonly errorRows = computed(() => this.ticks().filter((t) => !!t.error).reverse());

  protected readonly mood = computed(() => this.store.metrics()?.mood ?? null);
  protected readonly backlog = computed(() => this.store.metrics()?.backlog ?? null);

  protected readonly statusEntries = computed<Array<[string, number]>>(() =>
    Object.entries(this.backlog()?.by_status ?? {}),
  );
}
