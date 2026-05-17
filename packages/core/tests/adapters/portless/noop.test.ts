import { describe, it, expect, expectTypeOf } from 'vitest';
import { noopPortlessAdapter } from '../../../src/adapters/portless/noop';
import type { PortlessAdapter, URLEntry } from '../../../src/adapters/portless/types';

describe('noopPortlessAdapter', () => {
  it('conforms to the PortlessAdapter interface', () => {
    expectTypeOf(noopPortlessAdapter).toMatchTypeOf<PortlessAdapter>();
  });

  it('exposes a name', () => {
    expect(typeof noopPortlessAdapter.name).toBe('string');
    expect(noopPortlessAdapter.name.length).toBeGreaterThan(0);
  });

  it('available() resolves to false', async () => {
    await expect(noopPortlessAdapter.available()).resolves.toBe(false);
  });

  it('register() is a no-op that resolves to void', async () => {
    const result = await noopPortlessAdapter.register({
      host: 'app.example.test',
      target: 'http://127.0.0.1:3000',
    });
    expect(result).toBeUndefined();
  });

  it('unregister() is a no-op that resolves to void', async () => {
    const result = await noopPortlessAdapter.unregister('app.example.test');
    expect(result).toBeUndefined();
  });

  it('list() resolves to an empty array', async () => {
    const list = await noopPortlessAdapter.list();
    expect(list).toEqual([]);
    expectTypeOf(list).toEqualTypeOf<URLEntry[]>();
  });

  it('register does not affect list()', async () => {
    await noopPortlessAdapter.register({
      host: 'api.example.test',
      target: 'http://127.0.0.1:4000',
    });
    await expect(noopPortlessAdapter.list()).resolves.toEqual([]);
  });

  it('unregister does not throw even when nothing is registered', async () => {
    await expect(noopPortlessAdapter.unregister('nonexistent.test')).resolves.toBeUndefined();
  });
});
