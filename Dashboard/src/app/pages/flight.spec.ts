import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

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
});
