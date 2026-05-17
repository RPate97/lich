import { AdapterRegistry, getBuiltinAdapters } from '../../adapters/registry';
import type { AdapterSlot } from '../../adapters/registry';
import type { Command } from '../types';

export interface AdapterListOptions {
  /**
   * Registry provider; defaults to a fresh `getBuiltinAdapters()` call. Tests
   * inject a custom registry to exercise non-default slots/impls.
   */
  getRegistry?: () => AdapterRegistry;
}

export interface AdapterListEntry {
  slot: AdapterSlot;
  name: string;
  active: boolean;
}

/**
 * Build `levelzero adapter list`. Returns every entry in the in-memory adapter
 * registry with a per-slot `active` flag so consumers can see at a glance which
 * impl is currently wired in for each pluggable boundary.
 *
 * For v0 this reads `getBuiltinAdapters()` directly — there is no project file
 * yet that overrides the built-in active selection (that ships with
 * `adapter swap`'s sibling consumer in a later wave), so the command never
 * needs to resolve a stack context.
 */
export function makeAdapterListCommand(opts?: AdapterListOptions): Command {
  const getRegistry = opts?.getRegistry ?? getBuiltinAdapters;

  return {
    name: 'adapter.list',
    describe: 'List every registered adapter with its slot and active state',
    async run() {
      const registry = getRegistry();
      const adapters: AdapterListEntry[] = registry.list().map((entry) => ({
        slot: entry.slot,
        name: entry.name,
        active: isActive(registry, entry.slot, entry.name),
      }));
      return { adapters };
    },
  };
}

/**
 * The registry exposes `getActive(slot)` which throws for slots with no
 * active impl — we want a boolean per entry instead, so we probe the impl and
 * cross-check identity against `get(slot, name)`. Identity is the right
 * comparison: `register()` stores the same object the registry hands back.
 */
function isActive(registry: AdapterRegistry, slot: AdapterSlot, name: string): boolean {
  let activeImpl: unknown;
  try {
    activeImpl = registry.getActive(slot);
  } catch {
    return false;
  }
  return activeImpl === registry.get(slot, name);
}

export const adapterListCommand: Command = makeAdapterListCommand();
