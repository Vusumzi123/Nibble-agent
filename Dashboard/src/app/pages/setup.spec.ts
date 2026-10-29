import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { SetupPage } from './setup';

function create() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
  const fixture = TestBed.createComponent(SetupPage);
  fixture.detectChanges();
  TestBed.flushEffects();
  return fixture;
}

describe('SetupPage', () => {
  it('renders the settings shell with the runtime target panel', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.page')).toBeTruthy();
    expect(root.querySelector('section.panel')).toBeTruthy();
    expect(root.querySelector('.panel__title')?.textContent?.trim()).toBe('runtime target');
    expect(root.querySelectorAll('.mini-grid .mini').length).toBeGreaterThan(0);
  });

  it('lists no settings sections before the snapshot arrives', () => {
    const fixture = create();
    const comp = fixture.componentInstance as unknown as { sections: () => unknown[] };
    expect(comp.sections()).toEqual([]);
  });
});
