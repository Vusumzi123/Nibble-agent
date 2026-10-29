import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { DashboardStore } from './core/store';
import { ThemeService } from './core/theme';

function create() {
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  TestBed.flushEffects();
  return fixture;
}

function key(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('App shell', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient()],
    });
    vi.spyOn(DashboardStore.prototype, 'start').mockImplementation(() => Promise.resolve());
    vi.spyOn(DashboardStore.prototype, 'stop').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('boots the store, renders topbar, status strip and nav', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(DashboardStore.prototype.start).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.brand__name')?.textContent?.trim()).toBe('NIBBLE');
    expect(root.querySelector('db-status-strip')).toBeTruthy();
    expect(root.querySelector('router-outlet')).toBeTruthy();
    const links = [...root.querySelectorAll('.nav__link')];
    expect(links).toHaveLength(6);
    expect(links.map((l) => l.textContent?.trim())).toEqual(['1flight', '2metrics', '3queue', '4missions', '5logs', '6settings']);
  });

  it('shows the offline pill and banner when the backend is down and not loading', () => {
    const store = TestBed.inject(DashboardStore);
    store.loading.set(false);
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.pill--demo')).toBeTruthy();
    expect(root.querySelector('.pill')?.textContent).toContain('offline');
    expect(root.querySelector('.offline-banner')?.textContent).toContain('backend unreachable');
  });

  it('hides the offline banner while the first load is in flight', () => {
    const fixture = create();
    expect((fixture.nativeElement as HTMLElement).querySelector('.offline-banner')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.pill')?.textContent).toContain('offline');
  });

  it('toggles the command palette with Ctrl+K and closes it with Escape', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.palette')).toBeNull();

    key({ key: 'k', ctrlKey: true });
    fixture.detectChanges();
    expect(root.querySelector('.palette')).toBeTruthy();

    key({ key: 'Escape' });
    fixture.detectChanges();
    expect(root.querySelector('.palette')).toBeNull();
  });

  it('navigates with number keys but ignores them while typing', () => {
    const fixture = create();
    const router = TestBed.inject(Router);
    const spy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    key({ key: '3' });
    expect(spy).toHaveBeenCalledWith('/queues');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('routes palette picks: go:/density:/refresh', () => {
    const fixture = create();
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const reloadSpy = vi.spyOn(TestBed.inject(DashboardStore), 'reload').mockResolvedValue(undefined);
    const comp = fixture.componentInstance as unknown as { runPalette(id: string): void };

    comp.runPalette('go:/logs');
    expect(navSpy).toHaveBeenCalledWith('/logs');

    comp.runPalette('mission:m1');
    expect(navSpy).toHaveBeenLastCalledWith('/missions');

    const theme = TestBed.inject(ThemeService);
    comp.runPalette('density:comfortable');
    expect(theme.density()).toBe('comfortable');
    comp.runPalette('accent:amber');
    expect(theme.accent()).toBe('amber');

    comp.runPalette('action:refresh');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('opens the palette from the topbar button', () => {
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[title*="Command palette"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(root.querySelector('.palette')).toBeTruthy();
  });
});
