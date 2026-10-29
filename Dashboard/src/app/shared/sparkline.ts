import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'db-spark',
  templateUrl: './sparkline.html',
  styleUrl: './sparkline.css',
})
export class Sparkline {
  readonly points = input<number[]>([]);
  readonly tone = input<'primary' | 'success' | 'danger' | 'warning' | 'muted'>('primary');
  readonly height = input(44);
  readonly area = input(true);

  readonly line = computed(() => {
    const values = this.points();
    const h = this.height();
    if (!values.length) return `0,${h / 2} 100,${h / 2}`;
    if (values.length === 1) return `0,${h / 2} 100,${h / 2}`;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * 100;
        const y = h - 2 - ((value - min) / span) * (h - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

  readonly polygon = computed(() => `${this.line()} 100,${this.height()} 0,${this.height()}`);
}
