import { CLIError } from '../../errors';
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
 * Build `lich adapter list`. Returns every entry in the in-memory adapter
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
    async run(ctx) {
      const registry = getRegistry();

      // LEV-207: optional `<slot>` positional filters the result to one slot.
      // Validate against the registry's static `knownSlots()` list so a typo
      // (`orn` vs `orm`) errors loudly instead of returning an empty array —
      // an empty array is indistinguishable from "this slot has no impls
      // loaded yet" and would silently hide the user's mistake.
      const [slotArg, ...rest] = ctx.args;
      if (rest.length > 0) {
        throw new CLIError(
          'INTERNAL',
          `unexpected extra arguments: ${rest.join(' ')}`,
          'usage: lich adapter list [<slot>]',
        );
      }
      if (slotArg !== undefined) {
        const validSlots = registry.knownSlots();
        if (!(validSlots as readonly string[]).includes(slotArg)) {
          throw new CLIError(
            'INTERNAL',
            `unknown slot: ${slotArg}. known slots: ${validSlots.join(', ')}`,
            'usage: lich adapter list [<slot>]',
          );
        }
      }

      const adapters: AdapterListEntry[] = registry
        .list()
        .filter((entry) => slotArg === undefined || entry.slot === slotArg)
        .map((entry) => ({
          slot: entry.slot,
          name: entry.name,
          active: isActive(registry, entry.slot, entry.name),
        }));
      if (ctx.format === 'json') return { adapters };
      return renderAdapterListPretty(adapters);
    },
  };
}

/**
 * Render the adapter list as a fixed-width 3-column table — `SLOT NAME ACTIVE`
 * — sorted by slot then name so columns line up and successive invocations
 * produce deterministic output. The active flag renders as `yes` / `no` for
 * readability rather than a raw boolean.
 */
export function renderAdapterListPretty(adapters: AdapterListEntry[]): string {
  if (adapters.length === 0) return 'no adapters registered\n';
  const rows = [...adapters].sort((a, b) => {
    const slotCmp = a.slot.localeCompare(b.slot);
    if (slotCmp !== 0) return slotCmp;
    return a.name.localeCompare(b.name);
  });
  const headers = { slot: 'SLOT', name: 'NAME', active: 'ACTIVE' };
  const widthSlot = Math.max(headers.slot.length, ...rows.map((r) => r.slot.length));
  const widthName = Math.max(headers.name.length, ...rows.map((r) => r.name.length));
  const lines: string[] = [];
  lines.push(
    `${headers.slot.padEnd(widthSlot)}  ${headers.name.padEnd(widthName)}  ${headers.active}`,
  );
  for (const r of rows) {
    const active = r.active ? 'yes' : 'no';
    lines.push(`${r.slot.padEnd(widthSlot)}  ${r.name.padEnd(widthName)}  ${active}`);
  }
  return lines.join('\n') + '\n';
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
