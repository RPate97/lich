import { prismaAdapter } from './orm/prisma';
import { betterAuthAdapter } from './auth/better-auth';
import { shadcnAdapter } from './ui/shadcn';
import { playwrightAdapter } from './browser/playwright';

/**
 * Adapter slot identifiers. Each slot represents one pluggable boundary in
 * the Levelzero stack — exactly one impl per slot is "active" at a time, but
 * the registry can carry several alternative impls (e.g. prisma and drizzle
 * both registered under "orm", with prisma active).
 *
 * Adding a slot here is a breaking change for downstream consumers — keep the
 * list curated. The four trailing slots (backend, frontend, test-runner,
 * portless) are reserved for impls landing in subsequent waves of Plan 13.
 */
export type AdapterSlot =
  | 'orm'
  | 'auth'
  | 'ui'
  | 'browser'
  | 'backend'
  | 'frontend'
  | 'test-runner'
  | 'portless';

/**
 * One adapter entry in the registry. `impl` is intentionally `unknown` so the
 * registry stays decoupled from each slot's specific interface — callers cast
 * to the slot's expected type at the call site (where they know which slot
 * they're pulling from).
 */
export interface AdapterEntry {
  slot: AdapterSlot;
  name: string;
  impl: unknown;
}

/**
 * In-memory registry of adapter impls per slot.
 *
 * Single source of truth: the CLI (codegen, runners, etc.) reads from one
 * `AdapterRegistry` instance built by `getBuiltinAdapters()` (or a custom
 * one in tests). `register()` is idempotent on (slot, name) — re-registering
 * the same pair replaces the impl, so consumers can override built-ins by
 * registering after `getBuiltinAdapters()`.
 *
 * Active state is tracked per slot, separate from registration order. There
 * is no implicit default: `getActive(slot)` throws until someone explicitly
 * calls `setActive(slot, name)`. `getBuiltinAdapters()` does that wiring for
 * the impls it registers; brand-new slots remain inactive until populated.
 */
export class AdapterRegistry {
  private readonly entries = new Map<AdapterSlot, Map<string, AdapterEntry>>();
  private readonly active = new Map<AdapterSlot, string>();

  register(entry: AdapterEntry): void {
    let bucket = this.entries.get(entry.slot);
    if (!bucket) {
      bucket = new Map();
      this.entries.set(entry.slot, bucket);
    }
    bucket.set(entry.name, entry);
  }

  list(): AdapterEntry[] {
    const all: AdapterEntry[] = [];
    for (const bucket of this.entries.values()) {
      for (const e of bucket.values()) all.push(e);
    }
    return all;
  }

  listBySlot(slot: AdapterSlot): AdapterEntry[] {
    const bucket = this.entries.get(slot);
    if (!bucket) return [];
    return Array.from(bucket.values());
  }

  get(slot: AdapterSlot, name: string): unknown {
    const bucket = this.entries.get(slot);
    const entry = bucket?.get(name);
    if (!entry) {
      throw new Error(`no adapter "${name}" registered for slot "${slot}"`);
    }
    return entry.impl;
  }

  getActive(slot: AdapterSlot): unknown {
    const name = this.active.get(slot);
    if (!name) {
      throw new Error(`no active impl for slot "${slot}"`);
    }
    // The (slot, name) pair must still resolve — defensive in case someone
    // unregisters by replacing then deleting (we don't expose delete, but the
    // bucket lookup also covers the "active set then bucket emptied" edge).
    return this.get(slot, name);
  }

  setActive(slot: AdapterSlot, name: string): void {
    const bucket = this.entries.get(slot);
    if (!bucket || !bucket.has(name)) {
      throw new Error(`cannot set active: no adapter "${name}" registered for slot "${slot}"`);
    }
    this.active.set(slot, name);
  }
}

/**
 * Build the default registry: every adapter impl that exists today, with the
 * sole impl per slot marked active. Slots without a concrete impl yet
 * (backend, frontend, test-runner, portless) are simply absent from the
 * registry — `getActive(slot)` throws "no active impl for slot X" until they
 * land in later waves.
 *
 * Returns a fresh instance each call so tests and CLI invocations don't share
 * mutable state.
 */
export function getBuiltinAdapters(): AdapterRegistry {
  const registry = new AdapterRegistry();

  registry.register({ slot: 'orm', name: 'prisma', impl: prismaAdapter });
  registry.setActive('orm', 'prisma');

  registry.register({ slot: 'auth', name: 'better-auth', impl: betterAuthAdapter });
  registry.setActive('auth', 'better-auth');

  registry.register({ slot: 'ui', name: 'shadcn', impl: shadcnAdapter });
  registry.setActive('ui', 'shadcn');

  registry.register({ slot: 'browser', name: 'playwright', impl: playwrightAdapter });
  registry.setActive('browser', 'playwright');

  return registry;
}
