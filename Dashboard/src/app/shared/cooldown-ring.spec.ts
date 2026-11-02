import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { CooldownRing } from './cooldown-ring';

const MIN = 60_000;

function create(totalMs: number, remainingMs: number) {
  const fixture = TestBed.createComponent(CooldownRing);
  fixture.componentRef.setInput('totalMs', totalMs);
  fixture.componentRef.setInput('remainingMs', remainingMs);
  fixture.detectChanges();
  return fixture;
}

describe('CooldownRing', () => {
  it('renders a full primary ring at the start of the cooldown', () => {
    const fixture = create(60 * MIN, 60 * MIN);
    const svg = fixture.nativeElement.querySelector('svg.ring') as SVGElement;
    expect(svg.classList.contains('ring--primary')).toBe(true);
    expect(fixture.componentInstance.offset()).toBe(0);
    expect(fixture.componentInstance.pct()).toBe(1);
  });

  it('drains the arc as the cooldown elapses', () => {
    const fixture = create(60 * MIN, 15 * MIN);
    expect(fixture.componentInstance.pct()).toBe(0.25);
    expect(fixture.componentInstance.offset()).toBe(75);
    expect(fixture.componentInstance.tone()).toBe('primary');
  });

  it('warns under a quarter remaining', () => {
    const fixture = create(60 * MIN, 10 * MIN);
    const svg = fixture.nativeElement.querySelector('svg.ring') as SVGElement;
    expect(fixture.componentInstance.tone()).toBe('warning');
    expect(svg.classList.contains('ring--warning')).toBe(true);
  });

  it('turns danger and reports the overrun once the cooldown is due', () => {
    const fixture = create(60 * MIN, 0);
    const svg = fixture.nativeElement.querySelector('svg.ring') as SVGElement;
    expect(fixture.componentInstance.tone()).toBe('danger');
    expect(fixture.componentInstance.offset()).toBe(100);
    expect(svg.getAttribute('aria-label')).toContain('elapsed');
  });

  it('clamps a remaining value above the total', () => {
    const fixture = create(60 * MIN, 90 * MIN);
    expect(fixture.componentInstance.pct()).toBe(1);
    expect(fixture.componentInstance.offset()).toBe(0);
  });
});
