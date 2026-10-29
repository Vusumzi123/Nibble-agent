import { Component, computed, inject, signal } from '@angular/core';

import { errorText } from '../core/api';
import { fmtCost } from '../core/format';
import { Mission } from '../core/models';
import { DashboardStore } from '../core/store';
import { UiService } from '../core/ui';

interface Draft {
  id: string;
  min_level: number;
  frequency: string;
  menus: string[];
}

@Component({
  selector: 'db-missions-page',
  templateUrl: './missions.html',
  styleUrl: './missions.css',
})
export class MissionsPage {
  protected readonly store = inject(DashboardStore);
  private readonly ui = inject(UiService);

  protected readonly expanded = signal<string | null>(null);
  protected readonly pending = signal<string | null>(null);
  protected readonly saving = signal<string | null>(null);
  protected readonly draft = signal<Draft>({ id: '', min_level: 0, frequency: 'mid', menus: [] });

  protected readonly levels = [0, 1, 2, 3, 4];
  protected readonly frequencies = ['high', 'mid', 'low'];

  protected fmtCost = fmtCost;

  protected readonly enabledCount = computed(() => this.store.missions().filter((m) => m.enabled).length);
  protected readonly overlayCount = computed(() => this.store.missions().filter((m) => m.overlay !== null).length);
  protected readonly lockedCount = computed(() => this.store.missions().filter((m) => this.locked(m)).length);
  protected readonly fileOffCount = computed(() => this.store.missions().filter((m) => !m.file_enabled).length);
  protected readonly minLevel = computed(() =>
    this.store.missions().length ? Math.min(...this.store.missions().map((m) => m.min_level)) : 0,
  );

  protected readonly candidacy = computed(() => {
    const counts = new Map<string, number>();
    for (const mission of this.store.missions()) counts.set(mission.candidacy, (counts.get(mission.candidacy) ?? 0) + 1);
    const total = this.store.missions().length || 1;
    return [...counts.entries()].map(([name, count]) => ({ name, count, pct: (count / total) * 100 }));
  });

  private readonly runStats = computed(() => {
    const map = new Map<string, { runs: number; cost: number; last: string | null }>();
    for (const run of this.store.runs()) {
      const key = run.mission ?? 'unknown';
      const row = map.get(key) ?? { runs: 0, cost: 0, last: run.outcome };
      row.runs += 1;
      row.cost += run.cost ?? 0;
      map.set(key, row);
    }
    return map;
  });

  protected stats(id: string): { runs: number; cost: number; last: string | null } {
    return this.runStats().get(id) ?? { runs: 0, cost: 0, last: null };
  }

  protected locked(mission: Mission): boolean {
    return !mission.enabled && !mission.file_enabled;
  }

  protected expand(mission: Mission): void {
    if (this.expanded() === mission.id) {
      this.expanded.set(null);
      return;
    }
    this.expanded.set(mission.id);
    this.resetDraft(mission);
  }

  protected resetDraft(mission: Mission): void {
    const overlay = mission.overlay ?? {};
    this.draft.set({
      id: mission.id,
      min_level: typeof overlay['min_level'] === 'number' ? (overlay['min_level'] as number) : mission.min_level,
      frequency: typeof overlay['frequency'] === 'string' ? (overlay['frequency'] as string) : mission.frequency,
      menus: Array.isArray(overlay['menus']) ? ([...(overlay['menus'] as string[])] as string[]) : [...mission.menus],
    });
  }

  protected levelsFor(mission: Mission): number[] {
    return this.levels.filter((level) => level >= mission.file_min_level);
  }

  protected frequenciesFor(mission: Mission): string[] {
    const rank = { high: 0, mid: 1, low: 2 };
    const floor = rank[mission.file_frequency as keyof typeof rank] ?? 0;
    return this.frequencies.slice(floor);
  }

  protected menuOptions(mission: Mission): string[] {
    const base = mission.base_menus.includes('both') ? ['day', 'night'] : mission.base_menus;
    return base;
  }

  protected setDraft<K extends keyof Draft>(key: K, value: Draft[K]): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }

  protected toggleMenu(menu: string, on: boolean): void {
    this.draft.update((draft) => ({
      ...draft,
      menus: on ? [...new Set([...draft.menus, menu])] : draft.menus.filter((m) => m !== menu),
    }));
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected overlayJson(mission: Mission): string {
    return JSON.stringify(mission.overlay ?? {}, null, 2);
  }

  protected async toggle(mission: Mission, event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    this.pending.set(mission.id);
    try {
      await this.store.saveMission({ id: mission.id, enabled });
      this.ui.notify(`${mission.id} ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.ui.notify(errorText(err), 'danger');
    } finally {
      this.pending.set(null);
    }
  }

  protected async save(mission: Mission): Promise<void> {
    const draft = this.draft();
    this.saving.set(mission.id);
    try {
      await this.store.saveMission({
        id: mission.id,
        min_level: draft.min_level,
        frequency: draft.frequency,
        menus: draft.menus,
      });
      this.ui.notify(`${mission.id} overlay saved`, 'success');
    } catch (err) {
      this.ui.notify(errorText(err), 'danger');
    } finally {
      this.saving.set(null);
    }
  }

  protected tone(outcome: string | null): string {
    switch (outcome) {
      case 'completed':
        return 'success';
      case 'error':
      case 'aborted':
        return 'danger';
      case 'timeout':
      case 'silent':
        return 'warning';
      default:
        return 'ghost';
    }
  }
}
