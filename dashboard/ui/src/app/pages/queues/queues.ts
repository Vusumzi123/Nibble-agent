import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';

import { ApiService, errorText } from '../../core/api.service';
import { fmtDuration, fmtTime, fmtTokens } from '../../core/format';
import { DrainSnapshot, LaneName, MessageRow, QueueItemView, RunRow } from '../../core/models';
import { DashboardStore } from '../../core/store';
import { TranscriptComponent } from '../../shared/transcript/transcript';

type LaneFilter = 'all' | LaneName;
type OutcomeFilter = 'all' | 'completed' | 'error' | 'timeout' | 'declined' | 'silent';

const REFRESH_MS = 5000;

// Queue-monitoring widgets: what each lane is holding, and what ran recently
// with a transcript button per run. Polls `/api/queues` through the shared
// store and `/api/runs` here (bigger payload, filterable). The drain consumer
// card (drain-consumer-plan §6.1) polls `/api/drain`.
@Component({
  selector: 'app-queues-page',
  templateUrl: './queues.html',
  styleUrl: './queues.css',
  imports: [TranscriptComponent],
  host: { '(document:keydown.escape)': 'closeTranscript()' },
})
export class QueuesPage implements OnInit, OnDestroy {
  protected readonly store = inject(DashboardStore);
  private readonly api = inject(ApiService);

  protected readonly laneFilter = signal<LaneFilter>('all');
  protected readonly outcomeFilter = signal<OutcomeFilter>('all');

  protected readonly runs = signal<RunRow[]>([]);
  protected readonly runsLoading = signal(false);
  protected readonly runsError = signal<string | null>(null);

  protected readonly drain = signal<DrainSnapshot | null>(null);
  protected readonly drainError = signal<string | null>(null);

  protected readonly selected = signal<RunRow | null>(null);
  protected readonly selectedSession = signal<string | null>(null);
  protected readonly detailRows = signal<MessageRow[]>([]);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;
  private detailSeq = 0;

  protected readonly queues = computed(() => this.store.queues());
  protected readonly running = computed(() => this.store.queues()?.running ?? null);

  protected readonly lanes: LaneFilter[] = ['all', 'primary', 'side', 'drain'];

  protected readonly outcomes: OutcomeFilter[] = ['all', 'completed', 'error', 'timeout', 'declined', 'silent'];

  ngOnInit(): void {
    void this.loadRuns();
    void this.loadDrain();
    this.timer = setInterval(() => {
      void this.loadRuns();
      void this.loadDrain();
    }, REFRESH_MS);
  }

  ngOnDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  protected fmtTime = fmtTime;
  protected fmtDuration = fmtDuration;
  protected fmtTokens = fmtTokens;

  protected async loadRuns(): Promise<void> {
    if (this.runsLoading()) return;
    this.runsLoading.set(true);
    try {
      const lane = this.laneFilter();
      const outcome = this.outcomeFilter();
      const snapshot = await this.api.runs({
        limit: 50,
        ...(lane === 'all' ? {} : { lane }),
        ...(outcome === 'all' ? {} : { outcome }),
      });
      this.runs.set(snapshot.runs);
      this.runsError.set(snapshot.available ? null : (snapshot.error ?? 'runs unavailable'));
    } catch (err) {
      this.runs.set([]);
      this.runsError.set(errorText(err));
    } finally {
      this.runsLoading.set(false);
    }
  }

  protected async loadDrain(): Promise<void> {
    try {
      const snap = await this.api.drain();
      this.drain.set(snap);
      this.drainError.set(snap.available ? null : (snap.error ?? 'drain unavailable'));
    } catch (err) {
      this.drain.set(null);
      // An older backend answers 404 — degrade quietly to "no card".
      this.drainError.set(errorText(err));
    }
  }

  /** Next wake as a relative duration, or a static label. */
  protected fmtNextDue(nextDue: number | null): string {
    if (nextDue === null) return '—';
    const delta = nextDue - Date.now();
    if (delta <= 0) return 'due now';
    return `in ${fmtDuration(delta)}`;
  }

  protected setLane(lane: LaneFilter): void {
    if (this.laneFilter() === lane) return;
    this.laneFilter.set(lane);
    void this.loadRuns();
  }

  protected setOutcome(outcome: OutcomeFilter): void {
    if (this.outcomeFilter() === outcome) return;
    this.outcomeFilter.set(outcome);
    void this.loadRuns();
  }

  protected laneLabel(item: QueueItemView): string {
    return item.title ?? item.id;
  }

  protected transcriptTargets(run: RunRow): Array<{ label: string; session: string }> {
    const out: Array<{ label: string; session: string }> = [];
    if (run.session) out.push({ label: 'transcript', session: run.session });
    if (run.tool_session && run.tool_session !== run.session) out.push({ label: 'writer', session: run.tool_session });
    return out;
  }

  protected async openTranscript(run: RunRow, session: string): Promise<void> {
    const directory = this.store.health()?.directory;
    const seq = ++this.detailSeq;
    this.selected.set(run);
    this.selectedSession.set(session);
    this.detailRows.set([]);
    this.detailError.set(null);
    if (!directory) {
      this.detailError.set('backend directory unavailable');
      return;
    }
    this.detailLoading.set(true);
    try {
      const rows = await this.api.sessionMessages(session, directory);
      if (seq !== this.detailSeq) return;
      this.detailRows.set(rows);
    } catch (err) {
      if (seq !== this.detailSeq) return;
      this.detailError.set(errorText(err));
    } finally {
      if (seq === this.detailSeq) this.detailLoading.set(false);
    }
  }

  protected closeTranscript(): void {
    this.detailSeq++;
    this.selected.set(null);
    this.selectedSession.set(null);
    this.detailRows.set([]);
    this.detailError.set(null);
    this.detailLoading.set(false);
  }
}
