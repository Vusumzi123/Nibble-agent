import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { CommandPalette, PaletteItem } from './command-palette';

const ITEMS: PaletteItem[] = [
  { id: 'go:/flight', label: 'flight', hint: '/flight · key 1', group: 'go' },
  { id: 'go:/metrics', label: 'metrics', hint: '/metrics · key 2', group: 'go' },
  { id: 'mission:m1', label: 'update security', hint: 'm1 · enabled', group: 'mission' },
];

function create(open = true) {
  const fixture = TestBed.createComponent(CommandPalette);
  fixture.componentRef.setInput('open', open);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.detectChanges();
  TestBed.flushEffects();
  return fixture;
}

function type(fixture: ReturnType<typeof create>, value: string): void {
  const input = (fixture.nativeElement as HTMLElement).querySelector('.palette__input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
}

function key(fixture: ReturnType<typeof create>, k: string): void {
  const input = (fixture.nativeElement as HTMLElement).querySelector('.palette__input') as HTMLInputElement;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  fixture.detectChanges();
}

describe('CommandPalette', () => {
  it('renders nothing while closed and the full list while open', () => {
    const closed = create(false);
    expect((closed.nativeElement as HTMLElement).querySelector('.palette')).toBeNull();
    const open = create(true);
    expect((open.nativeElement as HTMLElement).querySelectorAll('.palette__item')).toHaveLength(3);
  });

  it('filters across group, label and hint', () => {
    const fixture = create();
    type(fixture, 'metrics');
    let items = (fixture.nativeElement as HTMLElement).querySelectorAll('.palette__item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('metrics');
    type(fixture, 'm1');
    items = (fixture.nativeElement as HTMLElement).querySelectorAll('.palette__item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('update security');
    type(fixture, 'nothing here');
    expect((fixture.nativeElement as HTMLElement).querySelector('.empty')?.textContent).toContain('no matches');
  });

  it('navigates the highlight with arrows and emits pick on Enter', () => {
    const fixture = create();
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id) => picked.push(id));

    expect(fixture.nativeElement.querySelectorAll('.palette__item--on')).toHaveLength(1);
    key(fixture, 'ArrowDown');
    const items = (fixture.nativeElement as HTMLElement).querySelectorAll('.palette__item');
    expect(items[1].classList.contains('palette__item--on')).toBe(true);
    key(fixture, 'Enter');
    expect(picked).toEqual(['go:/metrics']);

    key(fixture, 'ArrowUp');
    key(fixture, 'Enter');
    expect(picked).toEqual(['go:/metrics', 'go:/flight']);
  });

  it('clamps the highlight at the list edges', () => {
    const fixture = create();
    key(fixture, 'ArrowUp');
    expect(fixture.nativeElement.querySelectorAll('.palette__item--on')[0].classList.contains('palette__item--on')).toBe(true);
    for (let i = 0; i < 10; i++) key(fixture, 'ArrowDown');
    const items = (fixture.nativeElement as HTMLElement).querySelectorAll('.palette__item');
    expect(items[items.length - 1].classList.contains('palette__item--on')).toBe(true);
  });

  it('emits closed on Escape and on backdrop click', () => {
    const fixture = create();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    key(fixture, 'Escape');
    expect(closed).toHaveBeenCalledTimes(1);
    (fixture.nativeElement.querySelector('.palette-backdrop') as HTMLElement).click();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('clears the query when reopened', () => {
    const fixture = create();
    type(fixture, 'metrics');
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.palette__item')).toHaveLength(1);
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    TestBed.flushEffects();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.palette__item')).toHaveLength(3);
  });
});
