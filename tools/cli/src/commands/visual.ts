import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { CLIError } from '../errors';
import { AdapterRegistry, getBuiltinAdapters } from '../adapters/registry';
import type { BrowserAdapter, DiffOptions } from '../adapters/browser/types';
import type { Command } from './types';

export interface VisualDiffOptions {
  /**
   * Browser adapter. When omitted, resolved from the AdapterRegistry returned
   * by `getAdapterRegistry` (default `getBuiltinAdapters()`); tests can still
   * pass an explicit stub to bypass the registry entirely.
   */
  adapter?: BrowserAdapter;
  /** AdapterRegistry provider used when `adapter` is omitted. */
  getAdapterRegistry?: () => AdapterRegistry;
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function readPng(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err: unknown) {
    throw new CLIError(
      'CONFIG_INVALID',
      `could not read PNG at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      'pass a path to an existing PNG file',
    );
  }
}

function parseNumberFlag(value: string | boolean | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') {
    throw new CLIError('CONFIG_INVALID', `--${name} requires a value`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new CLIError('CONFIG_INVALID', `--${name} must be a number, got: ${value}`);
  }
  return n;
}

/**
 * Build `levelzero visual diff`. Reads two PNGs from disk and runs them
 * through the active `browser` adapter's `diff()` method, optionally
 * thresholded.
 *
 * The adapter is resolved lazily (per run) so that swaps between command
 * construction and execution are honored, and so callers passing an explicit
 * adapter bypass the registry entirely.
 */
export function makeVisualDiffCommand(opts?: VisualDiffOptions): Command {
  const getAdapterRegistry = opts?.getAdapterRegistry ?? getBuiltinAdapters;
  const resolveAdapter = (): BrowserAdapter =>
    opts?.adapter ?? (getAdapterRegistry().getActive('browser') as BrowserAdapter);

  return {
    name: 'visual.diff',
    describe: 'Pixel-diff two PNGs (baseline vs current) and report the differing pixel count',
    async run(ctx) {
      const baselineArg = ctx.args[0];
      const currentArg = ctx.args[1];
      if (!baselineArg || !currentArg) {
        throw new CLIError(
          'CONFIG_INVALID',
          'visual diff requires two PNG paths',
          'usage: levelzero visual diff <baseline.png> <current.png> [--threshold N] [--alpha 0..1]',
        );
      }

      const baselinePath = resolvePath(ctx.cwd, baselineArg);
      const currentPath = resolvePath(ctx.cwd, currentArg);

      const threshold = parseNumberFlag(ctx.flags['threshold'], 'threshold');
      const alpha = parseNumberFlag(ctx.flags['alpha'], 'alpha');

      const [baseline, current] = await Promise.all([
        readPng(baselinePath),
        readPng(currentPath),
      ]);

      const diffOpts: DiffOptions = {};
      if (alpha !== undefined) diffOpts.threshold = alpha;

      const result = await resolveAdapter().diff(baseline, current, diffOpts);

      if (threshold !== undefined && result.diffPixels > threshold) {
        throw new CLIError(
          'CONFIG_INVALID',
          `visual diff exceeded threshold: diffPixels=${result.diffPixels} > ${threshold} (total=${result.totalPixels}, ratio=${result.diffRatio})`,
          'rebaseline the snapshot or raise --threshold',
        );
      }

      return result;
    },
  };
}

export const visualDiffCommand: Command = makeVisualDiffCommand();
