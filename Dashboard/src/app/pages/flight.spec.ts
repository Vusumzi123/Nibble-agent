import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { DashboardStore } from '../core/store';
import { FlightPage } from './flight';

function create() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
  const fixture = TestBed.createComponent(FlightPage);
  fixture.detectChanges();
  TestBed.flushEffects();
  return fixture;
}

describe('FlightPage', () => {
  it('renders the flight grid with the live transcript panel', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.page')).toBeTruthy();
    expect(root.querySelector('.grid-flight')).toBeTruthy();
    expect(root.querySelector('db-transcript')).toBeTruthy();
  });

  it('shows an empty queue peek before any work is scheduled', () => {
    const fixture = create();
    const comp = fixture.componentInstance as unknown as { queuePeek: () => unknown[] };
    expect(comp.queuePeek()).toHaveLength(0);
    expect((fixture.nativeElement as HTMLElement).querySelector('.queue-peek')).toBeTruthy();
  });

  it('omits the cooldown ring when not woken', () => {
    const fixture = create();
    expect((fixture.nativeElement as HTMLElement).querySelector('db-cooldown-ring')).toBeNull();
  });

  it('shows the cooldown ring during a woken quiet window', () => {
    const fixture = create();
    const store = TestBed.inject(DashboardStore);
    store.sleep.set({
      status: 'woken',
      since: new Date().toISOString(),
      woken_at: new Date().toISOString(),
      dreams_tonight: 0,
      last_tick: null,
      window: '23:00-08:00',
      quiet: true,
      cooldown_total_ms: 3_600_000,
      cooldown_remaining_ms: 3_600_000,
      available: true,
    });
    store.sleepAt.set(Date.now());
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('db-cooldown-ring')).toBeTruthy();
    expect(root.textContent).toContain('woken');
  });
});
