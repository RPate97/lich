import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import { allocatePorts } from '../ports/allocator';
import { containerName, networkName } from '../compose/naming';
import { runOwnedServices } from '../owned/runner';
import {
  buildComposeBundle,
  writeComposeFile,
  type ComposeBundle,
} from '../compose/stack';
import { makeComposeRunner, type ComposeRunner } from '../compose/runner';
import type { Registry, StackEntry } from '../registry';
import type { Command } from './types';
import type { DockerService, OwnedService, PortMap, Service } from '../services/types';
import { findWorktree } from '../worktree';
import { loadConfig } from '../config';
import { portlessAdapter } from '../adapters/portless/portless';
import { noopPortlessAdapter } from '../adapters/portless/noop';
import type { PortlessAdapter } from '../adapters/portless/types';
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

function deriveEnv(services: Service[], ports: PortMap): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of services) Object.assign(env, s.envContributions(ports));
  return env;
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

  return {
    name: 'dev',
    describe: 'Bring up every service for the current worktree (idempotent)',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const allServices = getServices();
      const docker = dockerServicesOnly(allServices);
      const owned = ownedServicesOnly(allServices);
      const reg = getRegistry();

      // Resolve ports + emit compose file + bring up containers. All of this
      // happens under the registry lock so concurrent `dev` invocations on
      // the same worktree can't race on port allocation or compose state.
      const { entry, bundle } = await reg.withLock(async () => {
        const all = await reg.list();
        const reserved = reservedPortsFromOtherStacks(stackCtx.worktreeKey, all);
        const portNames = collectPortNames(allServices);

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

        const bundle = buildComposeBundle(stackCtx, docker, ports);
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

      if (owned.length === 0) return baseResult;

      const logDir = join(stackCtx.worktreePath, entry.logDir);
      const runner = await runOwnedServices(owned, stackCtx, entry.ports, dockerEnv, { logDir });
      const { exitCodes } = await runner.done;

      return {
        ...baseResult,
        owned: {
          exitCodes,
          pids: runner.pids,
        },
      };
    },
  };
}
