import { resolveStackContext } from '../services/context';
import { stopDockerService } from '../docker/runner';
import type { Registry } from '../registry';
import type { Command } from './types';

export function makeStopCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stop',
    describe: 'Tear down the current worktree’s stack (volumes persist)',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const reg = getRegistry();

      return await reg.withLock(async () => {
        const entry = await reg.get(stackCtx.worktreeKey);
        if (!entry) {
          return { stopped: false, key: stackCtx.worktreeKey, reason: 'not running' };
        }
        for (const cname of entry.containers) {
          await stopDockerService({ serviceName: '', containerName: cname, ports: {} });
        }
        await reg.remove(stackCtx.worktreeKey);
        return { stopped: true, key: stackCtx.worktreeKey, containers: entry.containers };
      });
    },
  };
}
