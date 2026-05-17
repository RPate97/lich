import { resolveStackContext, type Command, type UIAdapter } from '@levelzero/core';
import { shadcnAdapter } from '../adapter';

export interface UiListOptions {
  /**
   * UI adapter override. When omitted, defaults to the shadcn adapter shipped
   * by this plugin. Tests can pass an explicit stub to bypass the default.
   */
  adapter?: UIAdapter;
}

/**
 * Build `levelzero ui list`. Asks the UI adapter (shadcn by default) for the
 * set of installed components under the resolved app directory.
 */
export function makeUiListCommand(opts?: UiListOptions): Command {
  const adapter: UIAdapter = opts?.adapter ?? shadcnAdapter;

  return {
    name: 'ui.list',
    describe: 'List installed shadcn components',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      return adapter.list({
        projectRoot: stackCtx.worktreePath,
        appDir: (ctx.flags['app-dir'] as string) || 'apps/web',
      });
    },
  };
}

export const uiListCommand: Command = makeUiListCommand();
