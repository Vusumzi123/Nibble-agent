import { Injectable, signal } from '@angular/core';

export type ThemeId = 'dark' | 'light' | 'green-crt';

export interface ThemeEntry {
  id: ThemeId;
  label: string;
}

export const THEMES: ThemeEntry[] = [
  { id: 'dark', label: 'dark' },
  { id: 'light', label: 'light' },
  { id: 'green-crt', label: 'green-crt' },
];

// Phosphorstrap theming: one attribute on <html> flips the whole UI.
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly themes = THEMES;
  readonly current = signal<ThemeId>('dark');

  set(id: ThemeId): void {
    document.documentElement.dataset['theme'] = id;
    this.current.set(id);
  }
}
