import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';

import { fmtBytes, fmtDuration } from '../core/format';
import { DashboardStore } from '../core/store';

@Component({
  selector: 'db-logs-page',
  template: `
    <div class="page page--fill">
      <div class="logs">
        <section class="panel logs__index">
          <header class="panel__head">
            <span class="panel__title">ledgers</span>
            <span class="head-meta mono">{{ store.ledgers().length }}</span>
          </header>
          <div class="ledger-list">
            @for (ledger of store.ledgers(); track ledger.name) {
              <button
                type="button"
                class="ledger"
                [class.ledger--on]="store.selectedLedger() === ledger.name"
                (click)="select(ledger.name)"
              >
                <span class="ledger__name mono">{{ ledger.name }}</span>
                <span class="ledger__meta mono dim">{{ ledger.lines }} ln · {{ fmtBytes(ledger.bytes) }}</span>
              </button>
            } @empty {
              <p class="empty pad">no ledgers</p>
            }
          </div>
        </section>

        <section class="panel logs__view">
          <header class="panel__head">
            <span class="panel__title mono">{{ store.selectedLedger() }}</span>
            <div class="head-tools">
              <label class="check">
                <input type="checkbox" [checked]="tail()" (change)="tail.set(checked($event))" />
                tail
              </label>
              <select class="input input--sm" (change)="level.set(value($event))">
                <option value="all">all levels</option>
                <option value="error">error</option>
                <option value="warn">warn</option>
              </select>
              <select class="input input--sm" (change)="limit.set(+value($event))">
                <option [value]="100">100 lines</option>
                <option [value]="300" selected>300 lines</option>
                <option [value]="1000">1000 lines</option>
              </select>
              <input
                class="input input--sm input--search"
                type="search"
                placeholder="filter…"
                [value]="query()"
                (input)="query.set(value($event))"
              />
              <button type="button" class="ibtn" (click)="refresh()" [disabled]="store.ledgerLoading()">
                {{ store.ledgerLoading() ? '…' : 'refresh' }}
              </button>
              <button type="button" class="ibtn" (click)="download()" [disabled]="visible().length === 0">save</button>
            </div>
          </header>
          <div class="logs__meta">
            <span class="mono dim">{{ visible().length }} / {{ lines().length }} lines</span>
            <span class="mono dim">{{ errorCount() }} errors</span>
            <span class="spacer"></span>
            <span class="mono dim">{{ updatedLabel() }}</span>
          </div>
          <div class="logs__body mono">
            @for (line of visible(); track $index) {
              <div class="logline" [class.logline--error]="levelOf(line) === 'error'" [class.logline--warn]="levelOf(line) === 'warn'">
                <span class="logline__n">{{ lineNo($index) }}</span>
                <span class="logline__text">{{ line }}</span>
              </div>
            } @empty {
              <p class="empty pad">no entries — the ledger is empty or unreadable</p>
            }
          </div>
        </section>
      </div>
    </div>
  `,
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
