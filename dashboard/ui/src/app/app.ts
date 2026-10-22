import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import type { MemoryPending } from './core/models';
import { DashboardStore } from './core/store';
import { ThemeService } from './theme';

interface NavItem {
  path: string;
  label: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly store = inject(DashboardStore);
  protected readonly theme = inject(ThemeService);

  protected readonly nav: NavItem[] = [
    { path: '/flight', label: 'flight' },
    { path: '/output', label: 'output & thoughts' },
    { path: '/queues', label: 'queues' },
    { path: '/metrics', label: 'metrics' },
    { path: '/missions', label: 'missions' },
    { path: '/setup', label: 'setup' },
  ];

  ngOnInit(): void {
    void this.store.start();
  }

  protected pendingTitle(p: MemoryPending): string {
    if (!p.available) {
      return p.error
        ? `Pending memory unknown — ${p.error}`
        : 'Pending memory unknown — the opencode database is unavailable';
    }
    const turns = p.pending_turns ?? 0;
    const since = p.cursor_last_ts ? new Date(p.cursor_last_ts).toLocaleString() : 'the drain cursor';
    const state = !p.paused
      ? turns > 0
        ? 'consolidation pending'
        : 'memory in sync'
      : p.enabled
        ? `consolidation paused — provider ${p.provider} has no writer`
        : 'consolidation paused — drain disabled';
    return `${turns} unconsumed turn(s) since ${since}${p.seeded ? ' (initial lookback)' : ''} — ${state}`;
  }
}
