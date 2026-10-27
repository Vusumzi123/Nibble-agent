import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { fmtAge, fmtCost, fmtDuration, fmtTime, fmtTokens } from '../core/format';
import { DashboardStore } from '../core/store';
import { Transcript } from '../shared/transcript';

@Component({
  selector: 'db-flight-page',
  imports: [Transcript, RouterLink],
  template: `
    <div class="page">
      <div class="grid-flight">
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">mission / lease</span>
            <span class="tag" [class]="'tag tag--' + (store.heartbeat()?.lock_stale ? 'danger' : live() ? 'success' : 'ghost')">
              {{ store.current()?.state ?? 'idle' }}
            </span>
          </header>
          <div class="panel__body">
            <div class="mission-line">
              <span class="mission-line__id mono">{{ live() ? (store.current()?.mission ?? store.current()?.side_mission ?? 'no mission') : 'no mission' }}</span>
              <span class="mission-line__title">{{ live() ? (store.current()?.mission_title ?? store.current()?.side_mission_title ?? 'running') : 'heartbeat idle — waiting for next tick' }}</span>
              @if (live() && store.current()?.mission && store.current()?.side_mission) {
                <span class="mission-line__side mono">side · {{ store.current()?.side_mission }} — {{ store.current()?.side_mission_title }}</span>
              }
            </div>
            <dl class="kv kv--dense">
              <dt>phase</dt>
              <dd class="mono">{{ store.current()?.phase ?? '—' }}</dd>
              <dt>tick</dt>
              <dd class="mono">#{{ store.current()?.tick ?? '—' }} · L{{ store.level() ?? '—' }}</dd>
              <dt>elapsed</dt>
              <dd class="mono">{{ elapsed() }}</dd>
              <dt>started</dt>
              <dd class="mono">{{ fmtTime(store.current()?.started_at) }}</dd>
              <dt>session</dt>
              <dd class="mono ellipsis">{{ live() ? (store.current()?.session ?? store.current()?.side_session ?? '—') : '—' }}</dd>
              <dt>lease</dt>
              <dd>
                @if (store.heartbeat()?.lock_stale) {
                  <span class="tag tag--danger">stale lease</span>
                } @else if (store.heartbeat()?.lock) {
                  <span class="tag tag--success">held</span>
                } @else {
                  <span class="tag tag--ghost">free</span>
                }
              </dd>
            </dl>
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">token + cost</span>
            <span class="mono dim">{{ burnPct().toFixed(0) }}%</span>
          </header>
          <div class="panel__body">
            <div class="budget">
              <div class="budget__figures">
                <span class="big mono" [class.warn]="burnPct() > 100">{{ fmtTokens(store.lastTokens()) }}</span>
                <span class="dim mono">/ {{ fmtTokens(store.budget()) }}</span>
              </div>
              <div class="bar" [class.bar--over]="burnPct() > 100">
                <span class="bar__fill" [style.width.%]="Math.min(100, burnPct())"></span>
              </div>
              <dl class="kv kv--dense">
                <dt>24h burn</dt>
                <dd class="mono">{{ fmtTokens(store.burnTotal()) }}</dd>
                <dt>24h spend</dt>
                <dd class="mono">{{ fmtCost(store.costTotal()) }}</dd>
                <dt>last run</dt>
                <dd class="mono">{{ fmtCost(store.lastRun()?.cost ?? null) }}</dd>
                <dt>model</dt>
                <dd class="mono ellipsis">{{ store.lastRun()?.model ?? '—' }}</dd>
              </dl>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">vitals</span>
            <span class="tag tag--ghost">L{{ store.level() ?? '—' }}</span>
          </header>
          <div class="panel__body">
            <dl class="kv kv--dense">
              <dt>mood</dt>
              <dd class="mono">{{ store.mood()?.label ?? '—' }} · v {{ store.mood()?.valence?.toFixed(2) ?? '—' }}</dd>
              <dt>sleep</dt>
              <dd class="mono">{{ store.sleep()?.status ?? '—' }} · {{ store.sleep()?.window ?? '—' }}</dd>
              <dt>ideas</dt>
              <dd class="mono">{{ store.idea()?.generatedToday ?? 0 }} / {{ store.idea()?.dailyTarget ?? 0 }} today</dd>
              <dt>cadence</dt>
              <dd class="mono">{{ fmtDuration(store.cadence()) }}</dd>
              <dt>next tick</dt>
              <dd class="mono">{{ store.tickRemaining() }}</dd>
              <dt>queue</dt>
              <dd class="mono">{{ store.queueDepth() }} items · {{ store.queueWait()?.due ?? 0 }} due</dd>
              <dt>next kind</dt>
              <dd class="mono">{{ store.queues()?.scheduler?.next_kind ?? '—' }}</dd>
              <dt>drain backlog</dt>
              <dd class="mono">{{ store.pendingTurns() }} turns · {{ fmtDuration(store.drainLag()) }}</dd>
              <dt>backlog</dt>
              <dd class="mono">{{ store.backlog()?.open ?? 0 }} open / {{ store.backlog()?.total ?? 0 }}</dd>
            </dl>
          </div>
        </section>
      </div>

      <section class="panel transcript-panel">
        <header class="panel__head">
          <span class="panel__title">transcript · live session</span>
          <span class="head-meta mono">{{ store.current()?.session ?? store.lastRun()?.session ?? 'no session' }}</span>
        </header>
        <db-transcript [entries]="store.transcript()" />
      </section>

      <div class="grid-2">
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">work queue · next up</span>
            <a class="head-meta mono" routerLink="/queues">queue →</a>
          </header>
          <div class="queue-peek">
            @for (item of queuePeek(); track item.id) {
              <div class="queue-peek__row">
                <span class="tag" [class]="'tag tag--' + kindTone(item.kind)">{{ item.kind }}</span>
                <span class="queue-peek__title ellipsis">{{ item.title }}</span>
                <span class="mono dim">{{ item.kind === 'mission' ? 'p' + item.priority : '—' }}</span>
                <span class="mono" [class.warn]="!item.due">{{ item.due ? fmtAge(item.age_ms) : 'waiting' }}</span>
              </div>
            } @empty {
              <p class="empty pad">queue empty</p>
            }
          </div>
        </section>

        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">activity</span>
            <span class="head-meta mono">{{ store.activity()?.events?.length ?? 0 }} events</span>
          </header>
          <div class="feed">
            @for (event of activity(); track event.ts + event.title) {
              <div class="feed__row">
                <span class="feed__time mono dim">{{ fmtTime(event.ts) }}</span>
                <span class="tag" [class]="'tag tag--' + event.tone">{{ event.type }}</span>
                <span class="feed__title ellipsis">{{ event.title }}</span>
                <span class="feed__detail ellipsis dim">{{ event.detail }}</span>
              </div>
            } @empty {
              <p class="empty pad">no recent activity</p>
            }
          </div>
        </section>
      </div>
    </div>
  `,
})
export class FlightPage {
  protected readonly store = inject(DashboardStore);
  protected readonly Math = Math;
  protected fmtTime = fmtTime;
  protected fmtDuration = fmtDuration;
  protected fmtTokens = fmtTokens;
  protected fmtCost = fmtCost;
  protected fmtAge = fmtAge;

  protected readonly live = computed(() => this.store.current()?.state === 'in-flight');

  protected readonly elapsed = computed(() => {
    const started = this.store.current()?.started_at;
    if (!started) return '—';
    return fmtDuration(this.store.now() - new Date(started).getTime());
  });

  protected readonly burnPct = computed(() => {
    const budget = this.store.budget();
    if (!budget) return 0;
    return ((this.store.lastTokens() ?? 0) / budget) * 100;
  });

  protected readonly queuePeek = computed(() => this.store.queueItems().slice(0, 6));

  protected readonly activity = computed(() => (this.store.activity()?.events ?? []).slice(0, 9));

  protected kindTone(kind: string): string {
    switch (kind) {
      case 'mission':
        return 'primary';
      case 'drain-pass':
        return 'info';
      case 'quiet-hours':
        return 'muted';
      case 'staleness':
        return 'warning';
      default:
        return 'ghost';
    }
  }
}
