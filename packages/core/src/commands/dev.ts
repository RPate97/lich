import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import { allocatePorts } from '../ports/allocator';
import { containerName, networkName } from '../compose/naming';
import { runOwnedServices } from '../owned/runner';
import {
  buildComposeBundle,
  writeComposeFile,
  type ComposeBundle,
  type PluginComposeContributions,
} from '../compose/stack';
import { makeComposeRunner, type ComposeRunner } from '../compose/runner';
import type { Registry, StackEntry } from '../registry';
import type { Command } from './types';
import type { DockerService, OwnedService, PortMap, Service } from '../services/types';
import { findWorktree } from '../worktree';
import { loadConfig } from '../config';
import type { EnvSourceRegistry } from '../env/registry';
import {
  resolveEnvForService,
  type BulkResolutionCache,
  type EnvInjectionMap,
} from '../env/resolve';
import {
  portlessAdapter,
  noopPortlessAdapter,
  type PortlessAdapter,
} from '@levelzero/plugin-portless';
import { basename, join } from 'node:path';

export interface DevOptions {
  /** Service provider; defaults to getBuiltinServices. Tests can inject custom lists. */
  getServices?: () => Service[];
  /**
   * Provider for the URL-registration adapter. Defaults to selecting
   * `portlessAdapter` when its `available()` probe returns true, else
   * `noopPortlessAdapter`. Tests inject a mock to avoid shelling out to the
   * real `portless` binary.
   */
  getPortlessAdapter?: () => PortlessAdapter;
  /**
   * Factory for the compose runner. Defaults to {@link makeComposeRunner}
   * (real `docker compose` shell-out). Tests inject a stub that records
   * `up`/`down`/`ps` calls and never touches docker.
   */
  composeRunnerFactory?: (projectName: string, composeFile: string) => ComposeRunner;
  /**
   * Plugin-contributed compose services/volumes/networks (post-LEV-148). The
   * dispatcher fills this from `bootPlugins().compose` so plugins like
   * `@levelzero/plugin-postgres` that call `api.addComposeService` land in the
   * emitted compose file alongside any legacy `DockerService` entries.
   * Defaults to empty when omitted (tests not exercising the plugin path).
   */
  getPluginCompose?: () => PluginComposeContributions;
  /**
   * Plugin-contributed `OwnedService` entries (post-LEV-154). The dispatcher
   * fills this from `bootPlugins().ownedServices` so plugins like
   * `@levelzero/plugin-next` that call `api.addOwnedService` get their
   * services merged into the dev/stop/reset service set alongside the
   * built-ins. Defaults to empty when omitted (tests that inject `getServices`
   * directly typically don't exercise this path).
   */
  getPluginOwnedServices?: () => OwnedService[];
  /**
   * Boot-collected EnvSource registry (Plan 16 / LEV-181). When provided,
   * `dev` runs the per-service resolver (LEV-182) for every compose-managed
   * and owned service: container-context for compose services (writes into
   * each service's `environment:` block, fixing the pre-existing "compose
   * services receive no env" bug) and host-context for owned services
   * (passed into the spawned process env). Without this getter the resolver
   * is skipped and behavior matches the pre-LEV-182 legacy path — used by
   * tests that don't exercise the EnvSource layer.
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
  /**
   * Project config's `envInjection` map (Plan 16). Paired with
   * `getEnvSourceRegistry`: explicit `ENV_VAR -> sourceKey` entries plus
   * `importAll: [namespace, ...]` bulk pass-throughs. Loaded by the
   * dispatcher from `LevelzeroConfig.envInjection`. Defaults to undefined
   * (empty injection — every service receives no Plan-16 vars but the
   * legacy `envContributions` paths still run).
   */
  getEnvInjection?: () => EnvInjectionMap | undefined;
  /**
   * Optional shared bulk-resolution cache (Plan 16 / LEV-181). When the
   * dispatcher provides one, every per-service `resolveEnvForService` call in
   * a single CLI invocation reuses the same map — each registered bulk
   * source's `resolve()` runs at most once even across compose + owned
   * services. Omit in tests; the resolver creates an ephemeral cache per
   * call.
   */
  getResolvedBulkSources?: () => BulkResolutionCache;
}

function dockerServicesOnly(list: Service[]): DockerService[] {
  return list.filter((s): s is DockerService => s.kind === 'docker');
}

function ownedServicesOnly(list: Service[]): OwnedService[] {
  return list.filter((s): s is OwnedService => s.kind === 'owned');
}

