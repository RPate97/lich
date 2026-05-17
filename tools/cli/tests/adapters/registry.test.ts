import { describe, it, expect, beforeEach } from 'vitest';
import {
  AdapterRegistry,
  getBuiltinAdapters,
  type AdapterEntry,
  type AdapterSlot,
} from '../../src/adapters/registry';

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  describe('register / list', () => {
    it('register adds an entry and list returns it', () => {
      const entry: AdapterEntry = { slot: 'orm', name: 'prisma', impl: { name: 'prisma' } };
      registry.register(entry);
      const all = registry.list();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(entry);
    });

    it('list returns all registered entries across slots', () => {
      registry.register({ slot: 'orm', name: 'prisma', impl: {} });
      registry.register({ slot: 'auth', name: 'better-auth', impl: {} });
      registry.register({ slot: 'ui', name: 'shadcn', impl: {} });
      expect(registry.list()).toHaveLength(3);
    });

    it('list returns empty array initially', () => {
      expect(registry.list()).toEqual([]);
    });

    it('register replaces an existing (slot, name) pair rather than duplicating', () => {
      const first = { name: 'prisma', version: 1 };
      const second = { name: 'prisma', version: 2 };
      registry.register({ slot: 'orm', name: 'prisma', impl: first });
      registry.register({ slot: 'orm', name: 'prisma', impl: second });
      const entries = registry.listBySlot('orm');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.impl).toBe(second);
    });
  });

  describe('listBySlot', () => {
    it('returns only entries for the given slot', () => {
      registry.register({ slot: 'orm', name: 'prisma', impl: {} });
      registry.register({ slot: 'orm', name: 'drizzle', impl: {} });
      registry.register({ slot: 'auth', name: 'better-auth', impl: {} });
      const ormEntries = registry.listBySlot('orm');
      expect(ormEntries).toHaveLength(2);
      expect(ormEntries.map((e) => e.name).sort()).toEqual(['drizzle', 'prisma']);
    });

    it('returns empty array for a slot with nothing registered', () => {
      expect(registry.listBySlot('backend')).toEqual([]);
    });
  });

  describe('get', () => {
    it('returns the impl for a registered (slot, name)', () => {
      const impl = { name: 'prisma', kind: 'orm' };
      registry.register({ slot: 'orm', name: 'prisma', impl });
      expect(registry.get('orm', 'prisma')).toBe(impl);
    });

    it('throws when the name is not registered for the slot', () => {
      registry.register({ slot: 'orm', name: 'prisma', impl: {} });
      expect(() => registry.get('orm', 'drizzle')).toThrowError(
        /no adapter "drizzle" registered for slot "orm"/,
      );
    });

    it('throws when no impls are registered for the slot', () => {
      expect(() => registry.get('backend', 'hono')).toThrowError(
        /no adapter "hono" registered for slot "backend"/,
      );
    });
  });

  describe('getActive / setActive', () => {
    it('throws if no active impl is set for the slot', () => {
      expect(() => registry.getActive('orm')).toThrowError(/no active impl for slot "orm"/);
    });

    it('throws even when an impl is registered but none is marked active', () => {
      registry.register({ slot: 'orm', name: 'prisma', impl: {} });
      expect(() => registry.getActive('orm')).toThrowError(/no active impl for slot "orm"/);
    });

    it('setActive marks an impl active and getActive returns it', () => {
      const impl = { name: 'prisma' };
      registry.register({ slot: 'orm', name: 'prisma', impl });
      registry.setActive('orm', 'prisma');
      expect(registry.getActive('orm')).toBe(impl);
    });

    it('setActive can switch the active impl', () => {
      const prisma = { name: 'prisma' };
      const drizzle = { name: 'drizzle' };
      registry.register({ slot: 'orm', name: 'prisma', impl: prisma });
      registry.register({ slot: 'orm', name: 'drizzle', impl: drizzle });
      registry.setActive('orm', 'prisma');
      expect(registry.getActive('orm')).toBe(prisma);
      registry.setActive('orm', 'drizzle');
      expect(registry.getActive('orm')).toBe(drizzle);
    });

    it('setActive throws when the name is not registered for the slot', () => {
      expect(() => registry.setActive('orm', 'drizzle')).toThrowError(
        /cannot set active: no adapter "drizzle" registered for slot "orm"/,
      );
    });

    it('active state is independent per slot', () => {
      const prisma = { name: 'prisma' };
      const betterAuth = { name: 'better-auth' };
      registry.register({ slot: 'orm', name: 'prisma', impl: prisma });
      registry.register({ slot: 'auth', name: 'better-auth', impl: betterAuth });
      registry.setActive('orm', 'prisma');
      registry.setActive('auth', 'better-auth');
      expect(registry.getActive('orm')).toBe(prisma);
      expect(registry.getActive('auth')).toBe(betterAuth);
    });
  });

  describe('AdapterSlot type', () => {
    it('accepts all 8 declared slots', () => {
      const slots: AdapterSlot[] = [
        'orm',
        'auth',
        'ui',
        'browser',
        'backend',
        'frontend',
        'test-runner',
        'portless',
      ];
      for (const slot of slots) {
        registry.register({ slot, name: 'noop', impl: {} });
      }
      expect(registry.list()).toHaveLength(8);
    });
  });
});

