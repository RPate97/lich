import { resolveStackContext } from '../../services/context';
import { AdapterRegistry, getBuiltinAdapters } from '../../adapters/registry';
import { CLIError } from '../../errors';
import type { UIAdapter } from '../../adapters/ui/types';
import type { Command } from '../types';

export interface UiAddOptions {
  /**
   * UI adapter. When omitted, resolved from the AdapterRegistry returned by
   * `getAdapterRegistry` (default `getBuiltinAdapters()`); tests can still
   * pass an explicit stub to bypass the registry entirely.
   */
  adapter?: UIAdapter;
  /** AdapterRegistry provider used when `adapter` is omitted. */
  getAdapterRegistry?: () => AdapterRegistry;
}

/**
 * Build `levelzero ui add <component>`. Resolves the worktree, then hands the
 * component name to the active `ui` adapter (shadcn by default). The `--dry-run`
 * flag is forwarded so callers can inspect the generated command without
 * executing it.
 */
export function makeUiAddCommand(opts?: UiAddOptions): Command {
  const getAdapterRegistry = opts?.getAdapterRegistry ?? getBuiltinAdapters;
  // Lazy resolution: tests that pass `adapter` never touch the registry, and
  // a swap landed between command construction and run-time is honored.
  const resolveAdapter = (): UIAdapter =>
    opts?.adapter ?? (getAdapterRegistry().getActive('ui') as UIAdapter);

  return {
    name: 'ui.add',
    describe: 'Add a shadcn component to the project',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const component = ctx.args[0];
      if (!component) {
        throw new CLIError(
          'INTERNAL',
          'ui add requires a component name',
          'usage: levelzero ui add <name>',
        );
      }
      const dryRun = Boolean(ctx.flags['dry-run']);
      const adapter = resolveAdapter();
      const result = await adapter.add(
        {
          projectRoot: stackCtx.worktreePath,
          appDir: (ctx.flags['app-dir'] as string) || 'apps/web',
        },
        component,
        { dryRun },
      );
      return result;
    },
  };
}

export const uiAddCommand: Command = makeUiAddCommand();
