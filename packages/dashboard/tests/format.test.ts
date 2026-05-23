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

  it('formats an ISO-8601 string as HH:MM:SS', () => {
    // .jsonl log records carry `ts` as an ISO string — must not go through Number().
    expect(fmtClock('2026-05-22T09:08:07')).toBe('09:08:07');
  });
});

describe('summarizeHealth', () => {
  it('counts up (healthy) and down correctly', () => {
    const services: ServiceView[] = [
      { name: 'api', kind: 'owned', status: 'healthy' },
      { name: 'web', kind: 'owned', status: 'healthy' },
      { name: 'db', kind: 'compose', status: 'down' },
    ];
    expect(summarizeHealth(services)).toEqual({ up: 2, down: 1, total: 3 });
  });

  it('counts starting as up (alive, not yet ready)', () => {
    const services: ServiceView[] = [
      { name: 'api', kind: 'owned', status: 'healthy' },
      { name: 'web', kind: 'owned', status: 'starting' },
      { name: 'db', kind: 'compose', status: 'down' },
    ];
    // starting is alive → counted as up
    expect(summarizeHealth(services)).toEqual({ up: 2, down: 1, total: 3 });
  });

  it('counts unhealthy as up (alive, failing probe)', () => {
    const services: ServiceView[] = [
      { name: 'api', kind: 'owned', status: 'healthy' },
      { name: 'web', kind: 'owned', status: 'unhealthy' },
      { name: 'db', kind: 'compose', status: 'down' },
    ];
    // unhealthy is still alive → counted as up
    expect(summarizeHealth(services)).toEqual({ up: 2, down: 1, total: 3 });
  });

  it('counts all statuses together correctly', () => {
    const services: ServiceView[] = [
      { name: 'a', kind: 'owned', status: 'healthy' },
      { name: 'b', kind: 'owned', status: 'unhealthy' },
      { name: 'c', kind: 'owned', status: 'starting' },
      { name: 'd', kind: 'compose', status: 'down' },
    ];
    expect(summarizeHealth(services)).toEqual({ up: 3, down: 1, total: 4 });
  });

  it('handles an empty service list', () => {
    expect(summarizeHealth([])).toEqual({ up: 0, down: 0, total: 0 });
  });

  it('handles all services down', () => {
    const services: ServiceView[] = [
      { name: 'api', kind: 'owned', status: 'down' },
      { name: 'db', kind: 'compose', status: 'down' },
    ];
    expect(summarizeHealth(services)).toEqual({ up: 0, down: 2, total: 2 });
  });

  it('handles all services healthy', () => {
    const services: ServiceView[] = [
      { name: 'api', kind: 'owned', status: 'healthy' },
      { name: 'db', kind: 'compose', status: 'healthy' },
    ];
    expect(summarizeHealth(services)).toEqual({ up: 2, down: 0, total: 2 });
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
