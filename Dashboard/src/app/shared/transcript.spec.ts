import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { TranscriptEntry } from '../core/models';
import { Transcript } from './transcript';

function entries(...bodies: string[]): TranscriptEntry[] {
  return bodies.map((body, i) => ({
    id: String(i),
    role: 'assistant',
    kind: 'text',
    label: 'agent',
    body,
    ts: 1700000000000 + i,
  }));
}

/** jsdom has no layout: fake the geometry so scroll math can be asserted. */
function fakeLayout(el: HTMLElement, initialScrollTop: number): { get: () => number; set: (v: number) => void } {
  let top = initialScrollTop;
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  return { get: () => top, set: (v) => (top = v) };
}

function bodyOf(fixture: ComponentFixture<Transcript>): HTMLElement {
  return fixture.nativeElement.querySelector('.transcript__body');
}

async function settle(): Promise<void> {
  TestBed.flushEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Transcript', () => {
  it('renders one message per entry and an empty hint when there are none', () => {
    const fixture = TestBed.createComponent(Transcript);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('no transcript yet');
    fixture.componentRef.setInput('entries', entries('a', 'b'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('article.msg')).toHaveLength(2);
    expect(fixture.nativeElement.textContent).toContain('agent');
  });

  it('filters by kind via the segment buttons', () => {
    const fixture = TestBed.createComponent(Transcript);
    fixture.componentRef.setInput('entries', [
      ...entries('plain'),
      { id: 't', role: 'assistant', kind: 'thought', label: 'thought', body: 'hmm', ts: 1 },
      { id: 'x', role: 'assistant', kind: 'tool', label: 'bash · ok', body: '{}', ts: 2, status: 'completed' },
    ]);
    fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('.seg__btn')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent.trim())).toEqual(['all', 'messages', 'thoughts', 'tools']);

    buttons[1].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('article.msg')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('details.msg--tool')).toHaveLength(0);

    buttons[3].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('details.msg--tool')).toHaveLength(1);
  });

  it('toggles the collapse class on the body', () => {
    const fixture = TestBed.createComponent(Transcript);
    fixture.componentRef.setInput('entries', entries('x'));
    fixture.detectChanges();
    const body = bodyOf(fixture);
    expect(body.classList.contains('transcript__body--collapse')).toBe(false);
    const checkbox = [...fixture.nativeElement.querySelectorAll('input[type=checkbox]')].at(-1) as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    fixture.detectChanges();
    expect(bodyOf(fixture).classList.contains('transcript__body--collapse')).toBe(true);
  });

  describe('sticky follow (live)', () => {
    it('pins to the bottom on updates, disengages on scroll-up, re-engages at the bottom', async () => {
      const fixture = TestBed.createComponent(Transcript);
      fixture.detectChanges();
      const el = bodyOf(fixture);
      const layout = fakeLayout(el, 0);
      fixture.componentRef.setInput('entries', entries('one'));
      fixture.detectChanges();
      await settle();
      expect(layout.get()).toBe(1000);

      // user scrolls up -> follow disengages
      layout.set(120);
      el.dispatchEvent(new Event('scroll'));
      expect((fixture.componentInstance as unknown as { follow: () => boolean }).follow()).toBe(false);

      // poll pushes new entries -> no snap back down
      fixture.componentRef.setInput('entries', entries('one', 'two'));
      fixture.detectChanges();
      await settle();
      expect(layout.get()).toBe(120);

      // user returns to the bottom -> follow re-engages
      layout.set(1000);
      el.dispatchEvent(new Event('scroll'));
      expect((fixture.componentInstance as unknown as { follow: () => boolean }).follow()).toBe(true);

      fixture.componentRef.setInput('entries', entries('one', 'two', 'three'));
      fixture.detectChanges();
      await settle();
      expect(layout.get()).toBe(1000);
    });

    it('shows the follow checkbox only in live mode', () => {
      const live = TestBed.createComponent(Transcript);
      live.detectChanges();
      expect(live.nativeElement.textContent).toContain('follow');

      const frozen = TestBed.createComponent(Transcript);
      frozen.componentRef.setInput('live', false);
      frozen.detectChanges();
      expect(frozen.nativeElement.textContent).not.toContain('follow');
      expect(frozen.nativeElement.textContent).toContain('collapse tools');
    });

    it('never scrolls in frozen mode (historical drawer transcripts)', async () => {
      const fixture = TestBed.createComponent(Transcript);
      fixture.componentRef.setInput('live', false);
      fixture.detectChanges();
      const el = bodyOf(fixture);
      const layout = fakeLayout(el, 42);
      fixture.componentRef.setInput('entries', entries('a'));
      fixture.detectChanges();
      await settle();
      expect(layout.get()).toBe(42);

      // even a scroll event must not touch follow state in frozen mode
      layout.set(10);
      el.dispatchEvent(new Event('scroll'));
      expect((fixture.componentInstance as unknown as { follow: () => boolean }).follow()).toBe(true);
      expect(layout.get()).toBe(10);
    });
  });
});
