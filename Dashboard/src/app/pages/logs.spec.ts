import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { LogsPage } from './logs';

function create() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
  const fixture = TestBed.createComponent(LogsPage);
  fixture.detectChanges();
  TestBed.flushEffects();
  return fixture;
}

describe('LogsPage', () => {
  it('renders the ledger index and log pane', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.page--fill')).toBeTruthy();
    expect(root.querySelector('.logs')).toBeTruthy();
    expect(root.querySelector('.logs__index')).toBeTruthy();
  });

  it('reports the not-loaded state while the backend has never answered', () => {
    const fixture = create();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('not loaded');
  });

  it('stops its tail interval on destroy', () => {
    const fixture = create();
    const comp = fixture.componentInstance as unknown as { timer: ReturnType<typeof setInterval> | null };
    expect(comp.timer).not.toBeNull();
    fixture.destroy();
    expect(comp.timer).toBeNull();
  });
});
