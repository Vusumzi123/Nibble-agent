import { Component, effect, inject, signal } from '@angular/core';

import { ApiService, errorText } from '../../core/api.service';
import { ConfigSnapshot } from '../../core/models';
import { DashboardStore } from '../../core/store';

@Component({
  selector: 'app-setup-page',
  templateUrl: './setup.html',
  styleUrl: './setup.css',
})
export class SetupPage {
  private readonly api = inject(ApiService);
  private readonly store = inject(DashboardStore);

  protected readonly level = signal(1);
  protected readonly gateScope = signal<'main' | 'all'>('main');
  protected readonly missionBudget = signal('32000');
  protected readonly frequency = signal('12h');
  protected readonly inProgressLock = signal(true);

  protected readonly hbEnabled = signal(true);
  protected readonly longSilence = signal(3);

  protected readonly savingAutonomy = signal(false);
  protected readonly savingHeartbeat = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const cfg = this.store.config();
      if (cfg) this.hydrate(cfg);
    });
  }

  private hydrate(c: ConfigSnapshot): void {
    this.level.set(c.autonomy.level);
    this.gateScope.set(c.autonomy.gate_scope);
    this.missionBudget.set(String(c.autonomy.mission_token_budget));
    this.frequency.set(c.autonomy.heartbeat.frequency);
    this.inProgressLock.set(c.autonomy.heartbeat.in_progress_lock);
    this.hbEnabled.set(c.heartbeat.enabled);
    this.longSilence.set(c.heartbeat.long_silence_factor);
  }

  protected readonly target = () => this.store.health()?.directory ?? '—';
  protected readonly serveUrl = () => this.store.health()?.serve_url ?? '—';

  protected async saveAutonomy(): Promise<void> {
    this.savingAutonomy.set(true);
    this.notice.set(null);
    this.error.set(null);
    try {
      const raw = this.missionBudget().trim();
      const budget: number | 'unlimited' = raw === 'unlimited' ? 'unlimited' : Number(raw);
      if (budget !== 'unlimited' && (!Number.isFinite(budget) || budget < 0)) {
        throw new Error('mission token budget must be a non-negative integer (K tokens) or "unlimited"');
      }
      const result = await this.api.writeConfig('autonomy', {
        level: this.level(),
        gate_scope: this.gateScope(),
        mission_token_budget: budget,
        'heartbeat.frequency': this.frequency().trim(),
        'heartbeat.in_progress_lock': this.inProgressLock(),
      });
      this.notice.set(`autonomy saved: ${Object.keys(result.applied).join(', ')}`);
      await this.store.refreshConfig();
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.savingAutonomy.set(false);
    }
  }

  protected async saveHeartbeat(): Promise<void> {
    this.savingHeartbeat.set(true);
    this.notice.set(null);
    this.error.set(null);
    try {
      const result = await this.api.writeConfig('heartbeat', {
        enabled: this.hbEnabled(),
        long_silence_factor: this.longSilence(),
      });
      this.notice.set(`heartbeat saved: ${Object.keys(result.applied).join(', ')}`);
      await this.store.refreshConfig();
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.savingHeartbeat.set(false);
    }
  }
}
