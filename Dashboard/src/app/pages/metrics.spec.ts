import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { MetricsPage } from './metrics';

function create() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
  const fixture = TestBed.createComponent(MetricsPage);
  fixture.detectChanges();
  TestBed.flushEffects();
  return fixture;
}

describe('MetricsPage', () => {
  it('renders the metrics grid with all eight metric panels', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.page')).toBeTruthy();
    expect(root.querySelector('.grid-metrics')).toBeTruthy();
    expect(root.querySelectorAll('db-metric-panel')).toHaveLength(8);
  });

  it('renders without crashing on the default (empty) store snapshot', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).not.toContain('undefined');
    expect(root.querySelectorAll('.panel').length).toBeGreaterThan(0);
  });
});
