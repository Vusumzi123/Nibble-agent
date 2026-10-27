import { Component, input } from '@angular/core';

import { Sparkline } from './sparkline';

@Component({
  selector: 'db-metric-panel',
  imports: [Sparkline],
  template: `
    <section class="panel mp">
      <header class="panel__head mp__head">
        <span class="panel__title">{{ label() }}</span>
        <span class="tag" [class]="'tag tag--' + tagTone()">{{ caveat() }}</span>
      </header>
      <div class="mp__body">
        <div class="mp__figure">
          <span class="mp__value mono" [class.mp__value--gap]="caveat() === 'gap'">{{ value() }}</span>
          <span class="mp__unit">{{ unit() }}</span>
        </div>
        <db-spark class="mp__spark" [points]="points()" [tone]="tone()" [height]="44" />
        <div class="mp__foot">
          <span class="mp__note mono">{{ note() }}</span>
          <span class="mp__caveat">{{ footnote() }}</span>
        </div>
      </div>
    </section>
  `,
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
