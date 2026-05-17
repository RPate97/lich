import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry, getBuiltinAdapters } from '../../../src/adapters/registry';
import {
  makeAdapterListCommand,
  adapterListCommand,
} from '../../../src/commands/adapter/list';

interface ListEntry {
  slot: string;
  name: string;
  active: boolean;
}

function ctx(cwd: string) {
  return { cwd, format: 'json' as const, args: [], flags: {} };
}

describe('levelzero adapter list', () => {
  it('exports a command named "adapter.list"', () => {
    expect(adapterListCommand.name).toBe('adapter.list');
    expect(typeof adapterListCommand.describe).toBe('string');
  });

  it('returns every built-in adapter with its slot, name and active flag', async () => {
    const cmd = makeAdapterListCommand({ getRegistry: () => getBuiltinAdapters() });
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-adapter-list-')));
    const result = (await cmd.run(ctx(tmp))) as { adapters: ListEntry[] };

    expect(Array.isArray(result.adapters)).toBe(true);
    // Built-ins today: orm/prisma, auth/better-auth, ui/shadcn,
    // browser/playwright, backend/hono, frontend/typed-client.
    const byKey = new Map(result.adapters.map((a) => [`${a.slot}:${a.name}`, a]));
    expect(byKey.get('orm:prisma')?.active).toBe(true);
    expect(byKey.get('auth:better-auth')?.active).toBe(true);
    expect(byKey.get('ui:shadcn')?.active).toBe(true);
    expect(byKey.get('browser:playwright')?.active).toBe(true);
    expect(byKey.get('backend:hono')?.active).toBe(true);
    expect(byKey.get('frontend:typed-client')?.active).toBe(true);
    expect(result.adapters).toHaveLength(6);
  });

  it('marks an adapter inactive when its slot has a different active impl', async () => {
    const registry = new AdapterRegistry();
    registry.register({ slot: 'orm', name: 'prisma', impl: {} });
    registry.register({ slot: 'orm', name: 'drizzle', impl: {} });
    registry.setActive('orm', 'drizzle');

    const cmd = makeAdapterListCommand({ getRegistry: () => registry });
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-adapter-list-')));
    const result = (await cmd.run(ctx(tmp))) as { adapters: ListEntry[] };

    const prisma = result.adapters.find((a) => a.name === 'prisma');
    const drizzle = result.adapters.find((a) => a.name === 'drizzle');
    expect(prisma?.active).toBe(false);
    expect(drizzle?.active).toBe(true);
  });

  it('marks every entry inactive for a slot with no active impl', async () => {
    const registry = new AdapterRegistry();
    registry.register({ slot: 'orm', name: 'prisma', impl: {} });
    // intentionally do NOT call setActive

    const cmd = makeAdapterListCommand({ getRegistry: () => registry });
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-adapter-list-')));
    const result = (await cmd.run(ctx(tmp))) as { adapters: ListEntry[] };

    expect(result.adapters).toEqual([{ slot: 'orm', name: 'prisma', active: false }]);
  });

  it('returns an empty array when the registry has no entries', async () => {
    const cmd = makeAdapterListCommand({ getRegistry: () => new AdapterRegistry() });
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-adapter-list-')));
    const result = (await cmd.run(ctx(tmp))) as { adapters: ListEntry[] };
    expect(result.adapters).toEqual([]);
  });
});
