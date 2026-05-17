import { CLIError } from '../../errors';
import { findWorktree } from '../../worktree';
import type { Registry } from '../../registry';
import type { Command } from '../types';

export function makeStacksCurrentCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.current',
    describe: 'Show the stack the CLI would target from the current directory',
    async run(ctx) {
      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        throw new CLIError(
          'NO_PROJECT',
          'not inside a levelzero project',
          'run `levelzero init` or cd into a directory with levelzero.config.ts',
        );
      }
      const entry = await getRegistry().get(wt.key);
      return {
        key: wt.key,
        path: wt.path,
        configPath: wt.configPath,
        running: entry !== undefined,
        entry: entry ?? null,
      };
    },
  };
}
