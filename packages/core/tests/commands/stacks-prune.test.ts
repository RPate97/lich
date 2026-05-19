import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock child_process.spawn so the `--all` reap path never shells out to a
// real docker daemon. Each test queues spawn results via setNextSpawn();
// the mock pops from that queue and records the args via spawnCalls.
// Mirrors the pattern used by tests/commands/doctor.test.ts.

interface FakeSpawnResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorCode?: string;
}

interface SpawnCall {
  cmd: string;
  args: string[];
}

const spawnQueue: FakeSpawnResult[] = [];
const spawnCalls: SpawnCall[] = [];

function setNextSpawn(result: FakeSpawnResult): void {
  spawnQueue.push(result);
}

vi.mock('node:child_process', () => {
  return {
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      const next = spawnQueue.shift() ?? { exitCode: 0 };

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        kill: (signal?: string) => boolean;
      };
      proc.stdout = Readable.from([Buffer.from(next.stdout ?? '')]);
      proc.stderr = Readable.from([Buffer.from(next.stderr ?? '')]);
      proc.kill = () => true;

      setImmediate(() => {
        if (next.errorCode) {
          const err = Object.assign(new Error(`spawn ${cmd} ${next.errorCode}`), {
            code: next.errorCode,
          });
          proc.emit('error', err);
          return;
        }
        proc.emit('close', next.exitCode ?? 0);
      });

      return proc;
    },
  };
});

import { Registry } from '../../src/registry';
import { makeStacksPruneCommand } from '../../src/commands/stacks/prune';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-prune-')));
  reg = new Registry(join(tmp, 'registry.json'));
  spawnQueue.length = 0;
  spawnCalls.length = 0;
});