function collectPortNames(services: Service[]): string[] {
  const out: string[] = [];
  for (const s of services) for (const p of s.portNames) out.push(p);
  return out;
}

/**
 * Scan a plugin's compose-service `ports` entries for `${PORT_<name>}`
 * placeholders and return the unique set of names referenced. The allocator
 * is then asked to assign a host port to each so the emitter has a value to
 * substitute when it writes the compose file.
 *
 * Mirrors the placeholder regex used in `compose/emitter.ts` — kept inline
 * here to avoid a cross-module export of a one-line regex.
 */
function collectPluginPortNames(
  contributions: PluginComposeContributions,
): string[] {
  const placeholder = /\$\{PORT_([A-Za-z0-9_-]+)\}/g;
  const seen = new Set<string>();
  for (const def of Object.values(contributions.services)) {
    for (const p of def.ports ?? []) {
      for (const match of p.matchAll(placeholder)) {
        const name = match[1];
        if (name) seen.add(name);
      }
    }
  }
  return [...seen];
}

function deriveEnv(services: Service[], ports: PortMap): Record<string, string> {
  const env: Record<string, string> = {};
  // `envContributions` is the legacy per-service env hook (Plan 16 / LEV-178+
  // made it optional once v0 plugins migrated to `api.addEnvSource()` in
  // LEV-187). Services without it simply contribute nothing here — the
  // EnvSource resolver picks up their values via the new pipeline.
  for (const s of services) {
    if (typeof s.envContributions === 'function') {
      Object.assign(env, s.envContributions(ports));
    }
  }
  return env;
}

/**
 * Compose service-name set used for per-service env resolution (LEV-182). Same
 * merge order as {@link buildComposeBundle}: legacy `DockerService` entries
 * first (converted via `dockerServiceToCompose` — name === `s.name`), then
 * plugin-contributed `addComposeService` entries on top. De-duplicates so a
 * plugin that re-declares a same-named docker service contributes one entry
 * (matching the bundle's last-write-wins behavior).
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

function reservedPortsFromOtherStacks(
  thisKey: string,
  entries: Array<{ key: string; entry: StackEntry }>,
): Set<number> {
  const out = new Set<number>();
  for (const { key, entry } of entries) {
    if (key === thisKey) continue;
    for (const port of Object.values(entry.ports)) out.add(port);
  }
  return out;
}

/**
 * Default portless adapter selector: probe the real CLI-backed adapter and
 * fall back to the no-op when it isn't available. Tests bypass this via
 * `DevOptions.getPortlessAdapter` to avoid spawning the real `portless`.
 */
async function defaultSelectPortlessAdapter(): Promise<PortlessAdapter> {
  try {
    if (await portlessAdapter.available()) return portlessAdapter;
  } catch {
    // Treat any probe failure as "not available". `available()` already
    // swallows ENOENT etc., but we guard defensively in case a future impl
    // surfaces them.
  }
  return noopPortlessAdapter;
}

/**
 * Resolve the project name used for portless host construction.
 *
 * Reads `LevelzeroConfig.name` from the worktree's config; if absent or the
 * config can't be loaded, falls back to the basename of the worktree path so
 * registration still has a stable label rather than failing.
 */
async function resolveProjectName(worktreePath: string): Promise<string> {
  const wt = await findWorktree(worktreePath);
  if (!wt) return basename(worktreePath);
  try {
    const cfg = await loadConfig(wt.configPath);
    if (cfg.name && cfg.name.length > 0) return cfg.name;
  } catch {
    // Fall through to basename below.
  }
  return basename(worktreePath);
}

