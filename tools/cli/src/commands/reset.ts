import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import { stopDockerService, removeServiceVolume } from '../docker/runner';
import type { Registry } from '../registry';
import type { Command } from './types';
import type { DockerService, Service } from '../services/types';
import { makeDevCommand } from './dev';

function dockerServicesOnly(list: Service[]): DockerService[] {
  return list.filter((s): s is DockerService => s.kind === 'docker');
}

export function makeResetCommand(getRegistry: () => Registry): Command {
  return {
    name: 'reset',
    describe: 'Nuke the current stack’s volumes and bring it back up empty',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const services = dockerServicesOnly(getBuiltinServices());
      const reg = getRegistry();

      await reg.withLock(async () => {
        const entry = await reg.get(stackCtx.worktreeKey);
        if (entry) {
          for (const cname of entry.containers) {
            await stopDockerService({ serviceName: '', containerName: cname, ports: {} });
          }
          await reg.remove(stackCtx.worktreeKey);
        }
        for (const svc of services) {
          await removeServiceVolume(svc, stackCtx);
        }
      });

      const dev = makeDevCommand(getRegistry);
      return await dev.run(ctx);
    },
  };
}
