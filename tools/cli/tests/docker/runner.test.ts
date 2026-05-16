import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { dockerOrSkip } from '../_helpers/docker';
import {
  startDockerService,
  stopDockerService,
  removeServiceVolume,
  isContainerRunning,
} from '../../src/docker/runner';
import { pgService } from '../../src/services/postgres';
import { containerName, volumeName } from '../../src/docker/naming';
import type { StackContext, RunningHandle } from '../../src/services/types';
import { spawnSync } from 'node:child_process';

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

const KEY = 'a1b2c3d4e5f6';
const CTX: StackContext = { worktreeKey: KEY, worktreePath: '/tmp/x', branch: 'main' };

function cleanupAll() {
  spawnSync('docker', ['rm', '-f', containerName(KEY, 'postgres')], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', volumeName(KEY, 'postgres')], { stdio: 'ignore' });
}

describeIfDocker('DockerService runner (real docker)', () => {
  beforeAll(cleanupAll);
  afterEach(cleanupAll);

  let handle: RunningHandle | undefined;

  it('startDockerService creates a named container, maps the allocated port, waits for healthy', async () => {
    handle = await startDockerService(pgService, CTX, { postgres: 54920 }, { waitTimeoutMs: 60_000 });
    expect(handle.containerName).toBe(containerName(KEY, 'postgres'));
    expect(handle.ports.postgres).toBe(54920);
    expect(await isContainerRunning(handle.containerName)).toBe(true);

    const r = spawnSync('docker', [
      'exec', handle.containerName,
      'pg_isready', '-U', 'levelzero', '-d', 'levelzero',
    ], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  }, 90_000);

  it('stopDockerService removes the container; the volume persists', async () => {
    handle = await startDockerService(pgService, CTX, { postgres: 54921 }, { waitTimeoutMs: 60_000 });
    await stopDockerService(handle);
    expect(await isContainerRunning(handle.containerName)).toBe(false);
    const r = spawnSync('docker', ['volume', 'inspect', volumeName(KEY, 'postgres')], { stdio: 'pipe' });
    expect(r.status).toBe(0);
    handle = undefined;
  }, 90_000);

  it('removeServiceVolume drops the named volume', async () => {
    handle = await startDockerService(pgService, CTX, { postgres: 54922 }, { waitTimeoutMs: 60_000 });
    await stopDockerService(handle);
    await removeServiceVolume(pgService, CTX);
    const r = spawnSync('docker', ['volume', 'inspect', volumeName(KEY, 'postgres')], { stdio: 'pipe' });
    expect(r.status).not.toBe(0);
    handle = undefined;
  }, 90_000);
});
