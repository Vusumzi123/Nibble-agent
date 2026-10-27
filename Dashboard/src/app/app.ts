import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { DashboardStore } from './core/store';
import { ACCENTS, ThemeService } from './core/theme';
import { UiService } from './core/ui';
import { CommandPalette, PaletteItem } from './shared/command-palette';
import { StatusStrip } from './shared/status-strip';

interface NavItem {
  path: string;
  label: string;
  key: string;
}

@Component({
  selector: 'db-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, StatusStrip, CommandPalette],
  host: {
    '(document:keydown)': 'onKey($event)',
  },
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand__mark mono">▚</span>
          <span class="brand__name mono">NIBBLE</span>
          <span class="brand__sub mono">operator console</span>
        </div>

        <div class="topbar__meta">
          <span class="pill" [class.pill--demo]="!store.online()">
            <span class="dot" [class.dot--ok]="store.online()"></span>
            {{ store.online() ? 'live' : 'offline' }}
          </span>
          <span class="meta mono">L{{ store.level() ?? '—' }}</span>
          <span class="meta mono">mood {{ store.moodLabel() }}</span>
          <span class="meta mono">{{ clock() }}</span>
        </div>

        <div class="topbar__actions">
          <button type="button" class="ibtn ibtn--icon" (click)="themeOpen.set(!themeOpen())" title="Theme">
            <span class="swatch" [style.background]="accentHex()"></span>
            <span class="mono">{{ theme.theme() === 'nibble' ? 'dark' : 'light' }}</span>
          </button>
          <button type="button" class="ibtn ibtn--icon" (click)="paletteOpen.set(true)" title="Command palette (⌘K)">
            <span class="mono">⌘K</span>
          </button>
          <button type="button" class="ibtn ibtn--icon" (click)="reload()" [disabled]="store.refreshing()" title="Refresh">
            <span class="mono">{{ store.refreshing() ? '…' : '↻' }}</span>
          </button>
        </div>
      </header>

      <db-status-strip />

      <nav class="nav">
        @for (item of nav; track item.path) {
          <a
            class="nav__link mono"
            [routerLink]="item.path"
            routerLinkActive="nav__link--on"
            [routerLinkActiveOptions]="{ exact: false }"
          >
            <span class="nav__key">{{ item.key }}</span>{{ item.label }}
          </a>
        }
        <span class="spacer"></span>
        <span class="nav__hint mono">1–6 · ⌘K</span>
      </nav>

      @if (!store.online() && !store.loading()) {
        <div class="offline-banner mono">
          <span class="dot dot--demo"></span>
          <span>backend unreachable — {{ store.error() ?? 'no response' }}</span>
          <span class="spacer"></span>
          <span class="dim">retrying every 4s</span>
          <button type="button" class="ibtn" (click)="reload()" [disabled]="store.refreshing()">retry now</button>
        </div>
      }

      <main class="main">
        <router-outlet />
      </main>

      <footer class="footer mono">
        <span>nibble-dashboard v2.0.0</span>
        <span class="dim">·</span>
        <span class="dim">phosphorstrap 0.2.0</span>
        <span class="dim">·</span>
        <span [class.warn]="!store.online()">{{ store.online() ? 'serve ' + (store.health()?.serve_url ?? '—') : 'backend offline' }}</span>
        <span class="spacer"></span>
        <span class="dim">updated {{ updatedLabel() }}</span>
      </footer>
    </div>

    @if (themeOpen()) {
      <div class="popover-backdrop" (click)="themeOpen.set(false)"></div>
      <section class="popover" aria-label="Theme settings">
        <header class="popover__head">
          <span class="panel__title">appearance</span>
          <button type="button" class="ibtn ibtn--ghost" (click)="themeOpen.set(false)">esc</button>
        </header>

        <div class="popover__group">
          <span class="label">theme</span>
          <div class="seg seg--full">
            @for (entry of theme.themes; track entry.id) {
              <button
                type="button"
                class="seg__btn"
                [class.seg__btn--on]="theme.theme() === entry.id"
                (click)="theme.setTheme(entry.id)"
              >
                {{ entry.label }}
              </button>
            }
          </div>
        </div>

        <div class="popover__group">
          <span class="label">accent</span>
          <div class="swatches">
            @for (accent of accents; track accent.id) {
              <button
                type="button"
                class="swatch-btn"
                [class.swatch-btn--on]="theme.accent() === accent.id"
                [title]="accent.label"
                (click)="theme.setAccent(accent.id)"
              >
                <span class="swatch swatch--lg" [style.background]="accent.swatch"></span>
                <span class="mono">{{ accent.label }}</span>
              </button>
            }
          </div>
        </div>

        <div class="popover__group">
          <span class="label">density</span>
          <div class="seg seg--full">
            <button type="button" class="seg__btn" [class.seg__btn--on]="theme.density() === 'compact'" (click)="theme.setDensity('compact')">
              compact
            </button>
            <button type="button" class="seg__btn" [class.seg__btn--on]="theme.density() === 'comfortable'" (click)="theme.setDensity('comfortable')">
              comfortable
            </button>
          </div>
        </div>

        <p class="popover__foot dim">
          persisted locally · accent tints chrome and charts only; status colors stay semantic
        </p>
      </section>
    }

    <db-command-palette
      [open]="paletteOpen()"
      [items]="paletteItems()"
      (pick)="runPalette($event)"
      (closed)="paletteOpen.set(false)"
    />

    @if (ui.toast(); as toast) {
      <div class="toast" [class]="'toast toast--' + toast.tone" (click)="ui.dismiss()">
        <span class="toast__bar"></span>
        <span>{{ toast.message }}</span>
      </div>
    }

    @if (store.loading()) {
      <div class="boot mono">
        <span class="boot__mark">▚</span>
        <span>connecting to dashboard backend…</span>
        <span class="dim">live data from the Kael harness</span>
      </div>
    }
  `,
})
export class App implements OnDestroy {
  protected readonly store = inject(DashboardStore);
  protected readonly theme = inject(ThemeService);
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  protected readonly accents = ACCENTS;
  protected readonly paletteOpen = signal(false);
  protected readonly themeOpen = signal(false);

  protected readonly nav: NavItem[] = [
    { path: '/flight', label: 'flight', key: '1' },
    { path: '/metrics', label: 'metrics', key: '2' },
    { path: '/queues', label: 'queue', key: '3' },
    { path: '/missions', label: 'missions', key: '4' },
    { path: '/logs', label: 'logs', key: '5' },
    { path: '/setup', label: 'settings', key: '6' },
  ];

  protected readonly clock = computed(() =>
    new Date(this.store.now()).toLocaleTimeString([], { hour12: false }),
  );

  protected readonly updatedLabel = computed(() => {
    const ts = this.store.lastUpdated();
    if (!ts) return '—';
    const delta = Math.max(0, this.store.now() - ts);
    return delta < 1500 ? 'now' : `${Math.floor(delta / 1000)}s ago`;
  });

  protected readonly accentHex = computed(
    () => this.accents.find((accent) => accent.id === this.theme.accent())?.swatch ?? '#c6f36b',
  );

  protected readonly paletteItems = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = this.nav.map((item) => ({
      id: `go:${item.path}`,
      label: item.label,
      hint: `${item.path} · key ${item.key}`,
      group: 'go',
    }));
    for (const mission of this.store.missions()) {
      items.push({
        id: `mission:${mission.id}`,
        label: mission.title,
        hint: `${mission.id} · ${mission.enabled ? 'enabled' : 'disabled'}`,
        group: 'mission',
      });
    }
    for (const theme of this.theme.themes) {
      items.push({ id: `theme:${theme.id}`, label: `theme · ${theme.label}`, hint: theme.id, group: 'theme' });
    }
    for (const accent of this.accents) {
      items.push({ id: `accent:${accent.id}`, label: `accent · ${accent.label}`, hint: accent.id, group: 'theme' });
    }
    items.push({ id: 'density:compact', label: 'density · compact', hint: 'dense grid', group: 'theme' });
    items.push({ id: 'density:comfortable', label: 'density · comfortable', hint: 'more breathing room', group: 'theme' });
    items.push({ id: 'action:refresh', label: 'refresh data', hint: 'reload every widget', group: 'action' });
    return items;
  });

  constructor() {
    const params = new URLSearchParams(location.search);
    if (params.get('palette') === '1') this.paletteOpen.set(true);
    if (params.get('appearance') === '1') this.themeOpen.set(true);
    void this.store.start();
  }

  ngOnDestroy(): void {
    this.store.stop();
  }

  protected reload(): void {
    void this.store.reload();
  }

  protected runPalette(id: string): void {
    this.paletteOpen.set(false);
    if (id.startsWith('go:')) {
      void this.router.navigateByUrl(id.slice(3));
    } else if (id.startsWith('mission:')) {
      void this.router.navigateByUrl('/missions');
    } else if (id.startsWith('theme:')) {
      this.theme.setTheme(id.slice(6) as 'nibble' | 'nibble-light');
    } else if (id.startsWith('accent:')) {
      this.theme.setAccent(id.slice(7) as 'lime' | 'amber' | 'cyan' | 'violet' | 'rose');
    } else if (id.startsWith('density:')) {
      this.theme.setDensity(id.slice(8) as 'compact' | 'comfortable');
    } else if (id === 'action:refresh') {
      void this.store.reload();
    }
  }

  protected onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT';

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.paletteOpen.set(!this.paletteOpen());
      return;
    }
    if (event.key === 'Escape') {
      this.paletteOpen.set(false);
      this.themeOpen.set(false);
      return;
    }
    if (typing) return;

    const index = Number(event.key);
    if (Number.isInteger(index) && index >= 1 && index <= this.nav.length) {
      event.preventDefault();
      void this.router.navigateByUrl(this.nav[index - 1].path);
    }
  }
}
