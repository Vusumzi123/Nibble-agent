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
  template: `
    <div class="page">
      <div class="grid-3-1">
        <section class="panel">
          <header class="panel__head">
            <span class="panel__title">missions</span>
            <span class="head-meta mono">{{ enabledCount() }} / {{ store.missions().length }} enabled</span>
          </header>
          <div class="table-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>mission</th>
                  <th>freq</th>
                  <th class="num">lvl</th>
                  <th>candidacy</th>
                  <th class="num">runs</th>
                  <th class="num">cost</th>
                  <th>last</th>
                  <th class="num">on</th>
                </tr>
              </thead>
              <tbody>
                @for (mission of store.missions(); track mission.id) {
                  <tr class="row-click" (click)="expand(mission)">
                    <td>
                      <span class="mono">{{ mission.id }}</span>
                      <span class="sub">{{ mission.title }}</span>
                      @if (mission.overlay) { <span class="tag tag--warning">overlay</span> }
                      @if (!mission.file_enabled) { <span class="tag tag--ghost">file-off</span> }
                    </td>
                    <td class="mono dim">{{ mission.frequency }}</td>
                    <td class="num mono">{{ mission.min_level }}</td>
                    <td class="mono dim">{{ mission.candidacy }}</td>
                    <td class="num mono">{{ stats(mission.id).runs }}</td>
                    <td class="num mono">{{ fmtCost(stats(mission.id).cost) }}</td>
                    <td>
                      @if (stats(mission.id).last) {
                        <span class="tag" [class]="'tag tag--' + tone(stats(mission.id).last)">{{ stats(mission.id).last }}</span>
                      } @else {
                        <span class="dim">—</span>
                      }
                    </td>
                    <td class="num">
                      <label class="switch" (click)="$event.stopPropagation()">
                        <input
                          type="checkbox"
                          [checked]="mission.enabled"
                          [disabled]="locked(mission) || pending() === mission.id"
                          (change)="toggle(mission, $event)"
                        />
                        <span class="switch__track"></span>
                      </label>
                    </td>
                  </tr>

                  @if (expanded() === mission.id) {
                    <tr class="detail-row">
                      <td colspan="8">
                        <div class="mission-detail">
                          <dl class="kv kv--dense">
                            <dt>file enabled</dt><dd class="mono">{{ mission.file_enabled ? 'yes' : 'no' }}</dd>
                            <dt>menus (file)</dt><dd class="mono">{{ mission.base_menus.join(', ') || '—' }}</dd>
                            <dt>approval</dt><dd class="mono">{{ mission.approval }}</dd>
                            <dt>agent</dt><dd class="mono">{{ mission.agent || '—' }}</dd>
                            <dt>restricted</dt>
                            <dd class="mono">{{ locked(mission) ? 'yes — overlay cannot re-enable' : 'no' }}</dd>
                          </dl>

                          <div class="overlay-editor">
                            <span class="label">restrict-only overlay</span>
                            <div class="overlay-editor__row">
                              <label class="field-inline">
                                <span class="label">min level</span>
                                <select class="input input--sm" [value]="draft().min_level" (change)="setDraft('min_level', +value($event))">
                                  @for (level of levelsFor(mission); track level) {
                                    <option [value]="level" [selected]="draft().min_level === level">{{ level }}</option>
                                  }
                                </select>
                              </label>
                              <label class="field-inline">
                                <span class="label">frequency</span>
                                <select class="input input--sm" [value]="draft().frequency" (change)="setDraft('frequency', value($event))">
                                  @for (freq of frequenciesFor(mission); track freq) {
                                    <option [value]="freq" [selected]="draft().frequency === freq">{{ freq }}</option>
                                  }
                                </select>
                              </label>
                              <span class="field-inline">
                                <span class="label">menus</span>
                                @for (menu of menuOptions(mission); track menu) {
                                  <label class="check">
                                    <input
                                      type="checkbox"
                                      [checked]="draft().menus.includes(menu)"
                                      (change)="toggleMenu(menu, checked($event))"
                                    />
                                    {{ menu }}
                                  </label>
                                }
                              </span>
                              <span class="spacer"></span>
                              <button type="button" class="ibtn" (click)="resetDraft(mission)">reset</button>
                              <button
                                type="button"
                                class="ibtn ibtn--primary"
                                [disabled]="saving() === mission.id"
                                (click)="save(mission)"
                              >
                                {{ saving() === mission.id ? 'saving…' : 'save overlay' }}
                              </button>
                            </div>
                            @if (mission.overlay_rejects.length) {
                              <p class="hint warn">{{ mission.overlay_rejects.join(' · ') }}</p>
                            }
                            <pre class="mono overlay-json">{{ overlayJson(mission) }}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="8" class="empty">no missions found</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <div class="stack">
          <section class="panel">
            <header class="panel__head"><span class="panel__title">overlay contract</span></header>
            <div class="panel__body">
              <p class="prose">
                The overlay is <strong>restrict-only</strong>: disable, raise the level, move frequency
                toward low, or narrow menus. Widening is rejected by the harness.
              </p>
              <dl class="kv kv--dense">
                <dt>overrides</dt><dd class="mono">{{ overlayCount() }}</dd>
                <dt>locked</dt><dd class="mono">{{ lockedCount() }}</dd>
                <dt>file-off</dt><dd class="mono">{{ fileOffCount() }}</dd>
                <dt>min level</dt><dd class="mono">L{{ minLevel() }}</dd>
              </dl>
            </div>
          </section>

          <section class="panel">
            <header class="panel__head"><span class="panel__title">candidacy</span></header>
            <div class="panel__body">
              @for (row of candidacy(); track row.name) {
                <div class="cand">
                  <span class="cand__name mono">{{ row.name }}</span>
                  <span class="cand__count mono">{{ row.count }}</span>
                  <div class="cand__bar"><span [style.width.%]="row.pct"></span></div>
                </div>
              }
            </div>
          </section>

          <section class="panel">
            <header class="panel__head"><span class="panel__title">note</span></header>
            <div class="panel__body prose dim">
              Writes go to <span class="mono">autonomy.missions.&lt;id&gt;</span> and preserve the
              rest of the config comment layout. Enabling only removes the overlay; a file-disabled
              mission cannot be revived here.
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
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
