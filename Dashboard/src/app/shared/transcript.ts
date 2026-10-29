import { Component, ElementRef, OnDestroy, computed, effect, input, signal, viewChild } from '@angular/core';

import { fmtTime } from '../core/format';
import { TranscriptEntry } from '../core/models';

type Filter = 'all' | 'message' | 'thought' | 'tool';

@Component({
  selector: 'db-transcript',
  templateUrl: './transcript.html',
  styleUrl: './transcript.css',
})
export class Transcript implements OnDestroy {
  readonly entries = input<TranscriptEntry[]>([]);
  /** live panes keep pinning to the bottom; historical ones never scroll. */
  readonly live = input(true);

  protected readonly filter = signal<Filter>('all');
  protected readonly follow = signal(true);
  protected readonly collapse = signal(false);
  protected readonly atBottom = signal(true);

  private readonly bodyRef = viewChild<ElementRef<HTMLElement>>('body');
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      this.entries();
      this.filter();
      this.collapse();
      if (!this.live() || !this.follow() || !this.atBottom()) return;
      if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        this.scrollTimer = null;
        const el = this.bodyRef()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  ngOnDestroy(): void {
    if (this.scrollTimer !== null) clearTimeout(this.scrollTimer);
  }

  protected readonly filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'all' },
    { id: 'message', label: 'messages' },
    { id: 'thought', label: 'thoughts' },
    { id: 'tool', label: 'tools' },
  ];

  protected readonly visible = computed(() => {
    const current = this.filter();
    const entries = this.entries();
    if (current === 'all') return entries;
    if (current === 'message') return entries.filter((e) => e.kind === 'text');
    return entries.filter((e) => e.kind === current);
  });

  protected fmtTime = fmtTime;

  /** Sticky follow: scrolling up disengages, scrolling back to the bottom re-engages. */
  protected onScroll(event: Event): void {
    if (!this.live()) return;
    const el = event.target as HTMLElement;
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    this.atBottom.set(bottom);
    if (bottom) {
      if (!this.follow()) this.follow.set(true);
    } else if (this.follow()) {
      this.follow.set(false);
    }
  }

  protected toggleFollow(event: Event): void {
    this.follow.set((event.target as HTMLInputElement).checked);
  }

  protected toggleCollapse(event: Event): void {
    this.collapse.set((event.target as HTMLInputElement).checked);
  }
}
