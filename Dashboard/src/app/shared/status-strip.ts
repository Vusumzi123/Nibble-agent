import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { fmtAge, fmtCost, fmtDuration, fmtTokens } from '../core/format';
import { DashboardStore } from '../core/store';
import { Sparkline } from './sparkline';

interface StripCell {
  key: string;
  label: string;
  value: string;
  sub: string;
  link: string;
  tone: 'default' | 'success' | 'warning' | 'danger' | 'primary';
  spark: number[];
}

@Component({
  selector: 'db-status-strip',
  imports: [Sparkline],
  template: `
    <div class="strip">
      @for (cell of cells(); track cell.key) {
        <button
          class="cell"
          type="button"
          [class]="'cell cell--' + cell.tone + (cell.spark.length > 1 ? ' cell--spark' : '')"
          (click)="go(cell.link)"
          [title]="cell.label + ' — open ' + cell.link"
        >
          <span class="cell__label">{{ cell.label }}</span>
          <span class="cell__value mono">{{ cell.value }}</span>
          <span class="cell__sub">{{ cell.sub }}</span>
          @if (cell.spark.length > 1) {
            <db-spark class="cell__spark" [points]="cell.spark" [tone]="sparkTone(cell.tone)" [height]="20" />
          }
        </button>
      }
    </div>
  `,
})
export class StatusStrip {
  private readonly store = inject(DashboardStore);
  private readonly router = inject(Router);

  readonly cells = computed<StripCell[]>(() => {
    const store = this.store;
    const online = store.online();
    const health = store.health();
    const current = store.current();
    const schedule = store.schedule();
    const last = store.lastRun();
    const cost = store.cost();
    const errors = store.errors();
    const queueWait = store.queueWait();
    const queue = store.queues();
    const drain = store.drain();
    const budget = store.budget();
    const lastTokens = store.lastTokens() ?? 0;
    const pending = store.pendingTurns();
    const oldest = store.oldestQueue();
    const live = current?.state === 'in-flight';
    const mission = live ? current?.mission ?? current?.side_mission ?? null : null;
    const overruns = store.overruns();
    const serveHost = health?.serve_url ? health.serve_url.replace(/^https?:\/\//, '') : '—';

    return [
      {
        key: 'backend',
        label: 'backend',
        value: online ? 'live' : 'offline',
        sub: online ? `${serveHost} · csrf` : 'retrying every 4s',
        link: '/settings',
        tone: online ? 'success' : 'danger',
        spark: [],
      },
      {
        key: 'tick',
        label: 'tick cadence',
        value: current?.tick ? `#${current.tick}` : 'idle',
        sub: `${current?.phase ?? 'idle'} · next ${store.tickRemaining()}`,
        link: '/flight',
        tone: current?.state === 'in-flight' ? 'primary' : 'default',
        spark: store.cadenceSpark(),
      },
      {
        key: 'mission',
        label: 'mission / lease',
        value: mission ?? 'none',
        sub: live && current?.side_mission && current?.mission
          ? `side ${current.side_mission} · L${schedule?.level ?? '—'}`
          : `${current?.state ?? 'idle'} · L${schedule?.level ?? '—'}`,
        link: '/flight',
        tone: store.heartbeat()?.lock_stale ? 'danger' : live ? 'primary' : 'default',
        spark: [],
      },
      {
        key: 'burn',
        label: 'token burn',
        value: fmtTokens(lastTokens),
        sub: `budget ${fmtTokens(budget)} · ${last?.model ?? 'model n/a'}`,
        link: '/metrics',
        tone: last?.over_budget ? 'danger' : 'primary',
        spark: store.burnSpark(),
      },
      {
        key: 'cost',
        label: '$ spend · 24h',
        value: fmtCost(cost?.total ?? null),
        sub: `${fmtCost(store.costPerRun())} / run · today ${fmtCost(cost?.today ?? null)}`,
        link: '/metrics',
        tone: 'success',
        spark: store.costSpark(),
      },
      {
        key: 'queue',
        label: 'work queue',
        value: String(queue?.total ?? 0),
        sub: `${queue?.due ?? 0} due · oldest ${fmtAge(oldest)}`,
        link: '/queues',
        tone: oldest > 45 * 60_000 ? 'danger' : oldest > 20 * 60_000 ? 'warning' : 'success',
        spark: [],
      },
      {
        key: 'drain',
        label: 'drain backlog',
        value: String(pending),
        sub: `oldest ${fmtDuration(store.drainLag())} · ${drain?.state ?? 'unknown'}`,
        link: '/metrics',
        tone: (store.drainLag() ?? 0) > 6 * 3_600_000 ? 'danger' : (store.drainLag() ?? 0) > 2 * 3_600_000 ? 'warning' : 'success',
        spark: [],
      },
      {
        key: 'errors',
        label: 'error rate · 24h',
        value: `${store.errorRate().toFixed(1)}%`,
        sub: `${store.errorCount()} / ${store.runCount()} runs · ${overruns} over`,
        link: '/metrics',
        tone: store.errorRate() > 20 ? 'danger' : store.errorRate() > 8 ? 'warning' : 'success',
        spark: store.errorSpark(),
      },
    ];
  });

  sparkTone(tone: StripCell['tone']): 'primary' | 'success' | 'danger' | 'warning' | 'muted' {
    if (tone === 'default') return 'muted';
    return tone;
  }

  go(link: string): void {
    void this.router.navigateByUrl(link);
  }
}
