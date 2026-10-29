import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { fmtAge, fmtCost, fmtDuration, fmtTime, fmtTokens } from '../core/format';
import { DashboardStore } from '../core/store';
import { Transcript } from '../shared/transcript';

@Component({
  selector: 'db-flight-page',
  imports: [Transcript, RouterLink],
  templateUrl: './flight.html',
  styleUrl: './flight.css',
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
