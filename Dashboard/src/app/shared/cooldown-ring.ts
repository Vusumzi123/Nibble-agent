import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'db-cooldown-ring',
  templateUrl: './cooldown-ring.html',
  styleUrl: './cooldown-ring.css',
})
export class CooldownRing {
  readonly totalMs = input(0);
  readonly remainingMs = input(0);

  readonly pct = computed(() => {
    const total = this.totalMs();
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, this.remainingMs() / total));
  });

  readonly offset = computed(() => 100 * (1 - this.pct()));

  readonly tone = computed(() => {
    if (this.pct() <= 0) return 'danger';
    return this.pct() < 0.25 ? 'warning' : 'primary';
  });

  readonly label = computed(() => {
    const totalMin = Math.max(1, Math.round(Math.max(0, this.totalMs()) / 60_000));
    const remaining = Math.max(0, this.remainingMs());
    if (remaining <= 0) return `resume cooldown elapsed (${totalMin}m)`;
    const remainingMin = Math.max(1, Math.ceil(remaining / 60_000));
    return `resume cooldown: ${remainingMin} of ${totalMin} minutes remaining`;
  });
}
