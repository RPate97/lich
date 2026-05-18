import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLIError } from '../../errors';
import { resolveStackContext } from '../../services/context';
import { AdapterRegistry, getBuiltinAdapters } from '../../adapters/registry';
import type { AdapterSlot } from '../../adapters/registry';
import type { Command } from '../types';

export interface AdapterSwapOptions {
  /**
   * Registry provider; defaults to a fresh `getBuiltinAdapters()` call. The
   * registry is used only to validate that (slot, name) is a known pair —
   * actually mutating the running registry isn't this command's job; persisting
   * the choice to disk is, so subsequent CLI runs can pick it up.
   */
  getRegistry?: () => AdapterRegistry;
}

const ADAPTER_FILE_SUBPATH = join('.levelzero', 'adapter.json');

/**
 * Build `levelzero adapter swap <slot> <name>`. Persists the chosen impl for
 * a slot into `.levelzero/adapter.json` next to `levelzero.config.ts`.
 *
 * Storage format is a flat `{ [slot]: name }` object — one entry per slot,
 * with later swaps overwriting prior choices for the same slot but preserving
 * entries for other slots. The file is created on first swap.
 */
export function makeAdapterSwapCommand(opts?: AdapterSwapOptions): Command {
  const getRegistry = opts?.getRegistry ?? getBuiltinAdapters;

  return {
    name: 'adapter.swap',
    describe: "Set the active adapter for a slot and persist it to .levelzero/adapter.json",
    async run(ctx) {
      const [slot, name, ...rest] = ctx.args;
      if (!slot) {
        throw new CLIError(
          'INTERNAL',
          'missing required argument: slot',
          'usage: levelzero adapter swap <slot> <name>',
        );
      }
      if (!name) {
        throw new CLIError(
          'INTERNAL',
          'missing required argument: adapter name',
          'usage: levelzero adapter swap <slot> <name>',
        );
      }
      if (rest.length > 0) {
        throw new CLIError(
          'INTERNAL',
          `unexpected extra arguments: ${rest.join(' ')}`,
          'usage: levelzero adapter swap <slot> <name>',
        );
      }

      const registry = getRegistry();
      // Validate slot first so the error message points at the real problem
      // when both slot and name are bogus.
      const slotEntries = registry.listBySlot(slot as AdapterSlot);
      if (slotEntries.length === 0) {
        throw new CLIError(
          'INTERNAL',
          `unknown adapter slot "${slot}"`,
          'run `levelzero adapter list` to see available slots and impls',
        );
      }
      if (!slotEntries.some((e) => e.name === name)) {
        throw new CLIError(
          'INTERNAL',
          `no adapter "${name}" registered for slot "${slot}"`,
          {
            hint: 'run `levelzero adapter list` to see registered impls',
            details: {
              slot,
              requested: name,
              available: slotEntries.map((e) => e.name),
            },
          },
        );
      }

      // resolveStackContext throws NO_PROJECT outside a project — exactly the
      // error we want. We do this AFTER arg/slot validation so cheap mistakes
      // surface even outside a project (good DX for `--help`-like flows).
      const stackCtx = await resolveStackContext(ctx.cwd);
      const adapterPath = join(stackCtx.worktreePath, ADAPTER_FILE_SUBPATH);

      const existing = await readExisting(adapterPath);
      const next = { ...existing, [slot]: name };

      await mkdir(dirname(adapterPath), { recursive: true });
      await writeFile(adapterPath, JSON.stringify(next, null, 2) + '\n', 'utf8');

      const result = { ok: true as const, slot, name, path: adapterPath };
      if (ctx.format === 'json') return result;
      return `swapped ${slot} -> ${name}\nwrote ${adapterPath}\n`;
    },
  };
}

async function readExisting(path: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Coerce string values only — defensive against hand-edited files.
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    return {};
  } catch (err) {
    // Missing file is the common case on first swap.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new CLIError(
      'CONFIG_INVALID',
      `failed to read existing ${ADAPTER_FILE_SUBPATH}`,
      {
        hint: 'fix or delete the file and re-run `levelzero adapter swap`',
        details: { path, error: (err as Error).message },
      },
    );
  }
}

export const adapterSwapCommand: Command = makeAdapterSwapCommand();
