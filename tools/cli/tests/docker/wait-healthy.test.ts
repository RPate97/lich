import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dockerOrSkip } from '../_helpers/docker';
import { spawnSync } from 'node:child_process';
import { startDockerService, stopDockerService } from '../../src/docker/runner';
import { pgService } from '../../src/services/postgres';
import { containerName, volumeName } from '../../src/docker/naming';
import type { StackContext, RunningHandle } from '../../src/services/types';

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

const KEY = 'f0f0f0f0f0f0';
const CTX: StackContext = { worktreeKey: KEY, worktreePath: '/tmp/x', branch: 'main' };

function cleanup() {
  spawnSync('docker', ['rm', '-f', containerName(KEY, 'postgres')], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', volumeName(KEY, 'postgres')], { stdio: 'ignore' });
}

describeIfDocker('waitHealthy stability', () => {
  let handle: RunningHandle | undefined;

  beforeAll(cleanup);
  afterAll(() => {
    cleanup();
  });

  it('returns only after N consecutive successful polls so the next caller never races initdb', async () => {
    handle = await startDockerService(pgService, CTX, { postgres: 54930 }, { waitTimeoutMs: 60_000 });
    // Immediately after startDockerService returns, the next pg_isready MUST succeed.
    // (Without the N-consecutive-poll fix this is the race that makes tests flake.)
    // Run 5 back-to-back to give us a fair shot at catching any flap.
    for (let i = 0; i < 5; i++) {
      const r = spawnSync('docker', [
        'exec', handle.containerName,
        'pg_isready', '-U', 'levelzero', '-d', 'levelzero',
      ], { encoding: 'utf8' });
      expect(r.status).toBe(0);
    }
    await stopDockerService(handle);
    handle = undefined;
  }, 120_000);
});
