import { Injectable, signal } from '@angular/core';

export type ThemeId = 'nibble' | 'nibble-light';
export type AccentId = 'lime' | 'amber' | 'cyan' | 'violet' | 'rose';
export type Density = 'compact' | 'comfortable';

export interface ThemeEntry {
  id: ThemeId;
  label: string;
}

export interface AccentEntry {
  id: AccentId;
  label: string;
  swatch: string;
}

export const THEMES: ThemeEntry[] = [
  { id: 'nibble', label: 'nibble' },
  { id: 'nibble-light', label: 'nibble light' },
];

export const ACCENTS: AccentEntry[] = [
  { id: 'lime', label: 'lime', swatch: '#c6f36b' },
  { id: 'amber', label: 'amber', swatch: '#f5c76b' },
  { id: 'cyan', label: 'cyan', swatch: '#67e8f9' },
  { id: 'violet', label: 'violet', swatch: '#c4b5fd' },
  { id: 'rose', label: 'rose', swatch: '#fda4af' },
];

const KEY = 'nibble.dashboard.v2';

interface Persisted {
  theme: ThemeId;
  accent: AccentId;
  density: Density;
}

const DEFAULTS: Persisted = { theme: 'nibble', accent: 'lime', density: 'compact' };

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly themes = THEMES;
  readonly accents = ACCENTS;

  readonly theme = signal<ThemeId>(DEFAULTS.theme);
  readonly accent = signal<AccentId>(DEFAULTS.accent);
  readonly density = signal<Density>(DEFAULTS.density);

  constructor() {
    this.restore();
  }

  setTheme(theme: ThemeId): void {
    this.theme.set(theme);
    this.apply();
  }

  setAccent(accent: AccentId): void {
    this.accent.set(accent);
    this.apply();
  }

  setDensity(density: Density): void {
    this.density.set(density);
    this.apply();
  }

  cycleAccent(): void {
    const index = this.accents.findIndex((a) => a.id === this.accent());
    this.setAccent(this.accents[(index + 1) % this.accents.length].id);
  }

  toggleTheme(): void {
    this.setTheme(this.theme() === 'nibble' ? 'nibble-light' : 'nibble');
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Persisted>;
        if (saved.theme === 'nibble' || saved.theme === 'nibble-light') this.theme.set(saved.theme);
        if (this.accents.some((a) => a.id === saved.accent)) this.accent.set(saved.accent as AccentId);
        if (saved.density === 'compact' || saved.density === 'comfortable') this.density.set(saved.density);
      }
    } catch {
      /* first run or storage unavailable */
    }
    try {
      const params = new URLSearchParams(location.search);
      const theme = params.get('theme');
      const accent = params.get('accent');
      const density = params.get('density');
      if (theme === 'nibble' || theme === 'nibble-light') this.theme.set(theme);
      if (this.accents.some((a) => a.id === accent)) this.accent.set(accent as AccentId);
      if (density === 'compact' || density === 'comfortable') this.density.set(density);
    } catch {
      /* no query support */
    }
    this.apply();
  }

  private apply(): void {
    const root = document.documentElement;
    root.dataset['theme'] = this.theme();
    root.dataset['accent'] = this.accent();
    root.dataset['density'] = this.density();
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ theme: this.theme(), accent: this.accent(), density: this.density() }),
      );
    } catch {
      /* storage unavailable */
    }
  }
}
