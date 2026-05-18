import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../errors';
import { findWorktree } from '../worktree';
import { Registry, type StackEntry } from '../registry';
import type { Command } from './types';

/** Output row shape for a single service URL. */
export interface UrlRow {
  service: string;
  host: string;
  target: string;
}

/**
 * Derive `{service, host, target}` rows for a stack.
 *
 * Prefers `entry.urls` (populated by `dev` after portless registration); falls
 * back to `http://localhost:<port>` rows when `urls` is empty (e.g., portless
 * wasn't available when `dev` ran, or this entry pre-dates LEV-96).
 */
function rowsForEntry(entry: StackEntry): UrlRow[] {
  const urlEntries = Object.entries(entry.urls);
  if (urlEntries.length > 0) {
    return urlEntries.map(([service, raw]) => {
      // Stored value is the user-facing URL portless registered. Parse it to
      // separate the host (for display) from the full target (for clicking).
      // If the stored value can't be parsed as a URL, fall back to treating it
      // as a bare host with no scheme.
      try {
        const u = new URL(raw);
        return { service, host: u.host, target: raw };
      } catch {
        return { service, host: raw, target: raw };
      }
    });
  }
  return Object.entries(entry.ports).map(([service, port]) => ({
    service,
    host: `localhost:${port}`,
    target: `http://localhost:${port}`,
  }));
}

export interface MakeUrlsCommandOptions {
  getRegistry: () => Registry;
}

export function makeUrlsCommand(opts: MakeUrlsCommandOptions): Command {
  const { getRegistry } = opts;
  return {
    name: 'urls',
    describe: 'Print user-facing URLs for the current stack (or all with --all)',
    async run(ctx) {
      const reg = getRegistry();

      if (ctx.flags['all']) {
        const all = await reg.list();
        const result = {
          stacks: all.map(({ key, entry }) => ({
            key,
            path: entry.path,
            branch: entry.branch,
            urls: rowsForEntry(entry),
          })),
        };
        if (ctx.format === 'json') return result;
        return renderAllStacksUrlsPretty(result.stacks);
      }

      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        throw new CLIError(
          'NO_PROJECT',
          'not inside a levelzero project',
          'run `levelzero init`, cd into a directory with levelzero.config.ts, or pass --all',
        );
      }
      const entry = await reg.get(wt.key);
      const urls = entry ? rowsForEntry(entry) : [];
      if (ctx.format === 'json') return { urls };
      return renderUrlsPretty(urls);
    },
  };
}

function renderUrlsPretty(urls: UrlRow[]): string {
  if (urls.length === 0) return 'no urls registered (run `levelzero dev` to bring the stack up)\n';
  // Emit `service=target` lines so the output is greppable and survives
  // copy/paste into a shell `eval` without quoting headaches.
  return urls.map((u) => `${u.service}=${u.target}`).join('\n') + '\n';
}

function renderAllStacksUrlsPretty(
  stacks: Array<{ key: string; path: string; branch: string; urls: UrlRow[] }>,
): string {
  if (stacks.length === 0) return 'no stacks running\n';
  const lines: string[] = [];
  for (const s of stacks) {
    lines.push(`# ${s.key} (${s.path})`);
    if (s.urls.length === 0) {
      lines.push('  (no urls)');
    } else {
      for (const u of s.urls) lines.push(`${u.service}=${u.target}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function defaultRegistryPath(): string {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return join(home, '.levelzero', 'registry.json');
}

/**
 * Default `urlsCommand` instance that resolves the registry path from
 * `LEVELZERO_HOME` (or `$HOME`) on each invocation — the same convention used
 * by `bin.ts` for the production registry. Exported alongside the
 * `makeUrlsCommand` factory so callers that don't need a custom registry
 * (e.g. simple imports in tests / scripts) get a working `Command` for free.
 *
 * `bin.ts` should still prefer `makeUrlsCommand({ getRegistry })` so it uses
 * the same registry instance as every other command in the suite.
 */
export const urlsCommand: Command = makeUrlsCommand({
  getRegistry: () => new Registry(defaultRegistryPath()),
});
