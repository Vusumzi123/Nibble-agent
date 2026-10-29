import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from './api';
import { DashboardStore, scopeForUrl } from './store';

interface MockApi {
  api: ApiService;
  health: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
  mood: ReturnType<typeof vi.fn>;
  queues: ReturnType<typeof vi.fn>;
  drain: ReturnType<typeof vi.fn>;
  overview: ReturnType<typeof vi.fn>;
  tokens: ReturnType<typeof vi.fn>;
  cost: ReturnType<typeof vi.fn>;
  errors: ReturnType<typeof vi.fn>;
  queueWait: ReturnType<typeof vi.fn>;
  throughput: ReturnType<typeof vi.fn>;
  activity: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  idea: ReturnType<typeof vi.fn>;
  backlog: ReturnType<typeof vi.fn>;
  runs: ReturnType<typeof vi.fn>;
  missions: ReturnType<typeof vi.fn>;
  ledgers: ReturnType<typeof vi.fn>;
  settings: ReturnType<typeof vi.fn>;
  locks: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  saveMission: ReturnType<typeof vi.fn>;
}

const stores: DashboardStore[] = [];

function makeApi(): MockApi {
  const ok = <T>(value: T) => vi.fn(() => Promise.resolve(value));
  const raw = {
    health: ok({ directory: '/repo', serve_url: 'http://127.0.0.1:4097' }),
    heartbeat: ok({ schedule: { level: 3 } }),
    mood: ok({ label: 'elated' }),
    queues: ok({ total: 0, items: [], oldest_ms: 0 }),
    drain: ok({ pending: 0, series: [] }),
    overview: ok({}),
    tokens: ok({ totals: { tokens: 0, over_runs: 0 }, points: [] }),
    cost: ok({ total: 1, avg_per_run: 0.1 }),
    errors: ok({ runs: { rate: 0, errors: 0, total: 10 }, series: [] }),
    queueWait: ok({}),
    throughput: ok({ totals: { p50_ms: 10, p95_ms: 20 }, points: [] }),
    activity: ok({ events: [] }),
    sleep: ok({ quiet: false }),
    idea: ok({ generatedToday: 1, dailyTarget: 3 }),
    backlog: ok({ open: 2, total: 5 }),
    runs: ok({ runs: [] }),
    missions: ok({ file: 'missions.md', missions: [] }),
    ledgers: ok({ ledgers: [] }),
    settings: ok({ sections: [] }),
    locks: ok({ locks: [] }),
    saveSettings: vi.fn(() => Promise.resolve({ settings: { sections: [] }, applied: ['a'] })),
    saveMission: vi.fn(() => Promise.resolve({ ok: true, mission: {}, missions: [] })),
    sessionMessages: ok([]),
    ledger: ok({ name: 'x', entries: [] }),
    csrf: ok({ token: 't' }),
  };
  return { ...(raw as unknown as MockApi), api: raw as unknown as ApiService };
}

function makeStore(api: MockApi): DashboardStore {
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api.api }] });
  const store = TestBed.inject(DashboardStore);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores) store.stop();
  stores.length = 0;
  vi.restoreAllMocks();
});

describe('scopeForUrl', () => {
  it('maps urls to scopes with a flight fallback', () => {
    expect(scopeForUrl('')).toBe('flight');
    expect(scopeForUrl('/')).toBe('flight');
    expect(scopeForUrl('/queues?x=1')).toBe('queues');
    expect(scopeForUrl('/logs/heartbeat.log')).toBe('logs');
    expect(scopeForUrl('/nonsense')).toBe('flight');
  });
});

describe('DashboardStore boot', () => {
  it('loads core + strip groups only, never page scopes', async () => {
    const api = makeApi();
    const store = makeStore(api);

    await store.start();

    expect(store.online()).toBe(true);
    expect(store.loading()).toBe(false);
    expect(store.blockingCount()).toBe(0);
    for (const fn of ['health', 'heartbeat', 'mood', 'queues', 'drain', 'overview', 'tokens', 'cost', 'errors', 'queueWait', 'throughput'] as const) {
      expect(api[fn]).toHaveBeenCalled();
    }
    for (const fn of ['settings', 'missions', 'ledgers', 'backlog', 'locks', 'sleep', 'idea', 'activity', 'runs'] as const) {
      expect(api[fn]).not.toHaveBeenCalled();
    }
  });

  it('surfaces a failed connect without leaving the overlay up', async () => {
    const api = makeApi();
    api.health.mockRejectedValueOnce(new Error('down'));
    const store = makeStore(api);

    await store.start();

    expect(store.online()).toBe(false);
    expect(store.loading()).toBe(false);
    expect(store.error()).toContain('down');
    expect(store.blockingCount()).toBe(0);
  });
});

