import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { RunRow } from '../core/models';
import { RunTable } from './run-table';

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
    token_cost: 1500,
    over_budget: false,
    cost: 0.05,
    model: 'claude-opus',
    tokens_in: 1000,
    tokens_out: 500,
    tokens_total: 1500,
    duration_ms: 95_000,
    started_ms: 1793306400000,
    finished_ms: 1793306495000,
    result_status: 'ok',
    result_missing: false,
    requeued: false,
    session: 'ses_123',
    aborted: false,
    stop_reason: null,
    stalled_for_ms: null,
    error: null,
    ...overrides,
  };
}

function create(runs: RunRow[]) {
  const fixture = TestBed.createComponent(RunTable);
  fixture.componentRef.setInput('runs', runs);
  fixture.detectChanges();
  return fixture;
}

describe('RunTable', () => {
  it('shows an empty row when there are no runs', () => {
    const fixture = create([]);
    const empty = (fixture.nativeElement as HTMLElement).querySelector('td.empty');
    expect(empty?.textContent?.trim()).toBe('no runs recorded');
  });

  it('renders one body row per run with tick and mission', () => {
    const fixture = create([makeRun(), makeRun({ tick: 43, mission: 'missions/x.md' })]);
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.num.mono')?.textContent?.trim()).toBe('42');
    expect(rows[0].textContent).toContain('missions/update-security.md');
  });

  it('emits select with the clicked row', () => {
    const run = makeRun();
    const fixture = create([run]);
    const seen: RunRow[] = [];
    fixture.componentInstance.select.subscribe((r) => seen.push(r));
    (fixture.nativeElement.querySelector('tbody tr') as HTMLElement).click();
    expect(seen).toEqual([run]);
  });

  it('emits select on Enter for keyboard users', () => {
    const run = makeRun();
    const fixture = create([run]);
    const seen: RunRow[] = [];
    fixture.componentInstance.select.subscribe((r) => seen.push(r));
    const row = (fixture.nativeElement as HTMLElement).querySelector('tbody tr')!;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(seen).toEqual([run]);
  });

  it('flags over-budget rows and shows a dash when no flags apply', () => {
    const fixture = create([makeRun({ over_budget: true }), makeRun({ tick: 44 })]);
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr');
    expect(rows[0].querySelector('.tag--danger')?.textContent?.trim()).toBe('over');
    expect(rows[1].textContent).toContain('—');
  });

  it('maps outcomes and kinds to tag tones', () => {
    const fixture = create([]);
    const comp = fixture.componentInstance;
    expect(comp.outcomeTone('completed')).toBe('success');
    expect(comp.outcomeTone('timeout')).toBe('warning');
    expect(comp.outcomeTone('error')).toBe('danger');
    expect(comp.outcomeTone('skipped')).toBe('muted');
    expect(comp.outcomeTone(null)).toBe('ghost');
    expect(comp.kindTone('mission')).toBe('primary');
    expect(comp.kindTone('drain')).toBe('info');
    expect(comp.kindTone('weird')).toBe('ghost');
  });
});
