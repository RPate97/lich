import { resolveStackContext } from '../../services/context';
import { shadcnAdapter } from '../../adapters/ui/shadcn';
import { CLIError } from '../../errors';
import type { Command } from '../types';

export const uiAddCommand: Command = {
  name: 'ui.add',
  describe: 'Add a shadcn component to the project',
  async run(ctx) {
    const stackCtx = await resolveStackContext(ctx.cwd);
    const component = ctx.args[0];
    if (!component) {
      throw new CLIError('INTERNAL', 'ui add requires a component name', 'usage: levelzero ui add <name>');
    }
    const dryRun = Boolean(ctx.flags['dry-run']);
    const result = await shadcnAdapter.add(
      { projectRoot: stackCtx.worktreePath, appDir: (ctx.flags['app-dir'] as string) || 'apps/web' },
      component,
      { dryRun },
    );
    return result;
  },
};
