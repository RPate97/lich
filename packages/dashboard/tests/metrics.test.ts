// packages/dashboard/tests/metrics.test.ts
import { describe, it, expect } from 'vitest';
import { parseDockerMemMB } from '../src/server/metrics';

describe('parseDockerMemMB', () => {
  it('parses MiB values', () => {
    expect(parseDockerMemMB('123.4MiB')).toBeCloseTo(123.4, 5);
    expect(parseDockerMemMB('256MiB')).toBeCloseTo(256, 5);
  });

  it('parses MB values', () => {
    expect(parseDockerMemMB('100MB')).toBeCloseTo(100, 5);
    expect(parseDockerMemMB('512.5MB')).toBeCloseTo(512.5, 5);
  });

  it('parses GiB values (converts to MB)', () => {
    expect(parseDockerMemMB('1GiB')).toBeCloseTo(1024, 3);
    expect(parseDockerMemMB('2.5GiB')).toBeCloseTo(2560, 3);
  });

  it('parses GB values (converts to MB)', () => {
    expect(parseDockerMemMB('1GB')).toBeCloseTo(1024, 3);
    expect(parseDockerMemMB('4GB')).toBeCloseTo(4096, 3);
  });

  it('parses KiB values (converts to MB)', () => {
    expect(parseDockerMemMB('1024KiB')).toBeCloseTo(1, 5);
    expect(parseDockerMemMB('2048KiB')).toBeCloseTo(2, 5);
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseDockerMemMB('  64MiB  ')).toBeCloseTo(64, 5);
  });

  it('returns undefined for unparseable strings', () => {
    expect(parseDockerMemMB('')).toBeUndefined();
    expect(parseDockerMemMB('N/A')).toBeUndefined();
    expect(parseDockerMemMB('--')).toBeUndefined();
    expect(parseDockerMemMB('123')).toBeUndefined();
  });

  // Case-insensitive
  it('is case-insensitive for the unit suffix', () => {
    expect(parseDockerMemMB('64mib')).toBeCloseTo(64, 5);
    expect(parseDockerMemMB('64MB')).toBeCloseTo(64, 5);
    expect(parseDockerMemMB('1gib')).toBeCloseTo(1024, 3);
  });
});
