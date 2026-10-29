import { Component, computed, inject, signal } from '@angular/core';

import { ApiService, errorText } from '../core/api';
import { fmtAge, fmtCost, fmtDuration, fmtTime, fmtTokens } from '../core/format';
import { RunDetail, RunRow, TranscriptEntry } from '../core/models';
import { DashboardStore } from '../core/store';
import { mapSessionMessages } from '../core/transcript-map';
import { RunTable } from '../shared/run-table';
import { Transcript } from '../shared/transcript';

@Component({
  selector: 'db-queues-page',
  imports: [RunTable, Transcript],
  host: { '(document:keydown.escape)': 'close()' },
  templateUrl: './queues.html',
  styleUrl: './queues.css',
})
export class QueuesPage {
  protected readonly store = inject(DashboardStore);
  private readonly api = inject(ApiService);

  protected readonly mission = signal('all');
  protected readonly kind = signal('all');
  protected readonly outcome = signal('all');
  protected readonly selected = signal<RunRow | null>(null);
  protected readonly detail = signal<RunDetail | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);
  protected readonly drawerEntries = signal<TranscriptEntry[]>([]);
  protected readonly drawerLoading = signal(false);
  protected readonly drawerError = signal<string | null>(null);

  private detailSeq = 0;

  /** Drawer fields prefer the individually loaded detail over the list row. */
  protected readonly viewRun = computed(() => this.detail()?.run ?? this.selected());

  protected fmtAge = fmtAge;
  protected fmtDuration = fmtDuration;
  protected fmtTime = fmtTime;
  protected fmtTokens = fmtTokens;
  protected fmtCost = fmtCost;

  protected readonly filtered = computed(() => {
    const mission = this.mission();
    const kind = this.kind();
    const outcome = this.outcome();
    return this.store.runs().filter(
      (run) =>
        (mission === 'all' || run.mission === mission) &&
        (kind === 'all' || run.kind === kind) &&
        (outcome === 'all' || run.outcome === outcome),
    );
  });

  protected readonly kindStats = computed(() =>
    Object.entries(this.store.queues()?.counts ?? {})
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
  );

  protected readonly schedulerRows = computed(() => {
    const scheduler = this.store.queues()?.scheduler;
    if (!scheduler) return [];
    return Object.keys(scheduler.weights)
      .filter(
        (kind) =>
          scheduler.weights[kind] > 0 ||
          scheduler.credits[kind] !== undefined ||
          scheduler.served[kind] !== undefined,
      )
      .map((kind) => ({
        kind,
        weight: scheduler.weights[kind] ?? 0,
        credit: scheduler.credits[kind] ?? 0,
        served: scheduler.served[kind] ?? 0,
        max_gap: scheduler.max_gap[kind] ?? null,
      }))
      .sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
  });

  protected readonly runningTitle = computed(() => {
    const current = this.store.current();
    if (!current) return 'idle';
    if (current.mission_title) return current.mission_title;
    if (current.side_mission_title) return current.side_mission_title;
    return current.mission ?? current.side_mission ?? 'idle';
  });

  protected value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  /** Open the run drawer: list row renders instantly, detail + transcript load individually. */
  protected async open(run: RunRow): Promise<void> {
    const seq = ++this.detailSeq;
    this.selected.set(run);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(false);
    this.drawerEntries.set([]);
    this.drawerError.set(null);
    const loads: Array<Promise<void>> = [];
    if (run.session || run.tick !== null) {
      loads.push(this.fetchDetail(run, seq));
    }
    if (!run.session) {
      this.drawerLoading.set(false);
    } else {
      const directory = this.store.health()?.directory;
      if (!directory) {
        this.drawerLoading.set(false);
        this.drawerError.set('backend directory unavailable');
      } else {
        loads.push(this.fetchTranscript(run.session, directory, seq));
      }
    }
    await Promise.allSettled(loads);
  }

  protected reload(): void {
    const run = this.selected();
    if (run) void this.open(run);
  }

  private async fetchDetail(run: RunRow, seq: number): Promise<void> {
    this.detailLoading.set(true);
    try {
      const detail = await this.api.runDetail({
        session: run.session,
        tick: run.tick,
        mission: run.mission,
      });
      if (seq !== this.detailSeq) return;
      this.detail.set(detail);
    } catch (err) {
      if (seq !== this.detailSeq) return;
      this.detailError.set(errorText(err));
    } finally {
      if (seq === this.detailSeq) this.detailLoading.set(false);
    }
  }

  private async fetchTranscript(session: string, directory: string, seq: number): Promise<void> {
    this.drawerLoading.set(true);
    try {
      const rows = await this.api.sessionMessages(session, directory);
      if (seq !== this.detailSeq) return;
      this.drawerEntries.set(mapSessionMessages(rows));
    } catch (err) {
      if (seq !== this.detailSeq) return;
      this.drawerError.set(errorText(err));
    } finally {
      if (seq === this.detailSeq) this.drawerLoading.set(false);
    }
  }

  protected close(): void {
    this.detailSeq++;
    this.selected.set(null);
    this.detail.set(null);
    this.detailLoading.set(false);
    this.detailError.set(null);
    this.drawerEntries.set([]);
    this.drawerLoading.set(false);
    this.drawerError.set(null);
  }

  protected until(ms: number | null): string {
    if (ms === null) return '—';
    const delta = ms - this.store.now();
    return delta <= 0 ? 'due' : fmtDuration(delta);
  }

  protected kindRunnable(kind: string): boolean {
    return this.store.queues()?.scheduler?.runnable.includes(kind as never) ?? false;
  }

  protected kindTone(kind: string): string {
    switch (kind) {
      case 'mission':
        return 'primary';
      case 'drain-pass':
        return 'info';
      case 'staleness':
        return 'warning';
      case 'quiet-hours':
        return 'muted';
      default:
        return 'ghost';
    }
  }

  protected outcomeTone(outcome: string | null): string {
    switch (outcome) {
      case 'completed':
        return 'success';
      case 'error':
      case 'aborted':
        return 'danger';
      case 'timeout':
      case 'silent':
      case 'degraded':
      case 'dropped':
        return 'warning';
      case 'declined':
      case 'nothing':
      case 'skipped':
        return 'muted';
      case 'ok':
        return 'success';
      default:
        return 'ghost';
    }
  }
}
