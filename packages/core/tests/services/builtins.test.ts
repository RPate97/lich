import { describe, it, expect } from 'vitest';
import { getBuiltinServices } from '../../src/services/builtins';

describe('getBuiltinServices', () => {
  it('does not include postgres (extracted to @levelzero/plugin-postgres in LEV-148)', () => {
    const list = getBuiltinServices();
    const pg = list.find((s) => s.name === 'postgres');
    expect(pg).toBeUndefined();
  });

  it('does not include web (extracted to @levelzero/plugin-next in LEV-154)', () => {
    const list = getBuiltinServices();
    const web = list.find((s) => s.name === 'web');
    expect(web).toBeUndefined();
  });

  it('does not include api (extracted to @levelzero/plugin-hono in LEV-187)', () => {
    const list = getBuiltinServices();
    const api = list.find((s) => s.name === 'api');
    expect(api).toBeUndefined();
  });

  it('returns an empty list — every previously built-in service is now plugin-contributed', () => {
    const list = getBuiltinServices();
    expect(list).toEqual([]);
  });
});
