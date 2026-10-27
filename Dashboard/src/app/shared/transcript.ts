import { Component, ElementRef, computed, effect, input, signal, viewChild } from '@angular/core';

import { fmtTime } from '../core/format';
import { TranscriptEntry } from '../core/models';

type Filter = 'all' | 'message' | 'thought' | 'tool';

@Component({
  selector: 'db-transcript',
  template: `
    <div class="transcript">
      <div class="transcript__bar">
        <div class="seg">
          @for (option of filters; track option.id) {
            <button
              type="button"
              class="seg__btn"
              [class.seg__btn--on]="filter() === option.id"
              (click)="filter.set(option.id)"
            >
              {{ option.label }}
            </button>
          }
        </div>
        <div class="transcript__tools">
          <label class="check">
            <input type="checkbox" [checked]="follow()" (change)="toggleFollow($event)" />
            follow
          </label>
          <label class="check">
            <input type="checkbox" [checked]="collapse()" (change)="toggleCollapse($event)" />
            collapse tools
          </label>
          <span class="mono dim">{{ visible().length }} items</span>
        </div>
      </div>
      <div #body class="transcript__body" [class.transcript__body--collapse]="collapse()">
        @for (entry of visible(); track entry.id) {
          @switch (entry.kind) {
            @case ('tool') {
              <details class="msg msg--tool">
                <summary>
                  <span class="tag tag--ghost">tool</span>
                  <span class="mono">{{ entry.label }}</span>
                  @if (entry.status) {
                    <span class="tag" [class]="'tag tag--' + (entry.status === 'completed' ? 'success' : 'warning')">
                      {{ entry.status }}
                    </span>
                  }
                  <span class="msg__time mono">{{ fmtTime(entry.ts) }}</span>
                </summary>
                <pre class="mono">{{ entry.body }}</pre>
              </details>
            }
            @case ('thought') {
              <article class="msg msg--thought">
                <header class="msg__head">
                  <span class="msg__role mono">thought</span>
                  <span class="msg__time mono">{{ fmtTime(entry.ts) }}</span>
                </header>
                <p class="part-thought">{{ entry.body }}</p>
              </article>
            }
            @default {
              <article class="msg" [class.msg--user]="entry.role === 'user'">
                <header class="msg__head">
                  <span class="msg__role mono" [class.msg__role--assistant]="entry.role === 'assistant'">
                    {{ entry.label }}
                  </span>
                  <span class="msg__time mono">{{ fmtTime(entry.ts) }}</span>
                </header>
                <p class="part-text">{{ entry.body }}</p>
              </article>
            }
          }
        } @empty {
          <p class="empty">no transcript yet — waiting for a mission session</p>
        }
      </div>
    </div>
  `,
})
export class Transcript {
  readonly entries = input<TranscriptEntry[]>([]);

  protected readonly filter = signal<Filter>('all');
  protected readonly follow = signal(true);
  protected readonly collapse = signal(false);

  private readonly bodyRef = viewChild<ElementRef<HTMLElement>>('body');

  constructor() {
    effect(() => {
      this.entries();
      this.filter();
      this.collapse();
      if (!this.follow()) return;
      setTimeout(() => {
        const el = this.bodyRef()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
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

  protected toggleFollow(event: Event): void {
    this.follow.set((event.target as HTMLInputElement).checked);
  }

  protected toggleCollapse(event: Event): void {
    this.collapse.set((event.target as HTMLInputElement).checked);
  }
}
