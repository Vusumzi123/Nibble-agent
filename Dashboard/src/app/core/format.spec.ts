import { describe, expect, it } from 'vitest';

import { fmtBytes, fmtCost, fmtDuration, fmtTokens, pct, relative } from './format';

describe('fmtDuration', () => {
  it('formats hours, minutes and seconds', () => {
    expect(fmtDuration(3_723_000)).toBe('1h 2m');
    expect(fmtDuration(95_000)).toBe('1m 35s');
    expect(fmtDuration(45_000)).toBe('45s');
  });

  it('returns an em dash for null/undefined/NaN', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
    expect(fmtDuration(Number.NaN)).toBe('—');
  });

  it('clamps negative values to zero', () => {
    expect(fmtDuration(-5000)).toBe('0s');
  });
});

describe('fmtTokens', () => {
  it('scales to k and M', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(2_500_000)).toBe('2.5M');
    expect(fmtTokens(null)).toBe('—');
  });
});

describe('fmtBytes', () => {
  it('scales units', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 kB');
    expect(fmtBytes(3_145_728)).toBe('3.0 MB');
    expect(fmtBytes(null)).toBe('—');
  });
});

describe('fmtCost', () => {
  it('formats dollars and falls back to n/a', () => {
    expect(fmtCost(1.5)).toBe('$1.50');
    expect(fmtCost(null)).toBe('n/a');
  });
});

describe('pct', () => {
  it('computes percentages and guards a zero total', () => {
    expect(pct(1, 4)).toBe('25.0%');
    expect(pct(0, 0)).toBe('—');
  });
});

describe('relative', () => {
  it('reports "now" below the threshold and durations above', () => {
    const now = 1_000_000;
    expect(relative(now - 500, now)).toBe('now');
    expect(relative(now - 65_000, now)).toBe('1m 05s ago');
    expect(relative(null, now)).toBe('—');
    expect(relative(now + 5000, now)).toBe('now');
  });
});
