import { resolveStackContext } from '../../services/context';
import { shadcnAdapter } from '../../adapters/ui/shadcn';
import type { Command } from '../types';

export const uiListCommand: Command = {
  name: 'ui.list',
  describe: 'List installed shadcn components',
  async run(ctx) {
    const stackCtx = await resolveStackContext(ctx.cwd);
    return shadcnAdapter.list({
      projectRoot: stackCtx.worktreePath,
      appDir: (ctx.flags['app-dir'] as string) || 'apps/web',
    });
  },
};
