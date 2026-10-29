import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { MissionsPage } from './missions';

function create() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
  const fixture = TestBed.createComponent(MissionsPage);
  fixture.detectChanges();
  TestBed.flushEffects();
  return fixture;
}

describe('MissionsPage', () => {
  it('renders the missions grid', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.page')).toBeTruthy();
    expect(root.querySelector('.grid-3-1')).toBeTruthy();
    expect(root.querySelectorAll('section.panel').length).toBeGreaterThan(0);
  });

  it('derives counts from an empty mission list without crashing', () => {
    const fixture = create();
    const comp = fixture.componentInstance as unknown as {
      enabledCount: () => number;
      overlayCount: () => number;
      lockedCount: () => number;
    };
    expect(comp.enabledCount()).toBe(0);
    expect(comp.overlayCount()).toBe(0);
    expect(comp.lockedCount()).toBe(0);
  });
});
