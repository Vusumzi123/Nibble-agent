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
  templateUrl: './app.html',
  styleUrl: './app.css',
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