describe('DashboardStore scopes', () => {
  it('reloads only the scope data when a page opens, under the overlay', async () => {
    const api = makeApi();
    const store = makeStore(api);
    await store.start();

    const pending = store.setScope('queues');
    expect(store.blockingCount()).toBe(1);
    expect(store.blockingLabel()).toBe('loading · queues…');
    await pending;

    expect(store.blockingCount()).toBe(0);
    expect(api.queues).toHaveBeenCalled();
    expect(api.runs).toHaveBeenCalled();
    expect(api.missions).toHaveBeenCalled();
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.locks).not.toHaveBeenCalled();
    expect(api.activity).not.toHaveBeenCalled();
    expect(api.sleep).not.toHaveBeenCalled();
    expect(api.ledgers).not.toHaveBeenCalled();
  });

  it('does not refetch when the same scope is re-entered', async () => {
    const api = makeApi();
    const store = makeStore(api);
    await store.start();
    await store.setScope('logs');
    const calls = api.ledgers.mock.calls.length;

    await store.setScope('logs');

    expect(api.ledgers.mock.calls.length).toBe(calls);
  });

  it('swaps scope data when navigating between pages', async () => {
    const api = makeApi();
    const store = makeStore(api);
    await store.start();

    await store.setScope('setup');
    expect(api.settings).toHaveBeenCalled();
    expect(api.locks).toHaveBeenCalled();

    await store.setScope('missions');
    expect(api.missions).toHaveBeenCalled();
    expect(api.runs).toHaveBeenCalled();
    expect(store.blockingCount()).toBe(0);
  });

  it('never raises the overlay for silent poll refreshes', async () => {
    const api = makeApi();
    const store = makeStore(api);
    await store.start();
    expect(store.blockingCount()).toBe(0);

    await store.loadCore();
    await store.loadStrip();

    expect(store.blockingCount()).toBe(0);
    expect(store.refreshing()).toBe(false);
  });

  it('reload() blocks across core, strip and the active scope', async () => {
    const api = makeApi();
    const store = makeStore(api);
    await store.start();
    await store.setScope('metrics');
    api.heartbeat.mockClear();
    api.runs.mockClear();
    api.settings.mockClear();

    const pending = store.reload();
    expect(store.blockingCount()).toBe(1);
    expect(store.refreshing()).toBe(true);
    await pending;

    expect(store.blockingCount()).toBe(0);
    expect(store.refreshing()).toBe(false);
    expect(api.heartbeat).toHaveBeenCalled();
    expect(api.overview).toHaveBeenCalled();
    expect(api.runs).toHaveBeenCalled();
    expect(api.throughput).toHaveBeenCalled();
    expect(api.settings).not.toHaveBeenCalled();
  });

  it('ensureMissions() refreshes silently without the overlay', async () => {
    const api = makeApi();
    const store = makeStore(api);

    await store.ensureMissions();

    expect(api.missions).toHaveBeenCalled();
    expect(store.blockingCount()).toBe(0);
  });

  it('saveSettings blocks, persists, then reloads the setup scope', async () => {
    const api = makeApi();
    const store = makeStore(api);

    const pending = store.saveSettings([{ path: 'a.b', value: 1 }]);
    expect(store.blockingCount()).toBe(1);
    expect(store.blockingLabel()).toBe('saving settings…');
    expect(await pending).toBe(1);

    expect(store.blockingCount()).toBe(0);
    expect(api.saveSettings).toHaveBeenCalled();
    expect(api.settings).toHaveBeenCalled();
    expect(api.locks).toHaveBeenCalled();
  });

  it('saveMission blocks, persists, then reloads the missions scope', async () => {
    const api = makeApi();
    const store = makeStore(api);

    const pending = store.saveMission({ id: 'm1', enabled: true });
    expect(store.blockingCount()).toBe(1);
    expect(await pending).toEqual({});

    expect(store.blockingCount()).toBe(0);
    expect(api.saveMission).toHaveBeenCalled();
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.runs).toHaveBeenCalled();
  });
});
