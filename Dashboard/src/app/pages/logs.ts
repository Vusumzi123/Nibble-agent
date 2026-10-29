import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';

import { fmtBytes, fmtDuration } from '../core/format';
import { DashboardStore } from '../core/store';

@Component({
  selector: 'db-logs-page',
  templateUrl: './logs.html',
  styleUrl: './logs.css',
})
export class LogsPage implements OnInit, OnDestroy {
  protected readonly store = inject(DashboardStore);

  protected readonly query = signal('');
  protected readonly level = signal('all');
  protected readonly limit = signal(300);
  protected readonly tail = signal(true);

  protected fmtBytes = fmtBytes;

  private timer: ReturnType<typeof setInterval> | null = null;

  protected readonly lines = computed(() => this.store.ledgerEntries()[this.store.selectedLedger()] ?? []);

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const level = this.level();
    const rows = this.lines().filter((line) => {
      if (q && !line.toLowerCase().includes(q)) return false;
      const detected = this.levelOf(line);
      if (level === 'error' && detected !== 'error') return false;
      if (level === 'warn' && detected === 'normal') return false;
      return true;
    });
    return rows.slice(-this.limit());
  });

  protected readonly errorCount = computed(() => this.lines().filter((line) => this.levelOf(line) === 'error').length);

  protected readonly updatedLabel = computed(() => {
    const ts = this.store.lastUpdated();
    return ts ? `refreshed ${fmtDuration(this.store.now() - ts)} ago` : 'not loaded';
  });

  ngOnInit(): void {
    if (this.store.online()) void this.store.loadLedger(this.store.selectedLedger());
    this.timer = setInterval(() => {
      if (this.tail() && this.store.online()) void this.store.loadLedger(this.store.selectedLedger());
    }, 4000);
  }

  ngOnDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  protected select(name: string): void {
    this.store.selectLedger(name);
  }

  protected refresh(): void {
    void this.store.loadLedger(this.store.selectedLedger());
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected levelOf(line: string): 'error' | 'warn' | 'normal' {
    const lower = line.toLowerCase();
    if (lower.includes('"error"') || lower.includes(' error ') || lower.includes('error:') || lower.includes('"outcome":"error"')) {
      return 'error';
    }
    if (lower.includes('warn') || lower.includes('timeout') || lower.includes('silent') || lower.includes('declined')) {
      return 'warn';
    }
    return 'normal';
  }

  protected lineNo(index: number): string {
    return String(index + 1).padStart(3, '0');
  }

  protected download(): void {
    const blob = new Blob([this.visible().join('\n')], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = this.store.selectedLedger();
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
