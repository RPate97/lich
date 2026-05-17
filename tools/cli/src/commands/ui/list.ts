import { resolveStackContext } from '../../services/context';
import { AdapterRegistry, getBuiltinAdapters } from '../../adapters/registry';
import type { UIAdapter } from '../../adapters/ui/types';
import type { Command } from '../types';

export interface UiListOptions {
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
 * Build `levelzero ui list`. Asks the active `ui` adapter (shadcn by default)
 * for the set of installed components under the resolved app directory.
 */
export function makeUiListCommand(opts?: UiListOptions): Command {
  const getAdapterRegistry = opts?.getAdapterRegistry ?? getBuiltinAdapters;
  const resolveAdapter = (): UIAdapter =>
    opts?.adapter ?? (getAdapterRegistry().getActive('ui') as UIAdapter);

  return {
    name: 'ui.list',
    describe: 'List installed shadcn components',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      return resolveAdapter().list({
        projectRoot: stackCtx.worktreePath,
        appDir: (ctx.flags['app-dir'] as string) || 'apps/web',
      });
    },
  };
}

export const uiListCommand: Command = makeUiListCommand();
