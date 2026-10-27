import { Component, computed, inject } from '@angular/core';

import { fmtCost, fmtDuration, fmtTokens, pct } from '../core/format';
import { DashboardStore } from '../core/store';
import { MetricPanel } from '../shared/metric-panel';

@Component({
  selector: 'db-metrics-page',
  imports: [MetricPanel],
  template: `
    <div class="page">
      <section class="toolbar">
        <span class="mono dim">window · last 24h</span>
        <span class="spacer"></span>
        <span class="legend mono dim">
          <span class="tag tag--success">live</span> measured
          <span class="tag tag--info">session</span> opencode.db
          <span class="tag tag--warning">n/a</span> no data
        </span>
      </section>

      <div class="grid-metrics">
        <db-metric-panel
          label="cadence"
          [value]="fmtDuration(store.cadence())"
          unit="interval"
          [note]="'next ' + store.tickRemaining()"
          footnote="autonomy.heartbeat.frequency · noop backoff"
          caveat="live"
          tone="primary"
          [points]="store.cadenceSpark()"
        />
        <db-metric-panel
          label="error rate · 24h"
          [value]="store.errorRate().toFixed(1)"
          unit="%"
          [note]="store.errorCount() + ' / ' + store.runCount() + ' runs'"
          footnote="run outcomes + missing results"
          [caveat]="store.runCount() ? 'live' : 'gap'"
          [tone]="store.errorRate() > 20 ? 'danger' : store.errorRate() > 8 ? 'warning' : 'success'"
          [points]="store.errorSpark()"
        />
        <db-metric-panel
          label="drain backlog"
          [value]="String(store.pendingTurns())"
          unit="turns"
          [note]="'oldest ' + fmtDuration(store.drainLag())"
          footnote="top-level text turns above cursor marks · harness query"
          caveat="live"
          [tone]="(store.drainLag() ?? 0) > 6 * 3_600_000 ? 'warning' : 'success'"
          [points]="store.drainSpark()"
        />
        <db-metric-panel
          label="token burn · 24h"
          [value]="fmtTokens(store.burnTotal())"
          unit="tokens"
          [note]="fmtTokens(store.budget()) + ' budget / run'"
          footnote="heartbeat run token_cost, hourly"
          caveat="live"
          tone="primary"
          [points]="store.burnSpark()"
        />
        <db-metric-panel
          label="spend · 24h"
          [value]="fmtCost(store.costTotal())"
          unit="usd"
          [note]="(store.cost()?.sessions ?? 0) + ' sessions'"
          footnote="opencode session cost, all agents"
          [caveat]="store.cost()?.sessions ? 'live' : 'gap'"
          tone="success"
          [points]="store.costSpark()"
        />
        <db-metric-panel
          label="$ / mission"
          [value]="fmtCost(store.costPerRun())"
          unit="avg"
          [note]="fmtCost(store.lastRun()?.cost ?? null) + ' last run'"
          footnote="runs joined to session cost"
          [caveat]="store.costPerRun() !== null ? 'live' : 'gap'"
          tone="success"
          [points]="store.costSpark()"
        />
        <db-metric-panel
          label="queue age · current"
          [value]="store.queueWait()?.p50_ms ? fmtDuration(store.queueWait()!.p50_ms).replace(' ', '') : '—'"
          unit="p50"
          [note]="store.queueWait()?.p95_ms ? 'p95 ' + fmtDuration(store.queueWait()!.p95_ms) : 'no queue'"
          footnote="current queue age; no historical enqueue"
          [caveat]="store.queueWait()?.total ? 'live' : 'gap'"
          [tone]="(store.oldestQueue() ?? 0) > 45 * 60_000 ? 'warning' : 'primary'"
          [points]="[]"
        />
        <db-metric-panel
          label="budget overruns"
          [value]="String(store.overruns())"
          unit="runs"
          note="token_cost > budget"
          footnote="per-run mission budget"
          caveat="live"
          [tone]="store.overruns() > 0 ? 'warning' : 'success'"
          [points]="store.overrunSpark()"
        />
      </div>

      @if (store.queues()?.scheduler; as scheduler) {
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">scheduler service share</span>
            <span class="head-meta mono">next {{ scheduler.next_kind ?? '—' }} · total weight {{ scheduler.total_weight }}</span>
          </header>
          <div class="table-wrap">
            <table class="tbl tbl--tight">
              <thead><tr><th>kind</th><th class="num">weight</th><th class="num">served</th><th class="num">gap bound</th><th>share</th></tr></thead>
              <tbody>
                @for (row of schedulerRows(); track row.kind) {
                  <tr>
                    <td><span class="tag" [class]="'tag tag--' + (row.kind === 'drain-pass' ? 'info' : 'primary')">{{ row.kind }}</span></td>
                    <td class="num mono">{{ row.weight }}</td>
                    <td class="num mono">{{ row.served }}</td>
                    <td class="num mono dim">{{ row.max_gap ?? '—' }}</td>
                    <td class="share"><span [style.width.%]="row.share"></span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="empty">no scheduler service yet</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      <div class="grid-3-2">
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">token burn vs budget · hourly</span>
            <span class="head-meta mono">
              {{ store.tokens()?.totals?.runs ?? 0 }} runs · {{ fmtCost(store.tokens()?.totals?.cost ?? null) }}
            </span>
          </header>
          <div class="panel__body">
            <div class="bars">
              @for (point of store.tokens()?.points ?? []; track point.bucket) {
                <div
                  class="bars__col"
                  [title]="fmtTokens(point.tokens) + ' tokens · ' + fmtCost(point.cost) + ' · ' + point.runs + ' runs'"
                >
                  <span
                    class="bars__bar"
                    [class.bars__bar--over]="point.over_runs > 0"
                    [style.height.%]="barHeight(point.tokens)"
                  ></span>
                  <span class="bars__tick mono">{{ tickLabel(point.bucket) }}</span>
                </div>
              } @empty {
                <p class="empty pad">no runs in the window</p>
              }
            </div>
            <div class="bars__legend mono dim">
              <span>{{ fmtTokens(store.tokens()?.totals?.tokens ?? 0) }} tokens</span>
              <span>{{ fmtCost(store.tokens()?.totals?.cost ?? null) }}</span>
              <span class="warn">{{ store.overruns() }} over budget</span>
              <span class="spacer"></span>
              <span>p50 {{ fmtDuration(store.throughput()?.totals?.p50_ms ?? null) }}</span>
              <span>p95 {{ fmtDuration(store.throughput()?.totals?.p95_ms ?? null) }}</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">spend by model · 24h</span>
            <span class="head-meta mono">{{ fmtCost(store.cost()?.total ?? null) }}</span>
          </header>
          <div class="table-wrap">
            <table class="tbl tbl--tight">
              <thead>
                <tr><th>model</th><th class="num">sess</th><th class="num">tokens</th><th class="num">cost</th><th>share</th></tr>
              </thead>
              <tbody>
                @for (model of store.cost()?.models ?? []; track model.model) {
                  <tr>
                    <td class="mono ellipsis" [title]="model.model">{{ model.model }}</td>
                    <td class="num mono">{{ model.sessions }}</td>
                    <td class="num mono">{{ fmtTokens(model.tokens) }}</td>
                    <td class="num mono">{{ fmtCost(model.cost) }}</td>
                    <td class="share"><span [style.width.%]="model.share"></span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="empty">no session cost yet</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="grid-2">
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">run outcomes</span>
            <span class="head-meta mono">{{ store.runCount() }} runs</span>
          </header>
          <div class="table-wrap">
            <table class="tbl tbl--tight">
              <thead><tr><th>outcome</th><th class="num">count</th><th class="num">share</th><th>bar</th></tr></thead>
              <tbody>
                @for (row of outcomes(); track row.outcome) {
                  <tr>
                    <td><span class="tag" [class]="'tag tag--' + tone(row.outcome)">{{ row.outcome }}</span></td>
                    <td class="num mono">{{ row.count }}</td>
                    <td class="num mono dim">{{ pct(row.count, store.runCount()) }}</td>
                    <td class="share"><span [style.width.%]="share(row.count)"></span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="empty">no runs</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">gate verdicts · 24h</span>
            <span class="head-meta mono">{{ store.errors()?.gates?.total ?? 0 }} decisions</span>
          </header>
          <div class="table-wrap">
            <table class="tbl tbl--tight">
              <thead><tr><th>verdict</th><th class="num">count</th><th class="num">share</th><th>bar</th></tr></thead>
              <tbody>
                @for (row of gateVerdicts(); track row.verdict) {
                  <tr>
                    <td><span class="tag" [class]="'tag tag--' + gateTone(row.verdict)">{{ row.verdict }}</span></td>
                    <td class="num mono">{{ row.count }}</td>
                    <td class="num mono dim">{{ pct(row.count, store.errors()?.gates?.total ?? 0) }}</td>
                    <td class="share"><span [style.width.%]="pct(row.count, store.errors()?.gates?.total ?? 0)"></span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="empty">no gate decisions</td></tr>
                }
              </tbody>
            </table>
            <div class="signal-row mono dim">
              <span [class.warn]="(store.errors()?.audit?.failures ?? 0) > 0">{{ store.errors()?.audit?.failures ?? 0 }} audit failures</span>
              <span [class.warn]="(store.errors()?.retrieval?.errors ?? 0) > 0">{{ store.errors()?.retrieval?.errors ?? 0 }} retrieval errors</span>
              <span [class.warn]="(store.errors()?.drain?.errors ?? 0) > 0">{{ store.errors()?.drain?.errors ?? 0 }} drain errors</span>
            </div>
          </div>
        </section>
      </div>

      <section class="panel">
        <header class="panel__head">
          <span class="panel__title">mission rollup · 24h</span>
          <span class="head-meta mono">{{ rollup().length }} missions</span>
        </header>
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>mission</th>
                <th class="num">runs</th>
                <th class="num">tokens</th>
                <th class="num">cost</th>
                <th class="num">avg / run</th>
                <th class="num">errors</th>
                <th>last</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rollup(); track row.mission) {
                <tr>
                  <td class="mono">{{ row.mission }}</td>
                  <td class="num mono">{{ row.runs }}</td>
                  <td class="num mono">{{ fmtTokens(row.tokens) }}</td>
                  <td class="num mono">{{ fmtCost(row.cost) }}</td>
                  <td class="num mono">{{ fmtCost(row.runs ? row.cost / row.runs : null) }}</td>
                  <td class="num mono" [class.warn]="row.errors > 0">{{ row.errors }}</td>
                  <td><span class="tag" [class]="'tag tag--' + tone(row.last)">{{ row.last }}</span></td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="empty">no runs</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
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