describe('getBuiltinAdapters', () => {
  it('returns an AdapterRegistry instance', () => {
    const r = getBuiltinAdapters();
    expect(r).toBeInstanceOf(AdapterRegistry);
  });

  it('registers prisma under the orm slot and marks it active', async () => {
    const r = getBuiltinAdapters();
    const { prismaAdapter } = await import('../../src/adapters/orm/prisma');
    expect(r.get('orm', 'prisma')).toBe(prismaAdapter);
    expect(r.getActive('orm')).toBe(prismaAdapter);
  });

  it('registers better-auth under the auth slot and marks it active', async () => {
    const r = getBuiltinAdapters();
    const { betterAuthAdapter } = await import('../../src/adapters/auth/better-auth');
    expect(r.get('auth', 'better-auth')).toBe(betterAuthAdapter);
    expect(r.getActive('auth')).toBe(betterAuthAdapter);
  });

  it('registers shadcn under the ui slot and marks it active', async () => {
    const r = getBuiltinAdapters();
    const { shadcnAdapter } = await import('../../src/adapters/ui/shadcn');
    expect(r.get('ui', 'shadcn')).toBe(shadcnAdapter);
    expect(r.getActive('ui')).toBe(shadcnAdapter);
  });

  it('registers playwright under the browser slot and marks it active', async () => {
    const r = getBuiltinAdapters();
    const { playwrightAdapter } = await import('../../src/adapters/browser/playwright');
    expect(r.get('browser', 'playwright')).toBe(playwrightAdapter);
    expect(r.getActive('browser')).toBe(playwrightAdapter);
  });

  it('registers hono under the backend slot and marks it active', async () => {
    const r = getBuiltinAdapters();
    const { honoBackendAdapter } = await import('../../src/adapters/backend/hono');
    expect(r.get('backend', 'hono')).toBe(honoBackendAdapter);
    expect(r.getActive('backend')).toBe(honoBackendAdapter);
  });

  it('registers typed-client under the frontend slot and marks it active', async () => {
    const r = getBuiltinAdapters();
    const { typedClientFrontendAdapter } = await import('../../src/adapters/frontend/typed-client');
    expect(r.get('frontend', 'typed-client')).toBe(typedClientFrontendAdapter);
    expect(r.getActive('frontend')).toBe(typedClientFrontendAdapter);
  });

  it('list covers the populated slot names', () => {
    const r = getBuiltinAdapters();
    const slots = new Set(r.list().map((e) => e.slot));
    // Slots with concrete impls today: orm, auth, ui, browser, backend, frontend.
    expect(slots.has('orm')).toBe(true);
    expect(slots.has('auth')).toBe(true);
    expect(slots.has('ui')).toBe(true);
    expect(slots.has('browser')).toBe(true);
    expect(slots.has('backend')).toBe(true);
    expect(slots.has('frontend')).toBe(true);
  });

  it('throws no-active for slots without an impl yet (test-runner, portless)', () => {
    const r = getBuiltinAdapters();
    expect(() => r.getActive('test-runner')).toThrowError(/no active impl for slot "test-runner"/);
    expect(() => r.getActive('portless')).toThrowError(/no active impl for slot "portless"/);
  });

  it('listBySlot returns empty for the still-empty slots', () => {
    const r = getBuiltinAdapters();
    expect(r.listBySlot('test-runner')).toEqual([]);
    expect(r.listBySlot('portless')).toEqual([]);
  });

  it('returns a fresh registry each call (mutating one does not affect another)', () => {
    const a = getBuiltinAdapters();
    const b = getBuiltinAdapters();
    // Use the still-empty `test-runner` slot so we can prove isolation without
    // colliding with a populated builtin.
    a.register({ slot: 'test-runner', name: 'custom', impl: { test: true } });
    expect(() => b.get('test-runner', 'custom')).toThrow();
  });
});
