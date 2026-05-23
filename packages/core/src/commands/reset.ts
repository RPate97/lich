import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import {
  buildComposeBundle,
  writeComposeFile,
  type PluginComposeContributions,
} from '../compose/stack';
import { makeComposeRunner } from '../compose/runner';
import type { Registry } from '../registry';
import type { Command } from './types';
import type { DockerService, Service } from '../services/types';
import { makeUpCommand as makeDevCommand, type DevOptions } from './up';
import { resolveEnvForService } from '../env/resolve';

function dockerServicesOnly(list: Service[]): DockerService[] {
  return list.filter((s): s is DockerService => s.kind === 'docker');
}

/**
 * Merged compose service-name set — same shape as in `stop.ts`. Keeps the
 * resolver loop here independent of the dev/stop helpers; LEV-182 keeps
 * dev/stop/reset self-contained because each command's lifecycle is different
 * (reset → down -v → dev → up) and a shared helper would force one of them to
 * import a sibling.
 */
function collectComposeServiceNames(
  docker: DockerService[],
  pluginCompose: PluginComposeContributions,
): string[] {
  const seen = new Set<string>();
  for (const s of docker) seen.add(s.name);
  for (const name of Object.keys(pluginCompose.services)) seen.add(name);
  return [...seen];
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
  const getPluginCompose = opts?.getPluginCompose;
  const getEnvSourceRegistry = opts?.getEnvSourceRegistry;
  const getEnvInjection = opts?.getEnvInjection;
  const getResolvedBulkSources = opts?.getResolvedBulkSources;

  return {
    name: 'reset',
    describe: 'Nuke the current stack’s volumes and bring it back up empty',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const services = dockerServicesOnly(getServices());
      const pluginCompose: PluginComposeContributions = getPluginCompose?.() ?? {
        services: {},
        volumes: {},
        networks: {},
      };
      const reg = getRegistry();

      await reg.withLock(async () => {
        const entry = await reg.get(stackCtx.worktreeKey);
        // With a known entry we can rebuild the full compose file (services
        // and named volumes) so `down -v` removes both containers and
        // volumes. Without an entry we don't know the allocator's port
        // choices, but compose only needs `name:` to identify the project
        // for teardown — so emit a services-less bundle. Any orphan
        // containers from a prior run will still be removed by name.
        //
        // LEV-182 — when an entry is present we also re-resolve container-
        // context env so the emitted compose file matches what dev produced.
        // The services-less fallback skips resolution (no services to
        // resolve env for).
        const envRegistry = getEnvSourceRegistry?.();
        const envInjection = getEnvInjection?.();
        const bulkCache = getResolvedBulkSources?.();
        const composeServiceEnv: Record<string, Record<string, string>> = {};
        if (entry && envRegistry) {
          const composeServiceNames = collectComposeServiceNames(services, pluginCompose);
          for (const name of composeServiceNames) {
            composeServiceEnv[name] = await resolveEnvForService({
              serviceName: name,
              context: 'container',
              registry: envRegistry,
              injection: envInjection,
              ports: entry.ports,
              projectRoot: stackCtx.worktreePath,
              worktreeKey: stackCtx.worktreeKey,
              bulkCache,
            });
          }
        }
        const bundle = entry
          ? buildComposeBundle(
              stackCtx,
              services,
              entry.ports,
              pluginCompose,
              composeServiceEnv,
            )
          : buildComposeBundle(stackCtx, [], {}, pluginCompose);
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
