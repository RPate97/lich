import concurrently, { type ConcurrentlyCommandInput } from 'concurrently';
import { ServiceLogWriter } from './log-writer';
import type { OwnedService, StackContext, PortMap } from '../services/types';

export interface RunnerOptions {
  logDir: string;
}

export interface RunnerHandle {
  pids: Record<string, number>;
  stop(): Promise<void>;
  done: Promise<{ exitCodes: Record<string, number> }>;
}

export function topologicalSort(services: OwnedService[]): OwnedService[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const visited = new Set<string>();
  const ordered: OwnedService[] = [];

  function visit(s: OwnedService, stack: string[]) {
    if (visited.has(s.name)) return;
    if (stack.includes(s.name)) {
      throw new Error(`cycle in dependsOn: ${[...stack, s.name].join(' -> ')}`);
    }
    for (const dep of s.dependsOn ?? []) {
      const depSvc = byName.get(dep);
      if (depSvc) visit(depSvc, [...stack, s.name]);
    }
    visited.add(s.name);
    ordered.push(s);
  }

  for (const s of services) visit(s, []);
  return ordered;
}

/**
 * Spawn every owned service via `concurrently`, ordered by `dependsOn`. Each
 * service inherits `process.env`, then layers `baseEnv` (shared across every
 * service — Plan 16 host-side cross-service vars like the legacy `DATABASE_URL`
 * derived from sibling docker services), then `serviceEnv[name]` (LEV-182:
 * pre-resolved per-service env from `resolveEnvForService({ context: 'host' })`
 * — explicit `envInjection` entries plus `importAll` payloads), then the
 * service's own legacy `envContributions(ports)`. Last layer wins, matching
 * `dev.ts`'s "explicit injection beats inherited stack env beats process env"
 * ordering.
 */
export async function runOwnedServices(
  services: OwnedService[],
  _ctx: StackContext,
  ports: PortMap,
  baseEnv: Record<string, string>,
  opts: RunnerOptions,
  serviceEnv: Record<string, Record<string, string>> = {},
): Promise<RunnerHandle> {
  if (services.length === 0) {
    return {
      pids: {},
      stop: async () => {},
      done: Promise.resolve({ exitCodes: {} }),
    };
  }

  const ordered = topologicalSort(services);

  const inputs: ConcurrentlyCommandInput[] = ordered.map((s) => ({
    name: s.name,
    command: s.command,
    cwd: s.cwd,
    env: {
      ...process.env,
      ...baseEnv,
      ...(serviceEnv[s.name] ?? {}),
      ...s.envContributions(ports),
    },
  }));

  const { result, commands } = concurrently(inputs, {
    killOthers: ['failure', 'success'],
    prefix: 'name',
    raw: false,
  });

  const writers: ServiceLogWriter[] = [];
  const pids: Record<string, number> = {};

  for (const cmd of commands) {
    const writer = new ServiceLogWriter({ service: cmd.name, logDir: opts.logDir });
    writers.push(writer);

    cmd.stdout.subscribe({
      next: (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        for (const line of text.split('\n').filter((l) => l.length > 0)) {
          void writer.appendLine('stdout', 'info', line);
        }
      },
    });
    cmd.stderr.subscribe({
      next: (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        for (const line of text.split('\n').filter((l) => l.length > 0)) {
          void writer.appendLine('stderr', 'error', line);
        }
      },
    });

    pids[cmd.name] = cmd.pid ?? Number.NaN;
    if (cmd.pid === undefined) {
      cmd.error.subscribe(() => {});
      setImmediate(() => {
        pids[cmd.name] = cmd.pid ?? Number.NaN;
      });
    }
  }

  const done = result.then(
    async (events) => {
      await Promise.all(writers.map((w) => w.close()));
      const exitCodes: Record<string, number> = {};
      for (const e of events) {
        exitCodes[e.command.name] =
          typeof e.exitCode === 'number' ? e.exitCode : e.exitCode ? Number(e.exitCode) : 0;
      }
      return { exitCodes };
    },
    async (events) => {
      await Promise.all(writers.map((w) => w.close()));
      const exitCodes: Record<string, number> = {};
      const arr = Array.isArray(events) ? events : [events];
      for (const e of arr) {
        if (e?.command?.name) {
          exitCodes[e.command.name] = typeof e.exitCode === 'number' ? e.exitCode : 1;
        }
      }
      for (const s of ordered) {
        if (!(s.name in exitCodes)) exitCodes[s.name] = 1;
      }
      return { exitCodes };
    },
  );

  const stop = async () => {
    for (const cmd of commands) {
      try {
        cmd.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    await new Promise((res) => setTimeout(res, 500));
    for (const cmd of commands) {
      try {
        cmd.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  };

  return { pids, stop, done };
}
