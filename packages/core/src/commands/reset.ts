import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import { buildComposeBundle, writeComposeFile } from '../compose/stack';
import { makeComposeRunner } from '../compose/runner';
import type { Registry } from '../registry';
import type { Command } from './types';
import type { DockerService, Service } from '../services/types';
import { makeDevCommand, type DevOptions } from './dev';

function dockerServicesOnly(list: Service[]): DockerService[] {
  return list.filter((s): s is DockerService => s.kind === 'docker');
}

/**
 * `reset` options mirror the subset of `DevOptions` that affects what reset
 * brings back up — primarily `getServices`, so tests can inject a constrained
 * service list (e.g. `[pgService]`) without touching the absent api/web apps.
 *
 * `composeRunnerFactory` is shared with `dev`: the same factory is used for
 * the `down -v` call in reset and the subsequent `up` call inside dev.
 */
export type ResetOptions = DevOptions;

export function makeResetCommand(
  getRegistry: () => Registry,
  opts?: ResetOptions,
): Command {
  const getServices = opts?.getServices ?? getBuiltinServices;
  const composeRunnerFactory = opts?.composeRunnerFactory ?? makeComposeRunner;

  return {
    name: 'reset',
    describe: 'Nuke the current stack’s volumes and bring it back up empty',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const services = dockerServicesOnly(getServices());
      const reg = getRegistry();

      await reg.withLock(async () => {
        const entry = await reg.get(stackCtx.worktreeKey);
        // With a known entry we can rebuild the full compose file (services
        // and named volumes) so `down -v` removes both containers and
        // volumes. Without an entry we don't know the allocator's port
        // choices, but compose only needs `name:` to identify the project
        // for teardown — so emit a services-less bundle. Any orphan
        // containers from a prior run will still be removed by name.
        const bundle = entry
          ? buildComposeBundle(stackCtx, services, entry.ports)
          : buildComposeBundle(stackCtx, [], {});
        await writeComposeFile(bundle);

        const runner = composeRunnerFactory(bundle.projectName, bundle.composeFilePath);
        await runner.down({ volumes: true });

        if (entry) await reg.remove(stackCtx.worktreeKey);
      });

      const dev = makeDevCommand(getRegistry, opts);
      return await dev.run(ctx);
    },
  };
}
