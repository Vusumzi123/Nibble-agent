import { provideHttpClient } from '@angular/common/http';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { ApiService } from '../core/api';
import { MessageRow, RunRow } from '../core/models';
import { DashboardStore } from '../core/store';
import { QueuesPage } from './queues';

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    ts: '2026-10-29T10:00:00Z',
    ts_ms: 1793306400000,
    tick: 42,
    mission: 'missions/update-security.md',
    mission_title: 'update security',
    kind: 'mission',
    lane: 'main',
    outcome: 'completed',
    token_cost: 100,
    over_budget: false,
    cost: 0.01,
    model: 'm',
    tokens_in: 50,
    tokens_out: 50,
    tokens_total: 100,
    duration_ms: 1000,
    started_ms: 1,
    finished_ms: 2,
    result_status: 'ok',
    result_missing: false,
    requeued: false,
    session: 'ses_a',
    aborted: false,
    stop_reason: null,
    stalled_for_ms: null,
    error: null,
    ...overrides,
  };
}

function textRow(text: string): MessageRow[] {
  return [{ info: { role: 'assistant', time: { created: 1 } }, parts: [{ type: 'text', text }] }];
}

interface Harness {
  fixture: ComponentFixture<QueuesPage>;
  comp: QueuesPage & Record<string, unknown>;
  store: DashboardStore;
  api: ApiService;
  sessionSpy: ReturnType<typeof vi.spyOn>;
  detailSpy: ReturnType<typeof vi.spyOn>;
}

function createFixture(): Harness {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
  const store = TestBed.inject(DashboardStore);
  store.health.set({ serve_url: 'http://127.0.0.1:4097', directory: '/repo' } as never);
  const api = TestBed.inject(ApiService);
  const sessionSpy = vi.spyOn(api, 'sessionMessages');
  const detailSpy = vi.spyOn(api, 'runDetail').mockResolvedValue({ run: null, session: null });
  const fixture = TestBed.createComponent(QueuesPage);
  fixture.detectChanges();
  return {
    fixture,
    comp: fixture.componentInstance as QueuesPage & Record<string, unknown>,
    store,
    api,
    sessionSpy,
    detailSpy,
  };
}

async function open(h: Harness, run: RunRow): Promise<void> {
  await (h.comp['open'] as (r: RunRow) => Promise<void>)(run);
  h.fixture.detectChanges();
}

function drawer(h: Harness): HTMLElement | null {
  return (h.fixture.nativeElement as HTMLElement).querySelector('.drawer');
}

