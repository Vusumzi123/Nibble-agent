import { Component, computed, inject, signal } from '@angular/core';

import { ApiService, errorText } from '../../core/api.service';
import { fmtDuration, fmtTime, fmtTokens } from '../../core/format';
import { HeartbeatTick, MessageRow } from '../../core/models';
import { DashboardStore } from '../../core/store';
import { TranscriptComponent } from '../../shared/transcript/transcript';

// The heartbeat tick budget (heartbeat-hook.ts HEARTBEAT_TICK_TIMEOUT_MS).
const TICK_BUDGET_MS = 15 * 60_000;

@Component({
  selector: 'app-flight-page',
  templateUrl: './flight.html',
  styleUrl: './flight.css',
  imports: [TranscriptComponent],
  host: { '(document:keydown.escape)': 'closeTick()' },
})
export class FlightPage {
  protected readonly store = inject(DashboardStore);
  private readonly api = inject(ApiService);

  protected readonly selected = signal<HeartbeatTick | null>(null);
  protected readonly detailRows = signal<MessageRow[]>([]);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);
  private detailSeq = 0;

  protected readonly status = computed(() => {
    const hb = this.store.heartbeat();
    if (!hb) return 'unknown';
    if (hb.current?.state === 'in-flight') return 'in-flight';
    if (hb.lock) return 'in-flight (lock)';
    return 'idle';
  });

  protected readonly elapsedMs = computed(() => {
    const started = this.store.heartbeat()?.current?.started_at;
    if (!started) return null;
    const t = Date.parse(started);
    if (Number.isNaN(t)) return null;
    return Math.max(0, this.store.now() - t);
  });

  protected readonly elapsedPct = computed(() => {
    const e = this.elapsedMs();
    if (e === null) return 0;
    return Math.min(100, Math.round((e / TICK_BUDGET_MS) * 100));
  });

  protected readonly tokenBudget = computed(() => {
    const b = this.store.config()?.autonomy.mission_token_budget;
    if (b === 'unlimited') return 'unlimited';
    if (typeof b === 'number') return fmtTokens(b);
    return '—';
  });

  protected readonly recentTicks = computed(() => [...this.store.ticks()].slice(-20).reverse());

  protected readonly lockLabel = computed(() => {
    const hb = this.store.heartbeat();
    if (!hb?.lock) return 'free';
    return hb.lock_stale ? 'held (stale)' : 'held';
  });

  protected readonly schedule = computed(() => this.store.heartbeat()?.schedule ?? null);

  // Drain consumer pointer (drain-consumer-plan §6.1): rides the queues
  // snapshot the store already polls — no extra request.
  protected readonly drain = computed(() => this.store.queues()?.drain ?? null);

  // Countdown recomputes on the store's 1 s clock (the snapshot only polls
  // every 2 s), so the display stays smooth while the server owns the truth.
  protected readonly untilNextTickMs = computed(() => {
    const next = this.schedule()?.next_tick;
    if (!next) return null;
    const t = Date.parse(next);
    if (Number.isNaN(t)) return null;
    return Math.max(0, t - this.store.now());
  });

  protected readonly countdown = computed(() => {
    const s = this.schedule();
    if (!s) return '—';
    if (s.paused) return 'paused';
    if (s.off) return 'off';
    const remaining = this.untilNextTickMs();
    if (remaining === null) return 'due now';
    if (remaining === 0) return 'due now';
    return fmtDuration(remaining);
  });

  protected readonly scheduleState = computed(() => {
    const s = this.schedule();
    if (!s) return 'unknown';
    if (!s.enabled) return 'paused — heartbeat disabled';
    if (s.level <= 0) return 'paused — autonomy level 0';
    if (s.off) return `off — frequency ${s.frequency}`;
    if (this.store.inFlight()) return 'tick running';
    if (s.due) return 'due now';
    return 'scheduled';
  });

  protected readonly backoffLabel = computed(() => {
    const streak = this.schedule()?.noop_streak ?? 0;
    if (streak >= 3) return '×4 (streak 3+)';
    if (streak === 2) return '×2 (streak 2)';
    return 'none';
  });

  protected readonly fmtDuration = fmtDuration;
  protected readonly fmtTime = fmtTime;
  protected readonly fmtTokens = fmtTokens;

  protected transcriptId(t: HeartbeatTick): string | null {
    const tool = typeof t.tool_session === 'string' ? t.tool_session : null;
    const session = typeof t.session === 'string' ? t.session : null;
    return tool ?? session;
  }

  protected drawerSession(t: HeartbeatTick): string {
    return this.transcriptId(t) ?? '—';
  }

  protected async openTick(t: HeartbeatTick): Promise<void> {
    const sid = this.transcriptId(t);
    if (!sid) return;
    const directory = this.store.health()?.directory;
    const seq = ++this.detailSeq;
    this.selected.set(t);
    this.detailRows.set([]);
    this.detailError.set(null);
    if (!directory) {
      this.detailError.set('backend directory unavailable');
      this.detailLoading.set(false);
      return;
    }
    this.detailLoading.set(true);
    try {
      const rows = await this.api.sessionMessages(sid, directory);
      if (seq !== this.detailSeq) return;
      this.detailRows.set(rows);
    } catch (err) {
      if (seq !== this.detailSeq) return;
      this.detailError.set(errorText(err));
    } finally {
      if (seq === this.detailSeq) this.detailLoading.set(false);
    }
  }

  protected closeTick(): void {
    this.detailSeq++;
    this.selected.set(null);
    this.detailRows.set([]);
    this.detailError.set(null);
    this.detailLoading.set(false);
  }
}
