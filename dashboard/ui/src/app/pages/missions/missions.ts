import { Component, inject, signal } from '@angular/core';

import { errorText } from '../../core/api.service';
import { MissionView } from '../../core/models';
import { DashboardStore } from '../../core/store';

@Component({
  selector: 'app-missions-page',
  templateUrl: './missions.html',
  styleUrl: './missions.css',
})
export class MissionsPage {
  protected readonly store = inject(DashboardStore);

  protected readonly pending = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.store.loadMissions();
  }

  // A mission the file itself disables can never be turned on through the
  // restrict-only overlay, so the switch is locked for it.
  protected locked(m: MissionView): boolean {
    return !m.enabled && !m.file_enabled;
  }

  protected overlayKeys(m: MissionView): string {
    const keys = Object.keys(m.overlay ?? {});
    return keys.length > 0 ? keys.join(', ') : '—';
  }

  protected async refresh(): Promise<void> {
    this.error.set(null);
    await this.store.loadMissions();
  }

  protected async toggle(m: MissionView, enabled: boolean): Promise<void> {
    this.pending.set(m.id);
    this.notice.set(null);
    this.error.set(null);
    try {
      await this.store.toggleMission(m.id, enabled);
      this.notice.set(`${m.id} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.pending.set(null);
    }
  }
}