describe('QueuesPage drawer', () => {
  it('renders the page with the run table', () => {
    const h = createFixture();
    const root = h.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.page')).toBeTruthy();
    expect(root.querySelector('db-run-table')).toBeTruthy();
    expect(drawer(h)).toBeNull();
  });

  it('fetches the clicked run’s own session and renders it frozen', async () => {
    const h = createFixture();
    h.sessionSpy.mockResolvedValueOnce(textRow('hello from A'));

    await open(h, makeRun({ session: 'ses_a' }));

    expect(h.sessionSpy).toHaveBeenCalledWith('ses_a', '/repo');
    const root = h.fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.drawer')).toBeTruthy();
    expect(root.querySelector('.drawer__title')?.textContent).toContain('update security');
    expect(root.querySelector('.drawer')?.textContent).toContain('hello from A');
    expect(root.querySelector('.drawer db-transcript')).toBeTruthy();
    expect(h.comp['drawerLoading'] as () => boolean).toBeDefined();
    expect((h.comp['drawerLoading'] as () => boolean)()).toBe(false);
  });

  it('drops a stale response when a second row is opened first (race guard)', async () => {
    const h = createFixture();
    let resolveA!: (rows: MessageRow[]) => void;
    let resolveB!: (rows: MessageRow[]) => void;
    h.sessionSpy
      .mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
      .mockImplementationOnce(() => new Promise((r) => (resolveB = r)));

    const pA = (h.comp['open'] as (r: RunRow) => Promise<void>)(makeRun({ session: 'ses_a' }));
    const pB = (h.comp['open'] as (r: RunRow) => Promise<void>)(makeRun({ session: 'ses_b', tick: 43 }));

    resolveB(textRow('from B'));
    await pB;
    resolveA(textRow('from A'));
    await pA;
    h.fixture.detectChanges();

    const root = h.fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('from B');
    expect(root.textContent).not.toContain('from A');
    expect(root.querySelector('.drawer__eyebrow')?.textContent).toContain('43');
  });

  it('shows the no-session state without hitting the API', async () => {
    const h = createFixture();
    await open(h, makeRun({ session: null }));
    expect(h.sessionSpy).not.toHaveBeenCalled();
    expect(drawer(h)?.textContent).toContain('this run has no recorded session');
  });

  it('surfaces API failures in the drawer', async () => {
    const h = createFixture();
    h.sessionSpy.mockRejectedValueOnce(new Error('ses exploded'));
    await open(h, makeRun({ session: 'ses_bad' }));
    expect(drawer(h)?.textContent).toContain('ses exploded');
    expect(drawer(h)?.querySelector('db-transcript')).toBeNull();
  });

  it('close() clears the drawer and any pending fetch state', async () => {
    const h = createFixture();
    h.sessionSpy.mockResolvedValueOnce(textRow('hello'));
    await open(h, makeRun());
    expect(drawer(h)).toBeTruthy();

    (h.comp['close'] as () => void)();
    h.fixture.detectChanges();
    expect(drawer(h)).toBeNull();
    expect((h.comp['drawerEntries'] as () => unknown[])()).toEqual([]);
    expect((h.comp['drawerLoading'] as () => boolean)()).toBe(false);
  });

  it('Escape closes the drawer via the host listener', async () => {
    const h = createFixture();
    h.sessionSpy.mockResolvedValueOnce(textRow('hello'));
    await open(h, makeRun());
    expect(drawer(h)).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    h.fixture.detectChanges();
    expect(drawer(h)).toBeNull();
  });

  it('shows the empty-session hint when the session has no messages', async () => {
    const h = createFixture();
    h.sessionSpy.mockResolvedValueOnce([]);
    await open(h, makeRun({ session: 'ses_empty' }));
    expect(drawer(h)?.textContent).toContain('no messages in this session');
  });

  it('loads the run detail individually on open and renders the session breakdown', async () => {
    const h = createFixture();
    h.sessionSpy.mockResolvedValueOnce(textRow('hi'));
    h.detailSpy.mockResolvedValueOnce({
      run: makeRun({ model: 'detailed-model', cost: 0.42 }),
      session: {
        id: 'ses_a',
        title: 'fix the vault',
        model: 'detailed-model',
        cost: 0.42,
        tokens_in: 10,
        tokens_out: 20,
        tokens_reasoning: 5,
        cache_read: 100,
        cache_write: 200,
        started_ms: 1,
        finished_ms: 2,
      },
    });

    await open(h, makeRun());

    expect(h.detailSpy).toHaveBeenCalledWith({
      session: 'ses_a',
      tick: 42,
      mission: 'missions/update-security.md',
    });
    const root = drawer(h);
    expect(root?.textContent).toContain('fix the vault');
    expect(root?.textContent).toContain('detailed-model');
    expect(root?.textContent).toContain('session breakdown');
    expect((h.comp['detailLoading'] as () => boolean)()).toBe(false);
  });

  it('falls back to the list row when the individual detail fetch fails', async () => {
    const h = createFixture();
    h.sessionSpy.mockResolvedValueOnce([]);
    h.detailSpy.mockRejectedValueOnce(new Error('detail boom'));

    await open(h, makeRun());

    const root = drawer(h);
    expect(root?.textContent).toContain('detail boom');
    expect(root?.textContent).toContain('update security');
    expect((h.comp['detailLoading'] as () => boolean)()).toBe(false);
  });

  it('skips the detail fetch for rows with neither session nor tick', async () => {
    const h = createFixture();
    await open(h, makeRun({ session: null, tick: null }));
    expect(h.detailSpy).not.toHaveBeenCalled();
    expect(drawer(h)?.textContent).toContain('this run has no recorded session');
  });

  it('the reload button re-fetches detail and transcript', async () => {
    const h = createFixture();
    h.sessionSpy.mockResolvedValue(textRow('hello'));
    h.detailSpy.mockResolvedValue({ run: makeRun(), session: null });

    await open(h, makeRun());
    expect(h.detailSpy).toHaveBeenCalledTimes(1);
    expect(h.sessionSpy).toHaveBeenCalledTimes(1);

    const reloadButton = drawer(h)?.querySelector('.drawer__actions .ibtn[title="Reload detail and transcript"]');
    expect(reloadButton).toBeTruthy();
    (reloadButton as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.fixture.detectChanges();

    expect(h.detailSpy).toHaveBeenCalledTimes(2);
    expect(h.sessionSpy).toHaveBeenCalledTimes(2);
  });

  it('renders the per-item detail as it arrives', async () => {
    const h = createFixture();
    let resolveDetail!: (value: { run: RunRow | null; session: null }) => void;
    h.detailSpy.mockImplementationOnce(() => new Promise((r) => (resolveDetail = r)));
    h.sessionSpy.mockResolvedValueOnce([]);

    const pending = (h.comp['open'] as (r: RunRow) => Promise<void>)(makeRun());
    h.fixture.detectChanges();
    expect(drawer(h)?.textContent).toContain('loading detail…');

    resolveDetail({ run: makeRun({ model: 'late-model' }), session: null });
    await pending;
    h.fixture.detectChanges();

    expect(drawer(h)?.textContent).toContain('late-model');
    expect((h.comp['detailLoading'] as () => boolean)()).toBe(false);
  });
});
