import { Component, computed, inject } from '@angular/core';

import { fmtCost, fmtDuration, fmtTokens, pct } from '../core/format';
import { DashboardStore } from '../core/store';
import { MetricPanel } from '../shared/metric-panel';

@Component({
  selector: 'db-metrics-page',
  imports: [MetricPanel],
  templateUrl: './metrics.html',
  styleUrl: './metrics.css',
})
export class MetricsPage {
  protected readonly store = inject(DashboardStore);
  protected fmtDuration = fmtDuration;
  protected fmtTokens = fmtTokens;
  protected fmtCost = fmtCost;
  protected pct = pct;
  protected readonly String = String;

  protected readonly outcomes = computed(() => {
    const counts = this.store.errors()?.runs?.by_outcome ?? {};
    return Object.entries(counts)
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count);
  });

  protected readonly gateVerdicts = computed(() => {
    const counts = this.store.errors()?.gates?.by_verdict ?? {};
    return Object.entries(counts)
      .map(([verdict, count]) => ({ verdict, count }))
      .sort((a, b) => b.count - a.count);
  });

  protected readonly rollup = computed(() => {
    const missions = this.store.cost()?.missions ?? [];
    const runs = this.store.runs();
    return missions.map((row) => {
      const missionRuns = runs.filter((run) => run.mission === row.mission);
      const errors = missionRuns.filter((run) => ['error', 'timeout', 'aborted'].includes(run.outcome ?? '') || run.result_missing);
      return {
        ...row,
        errors: errors.length,
        last: missionRuns[0]?.outcome ?? '—',
      };
    });
  });

  protected readonly maxTokens = computed(() =>
    Math.max(1, ...(this.store.tokens()?.points ?? []).map((point) => point.tokens)),
  );

  protected readonly schedulerRows = computed(() => {
    const scheduler = this.store.queues()?.scheduler;
    if (!scheduler) return [];
    const total = Object.values(scheduler.weights).reduce((sum, value) => sum + value, 0);
    return Object.entries(scheduler.weights)
      .filter(([, weight]) => weight > 0)
      .map(([kind, weight]) => ({
        kind,
        weight,
        served: scheduler.served[kind] ?? 0,
        max_gap: scheduler.max_gap[kind] ?? null,
        share: total ? (weight / total) * 100 : 0,
      }))
      .sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));
  });

  protected barHeight(tokens: number): number {
    return Math.max(2, (tokens / this.maxTokens()) * 100);
  }

  protected tickLabel(bucket: string): string {
    const date = new Date(bucket);
    return Number.isNaN(date.getTime()) ? '' : String(date.getHours()).padStart(2, '0');
  }

  protected share(count: number): number {
    return this.store.runCount() ? (count / this.store.runCount()) * 100 : 0;
  }

  protected tone(outcome: string | null): string {
    switch (outcome) {
      case 'completed':
        return 'success';
      case 'error':
      case 'aborted':
        return 'danger';
      case 'timeout':
      case 'silent':
        return 'warning';
      case 'declined':
        return 'muted';
      default:
        return 'ghost';
    }
  }

  protected gateTone(verdict: string): string {
    if (verdict === 'allow') return 'success';
    if (verdict === 'deny') return 'danger';
    if (verdict === 'ask') return 'warning';
    return 'ghost';
  }
}
