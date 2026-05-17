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
    // Built-ins today: browser/playwright. Extracted to plugins (only show
    // up when loaded via config):
    //   - orm/prisma          → @levelzero/plugin-prisma
    //   - auth/better-auth    → @levelzero/plugin-better-auth
    //   - ui/shadcn           → @levelzero/plugin-shadcn
    //   - backend/hono        → @levelzero/plugin-hono
    //   - frontend/typed-client → @levelzero/plugin-typed-client
    //   - portless            → @levelzero/plugin-portless
    const byKey = new Map(result.adapters.map((a) => [`${a.slot}:${a.name}`, a]));
    expect(byKey.get('browser:playwright')?.active).toBe(true);
    expect(byKey.has('orm:prisma')).toBe(false);
    expect(byKey.has('auth:better-auth')).toBe(false);
    expect(byKey.has('ui:shadcn')).toBe(false);
    expect(byKey.has('backend:hono')).toBe(false);
    expect(byKey.has('frontend:typed-client')).toBe(false);
    expect(result.adapters).toHaveLength(1);
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
