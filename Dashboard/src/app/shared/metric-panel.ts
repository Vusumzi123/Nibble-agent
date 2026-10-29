import { Component, input } from '@angular/core';

import { Sparkline } from './sparkline';

@Component({
  selector: 'db-metric-panel',
  imports: [Sparkline],
  templateUrl: './metric-panel.html',
  styleUrl: './metric-panel.css',
})
export class MetricPanel {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly unit = input('');
  readonly note = input('');
  readonly footnote = input('');
  readonly caveat = input<'live' | 'demo' | 'gap'>('live');
  readonly tone = input<'primary' | 'success' | 'danger' | 'warning' | 'muted'>('primary');
  readonly points = input<number[]>([]);

  tagTone(): string {
    switch (this.caveat()) {
      case 'gap':
        return 'warning';
      case 'demo':
        return 'info';
      default:
        return 'success';
    }
  }
}
