import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MetricPanel } from './metric-panel';

function create(props: Record<string, unknown> = {}) {
  const fixture = TestBed.createComponent(MetricPanel);
  fixture.componentRef.setInput('label', 'tokens');
  fixture.componentRef.setInput('value', '12.3k');
  for (const [name, value] of Object.entries(props)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return fixture;
}

describe('MetricPanel', () => {
  it('renders label, value, unit and footnote', () => {
    const fixture = create({ unit: '/ run', note: '24h', footnote: 'rolling' });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.panel__title')?.textContent?.trim()).toBe('tokens');
    expect(root.querySelector('.mp__value')?.textContent?.trim()).toBe('12.3k');
    expect(root.querySelector('.mp__unit')?.textContent?.trim()).toBe('/ run');
    expect(root.querySelector('.mp__note')?.textContent?.trim()).toBe('24h');
    expect(root.querySelector('.mp__caveat')?.textContent?.trim()).toBe('rolling');
  });

  it('embeds a sparkline fed with the points input', () => {
    const fixture = create({ points: [1, 2, 3] });
    expect(fixture.nativeElement.querySelector('db-spark')).toBeTruthy();
  });

  it('maps caveat to tag tone: live->success, demo->info, gap->warning', () => {
    expect(create({}).nativeElement.querySelector('.tag--success')).toBeTruthy();
    expect(create({ caveat: 'demo' }).nativeElement.querySelector('.tag--info')).toBeTruthy();
    expect(create({ caveat: 'gap' }).nativeElement.querySelector('.tag--warning')).toBeTruthy();
  });

  it('flags gap values with the modifier class', () => {
    expect(create({ caveat: 'gap' }).nativeElement.querySelector('.mp__value--gap')).toBeTruthy();
    expect(create({}).nativeElement.querySelector('.mp__value--gap')).toBeNull();
  });
});
