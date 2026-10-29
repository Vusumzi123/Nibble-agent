import { Component, computed, effect, input, output, signal } from '@angular/core';

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  group: string;
}

@Component({
  selector: 'db-command-palette',
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.css',
})
export class CommandPalette {
  readonly open = input(false);
  readonly items = input<PaletteItem[]>([]);
  readonly pick = output<string>();
  readonly closed = output<void>();

  protected readonly query = signal('');
  protected readonly active = signal(0);

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const items = this.items();
    if (!q) return items;
    return items.filter((item) =>
      `${item.group} ${item.label} ${item.hint}`.toLowerCase().includes(q),
    );
  });

  constructor() {
    effect(() => {
      if (this.open()) {
        this.query.set('');
        this.active.set(0);
      }
    });
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.active.set(0);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.active.update((i) => Math.min(this.filtered().length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.active.update((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = this.filtered()[this.active()];
      if (item) this.choose(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
    }
  }

  protected choose(item: PaletteItem): void {
    this.pick.emit(item.id);
  }
}
