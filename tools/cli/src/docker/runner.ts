import { containerName, volumeName } from './naming';
import { dockerExec } from './exec';
import type { DockerService, StackContext, RunningHandle, PortMap } from '../services/types';

export interface StartOptions {
  extraContainerEnv?: Record<string, string>;
  waitTimeoutMs?: number;
}

export function buildRunArgs(
  svc: DockerService,
  ctx: StackContext,
  ports: PortMap,
  opts: StartOptions = {},
): string[] {
  const cName = containerName(ctx.worktreeKey, svc.name);
  const args: string[] = ['run', '-d', '--name', cName];

  if (svc.volumeMountPath) {
    const vName = volumeName(ctx.worktreeKey, svc.name);
    args.push('-v', `${vName}:${svc.volumeMountPath}`);
  }

  if (svc.containerPortName && svc.containerPortInContainer !== undefined) {
    const hostPort = ports[svc.containerPortName];
    if (hostPort === undefined) {
      throw new Error(
        `port "${svc.containerPortName}" not allocated for service ${svc.name}; got ports ${JSON.stringify(ports)}`,
      );
    }
    args.push('-p', `127.0.0.1:${hostPort}:${svc.containerPortInContainer}`);
  }

  const env = { ...(svc.containerEnv ?? {}), ...(opts.extraContainerEnv ?? {}) };
  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`);
  }

  args.push(svc.image);
  return args;
}

export async function startDockerService(
  svc: DockerService,
  ctx: StackContext,
  ports: PortMap,
  opts: StartOptions = {},
): Promise<RunningHandle> {
  const cName = containerName(ctx.worktreeKey, svc.name);
  const args = buildRunArgs(svc, ctx, ports, opts);
  const r = await dockerExec(args, { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    throw new Error(
      `failed to start service ${svc.name}: docker ${args.join(' ')}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }

  if (svc.healthCommand) {
    await waitHealthy(svc, cName, opts.waitTimeoutMs ?? 60_000);
  }

  return { serviceName: svc.name, containerName: cName, ports };
}

async function waitHealthy(
  svc: DockerService,
  cName: string,
  timeoutMs: number,
): Promise<void> {
  if (!svc.healthCommand) return;
  const REQUIRED_CONSECUTIVE = 3;
  const POLL_INTERVAL_MS = 500;
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (true) {
    const r = await dockerExec(['exec', cName, ...svc.healthCommand], { timeoutMs: 5_000 });
    if (r.exitCode === 0) {
      consecutive++;
      if (consecutive >= REQUIRED_CONSECUTIVE) return;
    } else {
      consecutive = 0;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `service ${svc.name} did not become healthy within ${timeoutMs}ms (last stderr: ${r.stderr.trim()})`,
      );
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

export async function stopDockerService(handle: RunningHandle): Promise<void> {
  const r = await dockerExec(['rm', '-f', handle.containerName], { timeoutMs: 30_000 });
  if (r.exitCode !== 0 && !r.stderr.includes('No such container')) {
    throw new Error(`failed to stop ${handle.containerName}: ${r.stderr.trim()}`);
  }
}

export async function removeServiceVolume(svc: DockerService, ctx: StackContext): Promise<void> {
  if (!svc.volumeMountPath) return;
  const vName = volumeName(ctx.worktreeKey, svc.name);
  const r = await dockerExec(['volume', 'rm', '-f', vName], { timeoutMs: 10_000 });
  if (r.exitCode !== 0 && !r.stderr.includes('No such volume')) {
    throw new Error(`failed to remove volume ${vName}: ${r.stderr.trim()}`);
  }
}

export async function isContainerRunning(name: string): Promise<boolean> {
  const r = await dockerExec(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 5_000 });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}
