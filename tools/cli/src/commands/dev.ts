import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import { allocatePorts } from '../ports/allocator';
import {
  startDockerService,
  stopDockerService,
  isContainerRunning,
} from '../docker/runner';
import { containerName, networkName } from '../docker/naming';
import type { Registry, StackEntry } from '../registry';
import type { Command } from './types';
import type { DockerService, PortMap, Service } from '../services/types';

function dockerServicesOnly(list: Service[]): DockerService[] {
  return list.filter((s): s is DockerService => s.kind === 'docker');
}

function collectPortNames(services: DockerService[]): string[] {
  const out: string[] = [];
  for (const s of services) for (const p of s.portNames) out.push(p);
  return out;
}

function deriveEnv(services: DockerService[], ports: PortMap): Record<string, string> {
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

export function makeDevCommand(getRegistry: () => Registry): Command {
  return {
    name: 'dev',
    describe: 'Bring up every service for the current worktree (idempotent)',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const services = dockerServicesOnly(getBuiltinServices());
      const reg = getRegistry();

      const entry = await reg.withLock(async () => {
        const existing = await reg.get(stackCtx.worktreeKey);
        if (existing) {
          let allUp = true;
          for (const cname of existing.containers) {
            if (!(await isContainerRunning(cname))) {
              allUp = false;
              break;
            }
          }
          if (allUp) return existing;
          for (const cname of existing.containers) {
            await stopDockerService({ serviceName: '', containerName: cname, ports: {} });
          }
          await reg.remove(stackCtx.worktreeKey);
        }

        const all = await reg.list();
        const reserved = reservedPortsFromOtherStacks(stackCtx.worktreeKey, all);
        const portNames = collectPortNames(services);
        const ports = await allocatePorts(portNames, { reservedPorts: reserved });

        const containers: string[] = [];
        for (const svc of services) {
          const handle = await startDockerService(svc, stackCtx, ports);
          containers.push(handle.containerName);
        }

        const newEntry: StackEntry = {
          path: stackCtx.worktreePath,
          branch: stackCtx.branch,
          ports,
          urls: {},
          containers,
          network: networkName(stackCtx.worktreeKey),
          logDir: '.levelzero/logs',
          createdAt: new Date().toISOString(),
        };
        await reg.upsert(stackCtx.worktreeKey, newEntry);
        return newEntry;
      });

      const env = deriveEnv(services, entry.ports);
      const serviceSummaries = services.map((s) => ({
        name: s.name,
        container: containerName(stackCtx.worktreeKey, s.name),
        ports: Object.fromEntries(s.portNames.map((p) => [p, entry.ports[p]])),
      }));

      return {
        key: stackCtx.worktreeKey,
        path: entry.path,
        branch: entry.branch,
        ports: entry.ports,
        env,
        containers: entry.containers,
        network: entry.network,
        services: serviceSummaries,
      };
    },
  };
}
