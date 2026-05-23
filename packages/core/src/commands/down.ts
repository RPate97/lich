import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import {
  buildComposeBundle,
  writeComposeFile,
  type PluginComposeContributions,
} from '../compose/stack';
import { makeComposeRunner, type ComposeRunner } from '../compose/runner';
import type { Registry } from '../registry';
import type { Command } from './types';
import type { DockerService, OwnedService, Service } from '../services/types';
import type { EnvSourceRegistry } from '../env/registry';
import {
  resolveEnvForService,
  type BulkResolutionCache,
  type EnvInjectionMap,
} from '../env/resolve';
import { join } from 'node:path';
import { signalDetachedOwned } from '../owned/teardown';

export { signalDetachedOwned };

export interface StopOptions {
  /** Service provider; defaults to getBuiltinServices. Tests can inject custom lists. */
  getServices?: () => Service[];
  /**
   * Factory for the compose runner. Defaults to {@link makeComposeRunner}.
   * Tests inject a stub that records the `down` call and never touches docker.
   */
  composeRunnerFactory?: (projectName: string, composeFile: string) => ComposeRunner;
  /**
   * Plugin-contributed compose services/volumes/networks (post-LEV-148). The
   * dispatcher fills this from `bootPlugins().compose` so the re-emitted
   * compose file teardown finds the same shape `dev` brought up. Defaults to
   * empty when omitted.
   */
  getPluginCompose?: () => PluginComposeContributions;
  /**
   * Plugin-contributed `OwnedService` entries (post-LEV-154). Accepted for
   * parity with {@link DevOptions} so the dispatcher can pass the same option
   * shape through to `stop`; `stop` only consumes the docker subset of the
   * merged service list (owned services are managed by `dev`'s
   * `concurrently` runner, which the dispatch path tears down via its own
   * lifecycle), but accepting the option keeps the wiring symmetric and
   * future-proofs any per-owned teardown logic.
   */
  getPluginOwnedServices?: () => OwnedService[];
  /**
   * Boot-collected EnvSource registry (Plan 16 / LEV-181). Accepted for parity
   * with {@link DevOptions} so the dispatcher passes the same wiring through.
   * `stop` re-emits the compose file with the same resolved env `dev` used so
   * `docker compose down` operates on a byte-identical file. Without it the
   * env layer is skipped — sufficient for teardown since compose only needs
   * the project name to match.
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
  /** See {@link DevOptions.getEnvInjection}. */
  getEnvInjection?: () => EnvInjectionMap | undefined;
  /** See {@link DevOptions.getResolvedBulkSources}. */
  getResolvedBulkSources?: () => BulkResolutionCache;
}

function dockerServicesOnly(list: Service[]): DockerService[] {
  return list.filter((s): s is DockerService => s.kind === 'docker');
}

/**
 * Merged compose service-name set. Mirrors {@link buildComposeBundle}'s merge
 * order: legacy DockerService entries first (service name === `s.name`), then
 * plugin-contributed `addComposeService` entries. De-duplicated so a same-name
 * collision contributes one entry to the resolution loop above.
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

export { makeDownCommand as makeStopCommand };

export function makeDownCommand(
  getRegistry: () => Registry,
  opts?: StopOptions,
): Command {
  const getServices = opts?.getServices ?? getBuiltinServices;
  const composeRunnerFactory = opts?.composeRunnerFactory ?? makeComposeRunner;
  const getPluginCompose = opts?.getPluginCompose;
  const getEnvSourceRegistry = opts?.getEnvSourceRegistry;
  const getEnvInjection = opts?.getEnvInjection;
  const getResolvedBulkSources = opts?.getResolvedBulkSources;

  return {
    name: 'down',
    describe: 'Tear down the current worktree’s stack (volumes persist)',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const reg = getRegistry();

      return await reg.withLock(async () => {
        const entry = await reg.get(stackCtx.worktreeKey);
        if (!entry) {
          const result = { stopped: false, key: stackCtx.worktreeKey, reason: 'not running' };
          if (ctx.format === 'json') return result;
          return `no stack running for ${stackCtx.worktreeKey}\n`;
        }

        // Re-emit the compose file with the recorded ports so `docker compose
        // down` finds the same project state it brought up. Compose only needs
        // the project name to match for container teardown, but we re-emit
        // defensively in case a stale file was edited or deleted.
        const docker = dockerServicesOnly(getServices());
        const pluginCompose = getPluginCompose?.() ?? {
          services: {},
          volumes: {},
          networks: {},
        };

        // LEV-182 — re-resolve container-context env per compose service so
        // the regenerated compose file matches what `dev` produced. Compose
        // teardown only matches on project name, so the env round-trip is
        // belt-and-suspenders, but it keeps the on-disk file consistent for
        // operators inspecting `.lich/<key>/docker-compose.yml`.
        const envRegistry = getEnvSourceRegistry?.();
        const envInjection = getEnvInjection?.();
        const bulkCache = getResolvedBulkSources?.();
        const composeServiceNames = collectComposeServiceNames(docker, pluginCompose);
        const composeServiceEnv: Record<string, Record<string, string>> = {};
        if (envRegistry) {
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
        const bundle = buildComposeBundle(
          stackCtx,
          docker,
          entry.ports,
          pluginCompose,
          composeServiceEnv,
        );
        await writeComposeFile(bundle);

        // LEV-194 — signal any detached owned services first, before tearing
        // down compose. This ordering matches `dev`: owned processes may
        // depend on compose-managed services (e.g. an api hitting postgres),
        // so killing the api first means postgres goes away to no readers.
        const pidDir = join(
          stackCtx.worktreePath,
          '.lich',
          'state',
          stackCtx.worktreeKey,
          'pids',
        );
        const ownedTeardown = await signalDetachedOwned(pidDir);

        const runner = composeRunnerFactory(bundle.projectName, bundle.composeFilePath);
        await runner.down({ volumes: false });

        await reg.remove(stackCtx.worktreeKey);
        const result = {
          stopped: true as const,
          key: stackCtx.worktreeKey,
          containers: entry.containers,
          owned: ownedTeardown,
        };
        if (ctx.format === 'json') return result;
        const lines: string[] = [`Stopped stack ${stackCtx.worktreeKey}`];
        for (const c of entry.containers) lines.push(`  removed ${c}`);
        for (const o of ownedTeardown) {
          lines.push(`  ${o.result} ${o.name} (pid ${o.pid})`);
        }
        return lines.join('\n') + '\n';
      });
    },
  };
}
