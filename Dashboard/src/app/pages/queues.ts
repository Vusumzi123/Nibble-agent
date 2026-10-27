import { Component, computed, inject, signal } from '@angular/core';

import { fmtAge, fmtCost, fmtDuration, fmtTime, fmtTokens } from '../core/format';
import { RunRow } from '../core/models';
import { DashboardStore } from '../core/store';
import { RunTable } from '../shared/run-table';
import { Transcript } from '../shared/transcript';

@Component({
  selector: 'db-queues-page',
  imports: [RunTable, Transcript],
  host: { '(document:keydown.escape)': 'selected.set(null)' },
  template: `
    <div class="page">
      <div class="grid-drain">
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">drain work</span>
            <span class="tag" [class]="'tag tag--' + (store.drain()?.state === 'running' ? 'primary' : 'success')">
              {{ store.drain()?.state ?? 'unknown' }}
            </span>
          </header>
          <div class="panel__body">
            <div class="mini-grid">
              <div class="mini">
                <span class="mini__label">pending turns</span>
                <span class="mini__value mono">{{ store.drain()?.pending ?? 0 }}</span>
              </div>
              <div class="mini">
                <span class="mini__label">sessions</span>
                <span class="mini__value mono">{{ store.drain()?.pending_sessions ?? 0 }}</span>
              </div>
              <div class="mini">
                <span class="mini__label">oldest</span>
                <span class="mini__value mono">{{ fmtDuration(store.drainLag()) }}</span>
              </div>
              <div class="mini">
                <span class="mini__label">trigger</span>
                <span class="mini__value mono">{{ store.drain()?.trigger_pending ?? 0 }} / {{ store.drain()?.trigger_max_age_hours ?? 0 }}h</span>
              </div>
              <div class="mini">
                <span class="mini__label">last pass</span>
                <span class="mini__value mono">{{ store.drain()?.last_pass?.outcome ?? '—' }}</span>
              </div>
              <div class="mini">
                <span class="mini__label">last tokens</span>
                <span class="mini__value mono">{{ fmtTokens(store.drain()?.last_pass?.tokens ?? 0) }}</span>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">in flight</span>
            <span class="tag" [class]="'tag tag--' + (store.current() ? 'success' : 'ghost')">
              {{ store.current()?.state ?? 'idle' }}
            </span>
          </header>
          <div class="panel__body">
            <dl class="kv kv--dense">
              <dt>mission</dt>
              <dd class="mono ellipsis">{{ runningTitle() }}</dd>
              <dt>tick</dt>
              <dd class="mono">#{{ store.current()?.tick ?? '—' }} · {{ store.current()?.phase ?? '—' }}</dd>
              <dt>side</dt>
              <dd class="mono ellipsis">{{ store.current()?.side_mission ?? '—' }}</dd>
              <dt>queue</dt>
              <dd class="mono">{{ store.queueDepth() }} items · {{ store.queues()?.due ?? 0 }} due</dd>
            </dl>
          </div>
        </section>
      </div>

      @if (store.queues()?.scheduler; as scheduler) {
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">scheduler · swrr</span>
            <span class="tag" [class]="'tag tag--' + (scheduler.fair ? 'success' : 'warning')">
              {{ scheduler.fair ? 'fair' : 'legacy' }}
            </span>
            <span class="head-meta mono">next {{ scheduler.next_kind ?? '—' }} · total weight {{ scheduler.total_weight }}</span>
          </header>
          <div class="table-wrap">
            <table class="tbl tbl--tight">
              <thead>
                <tr><th>kind</th><th class="num">weight</th><th class="num">credit</th><th class="num">served</th><th class="num">max gap</th></tr>
              </thead>
              <tbody>
                @for (row of schedulerRows(); track row.kind) {
                  <tr [class.stale]="!kindRunnable(row.kind)">
                    <td><span class="tag" [class]="'tag tag--' + kindTone(row.kind)">{{ row.kind }}</span></td>
                    <td class="num mono">{{ row.weight }}</td>
                    <td class="num mono">{{ row.credit }}</td>
                    <td class="num mono">{{ row.served }}</td>
                    <td class="num mono dim">{{ row.max_gap ?? '—' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="empty">no scheduler state</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else {
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">scheduler · swrr</span>
            <span class="tag tag--ghost">not available</span>
          </header>
          <div class="panel__body"><p class="empty pad">scheduler state appears after the first fair tick</p></div>
        </section>
      }

      <section class="panel">
        <header class="panel__head">
          <span class="panel__title">work queue</span>
          <div class="head-tools">
            @for (entry of kindStats(); track entry.kind) {
              <span class="tag" [class]="'tag tag--' + kindTone(entry.kind)">{{ entry.kind }} {{ entry.count }}</span>
            }
            <span class="mono dim">{{ store.queueDepth() }} total · {{ store.queues()?.due ?? 0 }} due</span>
          </div>
        </header>
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th class="num">pri</th>
                <th>kind</th>
                <th>item</th>
                <th>producer</th>
                <th class="num">age</th>
                <th>schedule</th>
                <th class="num">ttl</th>
                <th class="num">rq</th>
              </tr>
            </thead>
            <tbody>
              @for (item of store.queueItems(); track item.id) {
                <tr [class.stale]="!item.due">
                  <td class="num mono dim">{{ item.priority }}</td>
                  <td><span class="tag" [class]="'tag tag--' + kindTone(item.kind)">{{ item.kind }}</span></td>
                  <td class="mission">
                    <span>{{ item.title }}</span>
                    <span class="sub">{{ item.id }}{{ item.mission ? ' · ' + item.mission : '' }}</span>
                  </td>
                  <td class="mono dim">{{ item.producer }}</td>
                  <td class="num mono">{{ fmtAge(item.age_ms) }}</td>
                  <td class="mono">
                    @if (item.due) {
                      <span class="tag tag--success">due</span>
                    } @else {
                      <span class="tag tag--warning">in {{ until(item.not_before_ms) }}</span>
                    }
                  </td>
                  <td class="num mono dim">{{ fmtDuration(item.ttl_ms) }}</td>
                  <td class="num mono" [class.warn]="item.requeue_count > 0">
                    {{ item.requeue_count }}
                    @if (item.requeue_reason) { <span class="sub block">{{ item.requeue_reason }}</span> }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="empty">queue empty</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <header class="panel__head">
          <span class="panel__title">run history</span>
          <div class="head-tools">
            <select class="input input--sm" (change)="mission.set(value($event))">
              <option value="all">all missions</option>
              @for (m of store.missions(); track m.id) {
                <option [value]="m.id">{{ m.id }}</option>
              }
            </select>
            <select class="input input--sm" (change)="kind.set(value($event))">
              <option value="all">all kinds</option>
              <option value="mission">mission</option>
              <option value="side">side</option>
              <option value="drain">drain</option>
            </select>
            <select class="input input--sm" (change)="outcome.set(value($event))">
              <option value="all">all outcomes</option>
              <option value="completed">completed</option>
              <option value="error">error</option>
              <option value="timeout">timeout</option>
              <option value="declined">declined</option>
              <option value="silent">silent</option>
              <option value="aborted">aborted</option>
            </select>
            <span class="mono dim">{{ filtered().length }} rows</span>
          </div>
        </header>
        <db-run-table [runs]="filtered()" (select)="selected.set($event)" />
      </section>
    </div>

    @if (selected(); as run) {
      <div class="drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="drawer" role="dialog" aria-label="run detail">
        <header class="drawer__head">
          <div>
            <span class="drawer__eyebrow mono">run · tick {{ run.tick ?? '—' }} · {{ run.kind }}</span>
            <h2 class="drawer__title">{{ run.mission_title ?? run.mission ?? 'unknown mission' }}</h2>
          </div>
          <button type="button" class="ibtn" (click)="selected.set(null)">esc</button>
        </header>
        <div class="drawer__body">
          <dl class="kv kv--dense">
            <dt>mission</dt><dd class="mono">{{ run.mission ?? '—' }}</dd>
            <dt>outcome</dt>
            <dd><span class="tag" [class]="'tag tag--' + outcomeTone(run.outcome)">{{ run.outcome ?? 'unknown' }}</span></dd>
            <dt>model</dt><dd class="mono ellipsis">{{ run.model ?? '—' }}</dd>
            <dt>started</dt><dd class="mono">{{ fmtTime(run.started_ms) }}</dd>
            <dt>finished</dt><dd class="mono">{{ fmtTime(run.finished_ms) }}</dd>
            <dt>duration</dt><dd class="mono">{{ fmtDuration(run.duration_ms) }}</dd>
            <dt>tokens</dt><dd class="mono" [class.warn]="run.over_budget">{{ fmtTokens(run.token_cost) }}</dd>
            <dt>cost</dt><dd class="mono">{{ fmtCost(run.cost) }}</dd>
            <dt>session</dt><dd class="mono ellipsis">{{ run.session ?? '—' }}</dd>
            <dt>result</dt><dd class="mono">{{ run.result_status ?? '—' }}{{ run.result_missing ? ' · missing' : '' }}</dd>
            <dt>stop reason</dt><dd class="mono">{{ run.stop_reason ?? '—' }}</dd>
            <dt>requeued</dt><dd class="mono">{{ run.requeued ? 'yes' : 'no' }}</dd>
            @if (run.kind === 'drain') {
              <dt>trigger</dt><dd class="mono">{{ run.trigger ?? '—' }}</dd>
              <dt>pending</dt><dd class="mono">{{ run.pending_before ?? '—' }} → {{ run.pending_after ?? '—' }}</dd>
              <dt>batch</dt><dd class="mono">{{ run.batch_sessions ?? '—' }} sessions · {{ run.batch_items ?? '—' }} items</dd>
            }
          </dl>
          <h3 class="section-title">live transcript tail</h3>
          <db-transcript [entries]="store.transcript().slice(-4)" />
        </div>
      </aside>
    }
  `,
})
export class QueuesPage {
  protected readonly store = inject(DashboardStore);

  protected readonly mission = signal('all');
  protected readonly kind = signal('all');
  protected readonly outcome = signal('all');
  protected readonly selected = signal<RunRow | null>(null);

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
