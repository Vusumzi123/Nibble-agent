import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { DashboardStore } from '../core/store';
import { StatusStrip } from './status-strip';

function mockStore() {
  return {
    online: signal(true),
    health: signal({ directory: '/x', serve_url: 'http://127.0.0.1:4097' }),
    current: signal<{ tick?: number; phase?: string; state?: string; mission?: string | null; side_mission?: string | null } | null>(null),
    schedule: signal<{ level?: number } | null>(null),
    lastRun: signal<{ model?: string; over_budget?: boolean } | null>(null),
    cost: signal<{ total?: number; today?: number } | null>(null),
    errors: signal<null>(null),
    queueWait: signal<null>(null),
    queues: signal<{ total?: number; due?: number } | null>({ total: 3, due: 1 }),
    drain: signal<{ state?: string } | null>(null),
    budget: signal(100_000),
    lastTokens: signal(12_345),
    pendingTurns: signal(4),
    oldestQueue: signal(60_000),
    overruns: signal(1),
    tickRemaining: signal('45s'),
    heartbeat: signal<{ lock_stale?: boolean } | null>(null),
    cadenceSpark: signal([1, 2, 3]),
    burnSpark: signal([4, 5]),
    costSpark: signal([]),
    errorSpark: signal([0, 1]),
    costPerRun: signal(0.42),
    drainLag: signal(0),
    errorRate: signal(5),
    errorCount: signal(2),
    runCount: signal(40),
  };
}

function create(overrides: Record<string, unknown> = {}) {
  const store = mockStore();
  Object.assign(store, overrides);
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: DashboardStore, useValue: store }],
  });
  const fixture = TestBed.createComponent(StatusStrip);
  fixture.detectChanges();
  return { fixture, store };
}

describe('StatusStrip', () => {
  it('renders all eight cells', () => {
    const { fixture } = create();
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('.cell');
    expect(cells).toHaveLength(8);
  });

  it('reports the backend as live with its host when online', () => {
    const { fixture } = create();
    const backend = (fixture.nativeElement as HTMLElement).querySelector('.cell') as HTMLElement;
    expect(backend.querySelector('.cell__value')?.textContent?.trim()).toBe('live');
    expect(backend.querySelector('.cell__sub')?.textContent).toContain('127.0.0.1:4097');
    expect(backend.classList.contains('cell--success')).toBe(true);
  });

  it('flips to offline with a danger tone when the backend drops', () => {
    const { fixture } = create({ online: signal(false) });
    const backend = (fixture.nativeElement as HTMLElement).querySelector('.cell') as HTMLElement;
    expect(backend.querySelector('.cell__value')?.textContent?.trim()).toBe('offline');
    expect(backend.querySelector('.cell__sub')?.textContent).toContain('retrying every 4s');
    expect(backend.classList.contains('cell--danger')).toBe(true);
  });

  it('embeds sparklines only for cells with a series', () => {
    const { fixture } = create();
    const sparks = (fixture.nativeElement as HTMLElement).querySelectorAll('db-spark');
    expect(sparks).toHaveLength(3);
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('.cell');
    expect(cells[1].classList.contains('cell--spark')).toBe(true);
    expect(cells[0].classList.contains('cell--spark')).toBe(false);
  });

  it('navigates to the cell route on click', () => {
    const { fixture } = create();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('.cell');
    (cells[2] as HTMLElement).click();
    expect(spy).toHaveBeenCalledWith('/flight');
  });

  it('computes queue tone from the oldest item age', () => {
    const { fixture, store } = create();
    const queueCell = () => (fixture.nativeElement as HTMLElement).querySelectorAll('.cell')[5];
    expect(queueCell().classList.contains('cell--success')).toBe(true);
    store.oldestQueue.set(31 * 60_000);
    fixture.detectChanges();
    expect(queueCell().classList.contains('cell--warning')).toBe(true);
    store.oldestQueue.set(46 * 60_000);
    fixture.detectChanges();
    expect(queueCell().classList.contains('cell--danger')).toBe(true);
  });
});
