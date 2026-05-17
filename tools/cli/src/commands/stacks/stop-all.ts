import { CLIError } from '../../errors';
import { stopDockerService } from '../../docker/runner';
import { dockerExec } from '../../docker/exec';
import { LEVELZERO_PREFIX } from '../../docker/naming';
import type { Registry } from '../../registry';
import type { Command } from '../types';

async function listLevelzeroContainers(): Promise<string[]> {
  const r = await dockerExec(
    ['ps', '-a', '--filter', `name=${LEVELZERO_PREFIX}`, '--format', '{{.Names}}'],
    { timeoutMs: 10_000 },
  );
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith(LEVELZERO_PREFIX));
}

export function makeStacksStopAllCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.stop',
    describe: 'Tear down every running levelzero stack on this machine (requires --all)',
    async run(ctx) {
      if (!ctx.flags['all']) {
        throw new CLIError(
          'INTERNAL',
          'stacks stop without --all is not supported in v0',
          'pass --all to tear down every running stack',
        );
      }
      const reg = getRegistry();
      const stoppedFromRegistry: string[] = [];
      const fromRegistryContainers = new Set<string>();

      await reg.withLock(async () => {
        const entries = await reg.list();
        for (const { key, entry } of entries) {
          for (const cname of entry.containers) {
            await stopDockerService({ serviceName: '', containerName: cname, ports: {} });
            fromRegistryContainers.add(cname);
          }
          await reg.remove(key);
          stoppedFromRegistry.push(key);
        }
      });

      // Orphan sweep outside the lock — best-effort.
      const remaining = await listLevelzeroContainers();
      const stoppedOrphans: string[] = [];
      for (const cname of remaining) {
        if (fromRegistryContainers.has(cname)) continue;
        await stopDockerService({ serviceName: '', containerName: cname, ports: {} });
        stoppedOrphans.push(cname);
      }

      return { stoppedFromRegistry, stoppedOrphans };
    },
  };
}