describe('levelzero stacks prune', () => {
  it('removes entries pointing at paths that no longer exist', async () => {
    const live = join(tmp, 'live');
    const dead = join(tmp, 'dead');
    mkdirSync(live);
    await reg.upsert('live', { path: live, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    await reg.upsert('dead', { path: dead, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    const cmd = makeStacksPruneCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.pruned).toEqual(['dead']);
    const after = await reg.list();
    expect(after.map(e => e.key)).toEqual(['live']);
  });

  it('returns an empty pruned array when all paths exist', async () => {
    const live = join(tmp, 'live');
    mkdirSync(live);
    await reg.upsert('live', { path: live, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    const cmd = makeStacksPruneCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.pruned).toEqual([]);
  });

  it('does not invoke docker without --all (default path stays offline)', async () => {
    const cmd = makeStacksPruneCommand(() => reg);
    await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    expect(spawnCalls).toEqual([]);
  });

  describe('--all (LEV-120)', () => {
    it('reaps every levelzero-* container and network on the host', async () => {
      // docker info → ok
      setNextSpawn({ exitCode: 0 });
      // docker ps -a --filter name=levelzero- → two containers
      setNextSpawn({ exitCode: 0, stdout: 'levelzero-abc123-postgres\nlevelzero-def456-redis\n' });
      // docker rm -f levelzero-abc123-postgres → ok
      setNextSpawn({ exitCode: 0 });
      // docker rm -f levelzero-def456-redis → ok
      setNextSpawn({ exitCode: 0 });
      // docker network ls → two networks
      setNextSpawn({ exitCode: 0, stdout: 'levelzero-abc123\nlevelzero-def456\n' });
      // docker network rm levelzero-abc123 → ok
      setNextSpawn({ exitCode: 0 });
      // docker network rm levelzero-def456 → ok
      setNextSpawn({ exitCode: 0 });

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as any;

      expect(result.pruned).toEqual([]);
      expect(result.containersRemoved).toEqual([
        'levelzero-abc123-postgres',
        'levelzero-def456-redis',
      ]);
      expect(result.networksRemoved).toEqual(['levelzero-abc123', 'levelzero-def456']);
      expect(result.volumesRemoved).toBeUndefined();
      expect(result.dockerSkipped).toBeUndefined();

      // First call must be `docker info`; container ps comes next.
      expect(spawnCalls[0]).toMatchObject({ cmd: 'docker', args: ['info'] });
      expect(spawnCalls[1]).toMatchObject({
        cmd: 'docker',
        args: ['ps', '-a', '--filter', 'name=levelzero-', '--format', '{{.Names}}'],
      });
    });

    it('also reaps named volumes when --volumes is set', async () => {
      // docker info → ok
      setNextSpawn({ exitCode: 0 });
      // docker ps → no containers
      setNextSpawn({ exitCode: 0, stdout: '' });
      // docker network ls → no networks
      setNextSpawn({ exitCode: 0, stdout: '' });
      // docker volume ls → one volume
      setNextSpawn({ exitCode: 0, stdout: 'levelzero-abc123-postgres-data\n' });
      // docker volume rm -f → ok
      setNextSpawn({ exitCode: 0 });

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({
        cwd: tmp,
        format: 'json',
        args: [],
        flags: { all: true, volumes: true },
      })) as any;

      expect(result.volumesRemoved).toEqual(['levelzero-abc123-postgres-data']);
      // Confirm the volume sub-command was actually issued.
      const volumeRmCall = spawnCalls.find(
        (c) => c.args[0] === 'volume' && c.args[1] === 'rm',
      );
      expect(volumeRmCall).toBeDefined();
    });

    it('still prunes stale registry entries when --all is set', async () => {
      const live = join(tmp, 'live');
      const dead = join(tmp, 'dead');
      mkdirSync(live);
      await reg.upsert('live', { path: live, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
      await reg.upsert('dead', { path: dead, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });

      // docker info → ok; nothing to sweep
      setNextSpawn({ exitCode: 0 });
      setNextSpawn({ exitCode: 0, stdout: '' });
      setNextSpawn({ exitCode: 0, stdout: '' });

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as any;
      expect(result.pruned).toEqual(['dead']);
      expect(result.containersRemoved).toEqual([]);
      expect(result.networksRemoved).toEqual([]);
    });

    it('skips the docker sweep gracefully when docker is not on PATH', async () => {
      // docker info → ENOENT
      setNextSpawn({ errorCode: 'ENOENT' });
      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as any;
      expect(result.dockerSkipped).toBe(true);
      expect(result.containersRemoved).toEqual([]);
      expect(result.networksRemoved).toEqual([]);
    });

    it('skips the docker sweep when `docker info` fails (daemon down)', async () => {
      // docker info → non-zero (daemon not reachable)
      setNextSpawn({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon\n' });
      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as any;
      expect(result.dockerSkipped).toBe(true);
      expect(result.containersRemoved).toEqual([]);
      expect(result.networksRemoved).toEqual([]);
    });

    it('continues sweeping when an individual network removal fails', async () => {
      // docker info → ok
      setNextSpawn({ exitCode: 0 });
      // ps -a → no containers
      setNextSpawn({ exitCode: 0, stdout: '' });
      // network ls → two networks
      setNextSpawn({ exitCode: 0, stdout: 'levelzero-aaa111\nlevelzero-bbb222\n' });
      // first rm fails (e.g. attached container we couldn't reap)
      setNextSpawn({ exitCode: 1, stderr: 'network has active endpoints' });
      // second rm succeeds
      setNextSpawn({ exitCode: 0 });

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as any;
      // Only the successful removal lands in the output.
      expect(result.networksRemoved).toEqual(['levelzero-bbb222']);
    });

    it('renders human-readable output with the reaped resources', async () => {
      setNextSpawn({ exitCode: 0 }); // info
      setNextSpawn({ exitCode: 0, stdout: 'levelzero-abc123-postgres\n' });
      setNextSpawn({ exitCode: 0 }); // rm container
      setNextSpawn({ exitCode: 0, stdout: 'levelzero-abc123\n' });
      setNextSpawn({ exitCode: 0 }); // network rm

      const cmd = makeStacksPruneCommand(() => reg);
      const out = (await cmd.run({ cwd: tmp, format: 'pretty', args: [], flags: { all: true } })) as string;
      expect(out).toContain('removed 1 stale container(s)');
      expect(out).toContain('levelzero-abc123-postgres');
      expect(out).toContain('removed 1 stale network(s)');
      expect(out).toContain('levelzero-abc123');
    });
  });
});