export function makeDevCommand(getRegistry: () => Registry, opts?: DevOptions): Command {
  const getServices = opts?.getServices ?? getBuiltinServices;
  const getPortlessAdapter = opts?.getPortlessAdapter;
  const composeRunnerFactory = opts?.composeRunnerFactory ?? makeComposeRunner;
  const getPluginCompose = opts?.getPluginCompose;
  const getPluginOwnedServices = opts?.getPluginOwnedServices;
  const getEnvSourceRegistry = opts?.getEnvSourceRegistry;
  const getEnvInjection = opts?.getEnvInjection;
  const getResolvedBulkSources = opts?.getResolvedBulkSources;

  return {
    name: 'dev',
    describe: 'Bring up every service for the current worktree (idempotent)',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      // Built-in services first; plugin-contributed `OwnedService` entries
      // (post-LEV-154) append onto the same list so the runner treats them
      // identically. Order is preserved so `dependsOn` chains across the
      // built-in/plugin boundary still resolve in declaration order (e.g.
      // built-in `api` precedes plugin-contributed `web`).
      const allServices: Service[] = [
        ...getServices(),
        ...(getPluginOwnedServices?.() ?? []),
      ];
      const docker = dockerServicesOnly(allServices);
      const owned = ownedServicesOnly(allServices);
      const pluginCompose = getPluginCompose?.() ?? {
        services: {},
        volumes: {},
        networks: {},
      };
      const reg = getRegistry();

      // Resolve ports + emit compose file + bring up containers. All of this
      // happens under the registry lock so concurrent `dev` invocations on
      // the same worktree can't race on port allocation or compose state.
      const { entry, bundle } = await reg.withLock(async () => {
        const all = await reg.list();
        const reserved = reservedPortsFromOtherStacks(stackCtx.worktreeKey, all);
        // Merge port names from Service[] (legacy) with `${PORT_<name>}`
        // placeholders scanned out of plugin compose contributions so both
        // sources get host ports allocated in the same pool.
        const portNames = [
          ...collectPortNames(allServices),
          ...collectPluginPortNames(pluginCompose),
        ];

        const existing = await reg.get(stackCtx.worktreeKey);
        // Re-use previously allocated ports so the compose file is stable across
        // dev runs and idempotent up calls don't re-publish to different host
        // ports.
        let ports: PortMap;
        if (existing) {
          ports = {};
          let needsAlloc = false;
          for (const name of portNames) {
            const existingPort = existing.ports[name];
            if (existingPort === undefined) {
              needsAlloc = true;
              break;
            }
            ports[name] = existingPort;
          }
          if (needsAlloc) {
            ports = await allocatePorts(portNames, { reservedPorts: reserved });
          }
        } else {
          ports = await allocatePorts(portNames, { reservedPorts: reserved });
        }

        // Plan 16 / LEV-182 — resolve container-context env for every compose
        // service before emitting the YAML so the resolved values land inside
        // each service's `environment:` block. The "compose services receive
        // no env" pre-existing bug is fixed here: previously
        // `buildComposeBundle` had no env input at all and `dockerServiceToCompose`
        // dropped the legacy `envContributions` on the floor for the
        // container side. Now every name in the merged compose service set
        // (legacy docker services + plugin `addComposeService` contributions)
        // gets its resolved env injected.
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
              ports,
              projectRoot: stackCtx.worktreePath,
              worktreeKey: stackCtx.worktreeKey,
              bulkCache,
            });
          }
        }

        const bundle = buildComposeBundle(
          stackCtx,
          docker,
          ports,
          pluginCompose,
          composeServiceEnv,
        );
        await writeComposeFile(bundle);

        const runner = composeRunnerFactory(bundle.projectName, bundle.composeFilePath);
        if (Object.keys(bundle.services).length > 0) {
          await runner.up({ detach: true, waitForHealthy: true });
        }

        const newEntry: StackEntry = {
          path: stackCtx.worktreePath,
          branch: stackCtx.branch,
          ports,
          // Preserve existing URLs across re-runs; portless block below may
          // overwrite individual keys but shouldn't drop unrelated ones.
          urls: existing?.urls ?? {},
          containers: bundle.containerNames,
          network: networkName(stackCtx.worktreeKey),
          logDir: '.levelzero/logs',
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        await reg.upsert(stackCtx.worktreeKey, newEntry);
        return { entry: newEntry, bundle };
      });

      // Register per-service URLs through the active portless adapter. Done
      // after services are up (containers started) and before owned processes
      // run, so the proxy can reach them as soon as they start serving.
      const ownedWithUrl = owned.filter(
        (s): s is OwnedService & { urlName: string } =>
          typeof s.urlName === 'string' && s.urlName.length > 0,
      );
      if (ownedWithUrl.length > 0) {
        const adapter = getPortlessAdapter
          ? getPortlessAdapter()
          : await defaultSelectPortlessAdapter();
        if (await adapter.available()) {
          const projectName = await resolveProjectName(stackCtx.worktreePath);
          // `branch` may be empty (detached HEAD); fall back to "main" so the
          // host still parses. This is intentionally simple — branch sanitization
          // beyond this is out of scope for LEV-106.
          const branchLabel = stackCtx.branch.length > 0 ? stackCtx.branch : 'main';
          const newUrls: Record<string, string> = { ...entry.urls };
          for (const svc of ownedWithUrl) {
            const portName = svc.portNames[0];
            if (!portName) continue; // can't register without a port
            const port = entry.ports[portName];
            if (port === undefined) continue;
            const host = `${branchLabel}.${svc.urlName}.${projectName}.localhost`;
            const target = `http://localhost:${port}`;
            await adapter.register({ host, target });
            newUrls[svc.name] = `https://${host}`;
          }
          // Persist URLs back into the registry so `levelzero urls` can read them.
          await reg.withLock(async () => {
            const cur = await reg.get(stackCtx.worktreeKey);
            if (!cur) return;
            cur.urls = newUrls;
            await reg.upsert(stackCtx.worktreeKey, cur);
          });
          // Reflect the persisted urls in our in-memory entry too, so downstream
          // consumers (and the return value, if surfaced later) see them.
          entry.urls = newUrls;
        }
      }

      const dockerEnv = deriveEnv(docker, entry.ports);
      const allEnv = deriveEnv(allServices, entry.ports);

      // Plan 16 / LEV-182 — resolve host-context env per owned service. Same
      // resolver as the compose path, different `context` so named sources
      // pick `host()` and bulk resolvers see `consumerContext: 'host'`. The
      // runner layers this on top of the inherited `process.env` + the shared
      // `dockerEnv` (legacy cross-service vars like the derived DATABASE_URL).
      // Reuses the shared bulk cache so each registered bulk source's
      // `resolve()` runs at most once even across compose + owned services
      // in a single `dev` invocation.
      const envRegistry = getEnvSourceRegistry?.();
      const envInjection = getEnvInjection?.();
      const bulkCache = getResolvedBulkSources?.();
      const ownedServiceEnv: Record<string, Record<string, string>> = {};
      if (envRegistry) {
        for (const s of owned) {
          ownedServiceEnv[s.name] = await resolveEnvForService({
            serviceName: s.name,
            context: 'host',
            registry: envRegistry,
            injection: envInjection,
            ports: entry.ports,
            projectRoot: stackCtx.worktreePath,
            worktreeKey: stackCtx.worktreeKey,
            bulkCache,
          });
        }
      }

      const serviceSummaries = docker.map((s) => ({
        name: s.name,
        container: containerName(stackCtx.worktreeKey, s.name),
        ports: Object.fromEntries(s.portNames.map((p) => [p, entry.ports[p]])),
      }));

      const baseResult = {
        key: stackCtx.worktreeKey,
        path: entry.path,
        branch: entry.branch,
        ports: entry.ports,
        env: allEnv,
        containers: entry.containers,
        network: entry.network,
        services: serviceSummaries,
        compose: {
          projectName: bundle.projectName,
          file: bundle.composeFilePath,
        },
      };

      if (owned.length === 0) {
        if (ctx.format === 'json') return baseResult;
        return renderDevPretty(baseResult, null);
      }

      const logDir = join(stackCtx.worktreePath, entry.logDir);
      const runner = await runOwnedServices(
        owned,
        stackCtx,
        entry.ports,
        dockerEnv,
        { logDir },
        ownedServiceEnv,
      );
      const { exitCodes } = await runner.done;

      const fullResult = {
        ...baseResult,
        owned: {
          exitCodes,
          pids: runner.pids,
        },
      };
      if (ctx.format === 'json') return fullResult;
      return renderDevPretty(baseResult, fullResult.owned);
    },
  };
}

interface DevPrettyBase {
  key: string;
  path: string;
  ports: Record<string, number>;
  services: Array<{ name: string; container: string }>;
  compose: { projectName: string; file: string };
}

interface DevPrettyOwned {
  exitCodes: Record<string, number>;
  pids: Record<string, number>;
}

function renderDevPretty(base: DevPrettyBase, owned: DevPrettyOwned | null): string {
  const lines: string[] = [];
  lines.push(`Stack up: ${base.key}`);
  lines.push(`  path:    ${base.path}`);
  lines.push(`  compose: ${base.compose.file}`);
  if (base.services.length > 0) {
    lines.push('services:');
    for (const s of base.services) lines.push(`  ${s.name}  (${s.container})`);
  }
  const portEntries = Object.entries(base.ports);
  if (portEntries.length > 0) {
    lines.push('ports:');
    for (const [name, port] of portEntries) lines.push(`  ${name}=${port}`);
  }
  if (owned) {
    const pidCount = Object.keys(owned.pids).length;
    const exits = Object.entries(owned.exitCodes)
      .map(([name, code]) => `${name}=${code}`)
      .join(',');
    lines.push(`owned: ${pidCount} process(es), exitCodes=[${exits}]`);
  }
  return lines.join('\n') + '\n';
}
