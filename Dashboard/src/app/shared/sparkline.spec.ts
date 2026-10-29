import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { Sparkline } from './sparkline';

function create(props: Record<string, unknown> = {}) {
  const fixture = TestBed.createComponent(Sparkline);
  for (const [name, value] of Object.entries(props)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return fixture;
}

describe('Sparkline', () => {
  it('renders an svg with the tone class', () => {
    const fixture = create({ points: [1, 2, 3], tone: 'success' });
    const svg = fixture.nativeElement.querySelector('svg.spark') as SVGElement;
    expect(svg).toBeTruthy();
    expect(svg.classList.contains('spark--success')).toBe(true);
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 44');
  });

  it('flattens to a mid-line when there are no points', () => {
    const fixture = create({ points: [] });
    expect(fixture.componentInstance.line()).toBe('0,22 100,22');
    const polyline = fixture.nativeElement.querySelector('polyline') as SVGElement;
    expect(polyline.getAttribute('points')).toBe('0,22 100,22');
  });

  it('maps values across the full width with one point per value', () => {
    const fixture = create({ points: [10, 20, 30], height: 44 });
    const coords = fixture.componentInstance.line().split(' ');
    expect(coords).toHaveLength(3);
    expect(coords[0]).toBe('0.0,42.0');
    expect(coords[2]).toBe('100.0,2.0');
  });

  it('hides the area polygon when area is disabled', () => {
    const withArea = create({ points: [1, 2] });
    expect(withArea.nativeElement.querySelector('polygon.spark__area')).toBeTruthy();
    const withoutArea = create({ points: [1, 2], area: false });
    expect(withoutArea.nativeElement.querySelector('polygon.spark__area')).toBeNull();
  });

  it('keeps a single-value series on a flat line', () => {
    const fixture = create({ points: [7] });
    expect(fixture.componentInstance.line()).toBe('0,22 100,22');
  });
});
