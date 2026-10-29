import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ApiService } from '../core/api';
import { DashboardStore } from '../core/store';
import { LoadOverlay } from './load-overlay';

function create(): { fixture: ReturnType<typeof TestBed.createComponent<LoadOverlay>>; store: DashboardStore } {
  TestBed.configureTestingModule({
    providers: [{ provide: ApiService, useValue: {} }],
  });
  const store = TestBed.inject(DashboardStore);
  const fixture = TestBed.createComponent(LoadOverlay);
  fixture.detectChanges();
  return { fixture, store };
}

describe('LoadOverlay', () => {
  it('renders nothing while no blocking load is in flight', () => {
    const { fixture } = create();
    expect(fixture.nativeElement.querySelector('.overlay')).toBeNull();
  });

  it('covers the viewport with a blocking, labelled overlay during a load', () => {
    const { fixture, store } = create();

    store.blockingLabel.set('loading · queues…');
    store.blockingCount.set(1);
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('.overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute('aria-busy')).toBe('true');
    expect(overlay.textContent).toContain('loading · queues…');

    const style = getComputedStyle(overlay);
    expect(style.position).toBe('fixed');
    expect(style.pointerEvents).toBe('auto');
  });

  it('renders the pixel grid', () => {
    const { fixture, store } = create();
    store.blockingCount.set(1);
    fixture.detectChanges();

    const cells = fixture.nativeElement.querySelectorAll('.grid i');
    expect(cells.length).toBe(336);
    expect(fixture.nativeElement.querySelector('.grid')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.label')).toBeTruthy();
  });

  it('disappears once the blocking counter returns to zero', () => {
    const { fixture, store } = create();
    store.blockingCount.set(1);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.overlay')).toBeTruthy();

    store.blockingCount.set(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.overlay')).toBeNull();
  });
});
