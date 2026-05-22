// packages/dashboard/tests/format.test.ts
import { describe, it, expect } from 'vitest';
import { fmtRelative, fmtClock, summarizeHealth, serviceColor } from '../src/web/lib/format';
import type { ServiceView } from '../src/types';

describe('fmtRelative', () => {
  it('formats seconds, minutes, hours, days', () => {
    expect(fmtRelative(5_000)).toBe('5s');
    expect(fmtRelative(120_000)).toBe('2m');
    expect(fmtRelative(3_600_000)).toBe('1h 0m');
    expect(fmtRelative(90_000_000)).toBe('1d 1h');
  });
});

describe('fmtClock', () => {
  it('formats an epoch ms as HH:MM:SS', () => {
    const ts = new Date('2026-05-22T09:08:07').getTime();
    expect(fmtClock(ts)).toBe('09:08:07');
  });
});

describe('summarizeHealth', () => {
  it('counts up / down / total', () => {
    const services: ServiceView[] = [
      { name: 'api', kind: 'owned', status: 'up' },
      { name: 'web', kind: 'owned', status: 'up' },
      { name: 'db', kind: 'compose', status: 'down' },
    ];
    expect(summarizeHealth(services)).toEqual({ up: 2, down: 1, total: 3 });
  });

  it('handles an empty service list', () => {
    expect(summarizeHealth([])).toEqual({ up: 0, down: 0, total: 0 });
  });
});

describe('serviceColor', () => {
  it('is stable for the same name', () => {
    expect(serviceColor('api')).toBe(serviceColor('api'));
  });
  it('returns a hex color', () => {
    expect(serviceColor('whatever')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
