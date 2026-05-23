import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
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

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return {
    ...actual,
    spawn: (cmd: string, args: string[] | Record<string, unknown>, opts?: unknown) => {
      // Only intercept calls intended for the docker shell-out. Any other
      // spawn (e.g. the LEV-201 tests spawning a long-lived helper to assert
      // real signal delivery) falls through to the actual implementation so
      // the test gets a real OS pid.
      if (cmd !== 'docker') {
        return (actual.spawn as unknown as (
          ...a: unknown[]
        ) => unknown)(cmd, args as never, opts as never);
      }
      const argList = args as string[];
      spawnCalls.push({ cmd, args: argList });
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
import { spawn as testSpawn } from 'node:child_process';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-prune-')));
  reg = new Registry(join(tmp, 'registry.json'));
  spawnQueue.length = 0;
  spawnCalls.length = 0;
});

describe('lich stacks prune', () => {
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
    it('reaps every lich-* container and network on the host', async () => {
      // docker info → ok
      setNextSpawn({ exitCode: 0 });
      // docker ps -a --filter name=lich- → two containers
      setNextSpawn({ exitCode: 0, stdout: 'lich-abc123-postgres\nlich-def456-redis\n' });
      // docker rm -f lich-abc123-postgres → ok
      setNextSpawn({ exitCode: 0 });
      // docker rm -f lich-def456-redis → ok
      setNextSpawn({ exitCode: 0 });
      // docker network ls → two networks
      setNextSpawn({ exitCode: 0, stdout: 'lich-abc123\nlich-def456\n' });
      // docker network rm lich-abc123 → ok
      setNextSpawn({ exitCode: 0 });
      // docker network rm lich-def456 → ok
      setNextSpawn({ exitCode: 0 });

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as any;

      expect(result.pruned).toEqual([]);
      expect(result.containersRemoved).toEqual([
        'lich-abc123-postgres',
        'lich-def456-redis',
      ]);
      expect(result.networksRemoved).toEqual(['lich-abc123', 'lich-def456']);
      expect(result.volumesRemoved).toBeUndefined();
      expect(result.dockerSkipped).toBeUndefined();

      // First call must be `docker info`; container ps comes next.
      expect(spawnCalls[0]).toMatchObject({ cmd: 'docker', args: ['info'] });
      expect(spawnCalls[1]).toMatchObject({
        cmd: 'docker',
        args: ['ps', '-a', '--filter', 'name=lich-', '--format', '{{.Names}}'],
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
      setNextSpawn({ exitCode: 0, stdout: 'lich-abc123-postgres-data\n' });
      // docker volume rm -f → ok
      setNextSpawn({ exitCode: 0 });

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({
        cwd: tmp,
        format: 'json',
        args: [],
        flags: { all: true, volumes: true },
      })) as any;

      expect(result.volumesRemoved).toEqual(['lich-abc123-postgres-data']);
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
      setNextSpawn({ exitCode: 0, stdout: 'lich-aaa111\nlich-bbb222\n' });
      // first rm fails (e.g. attached container we couldn't reap)
      setNextSpawn({ exitCode: 1, stderr: 'network has active endpoints' });
      // second rm succeeds
      setNextSpawn({ exitCode: 0 });

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: { all: true } })) as any;
      // Only the successful removal lands in the output.
      expect(result.networksRemoved).toEqual(['lich-bbb222']);
    });

    it('renders human-readable output with the reaped resources', async () => {
      setNextSpawn({ exitCode: 0 }); // info
      setNextSpawn({ exitCode: 0, stdout: 'lich-abc123-postgres\n' });
      setNextSpawn({ exitCode: 0 }); // rm container
      setNextSpawn({ exitCode: 0, stdout: 'lich-abc123\n' });
      setNextSpawn({ exitCode: 0 }); // network rm

      const cmd = makeStacksPruneCommand(() => reg);
      const out = (await cmd.run({ cwd: tmp, format: 'pretty', args: [], flags: { all: true } })) as string;
      expect(out).toContain('removed 1 stale container(s)');
      expect(out).toContain('lich-abc123-postgres');
      expect(out).toContain('removed 1 stale network(s)');
      expect(out).toContain('lich-abc123');
    });
  });

  describe('--all reaps orphan owned-service pid files (LEV-201)', () => {
    /**
     * Stage a pid file under `<worktree>/.lich/state/<key>/pids/<service>.pid`.
     * Mirrors what `runOwnedServicesDetached` writes after spawn so the prune
     * code is exercised against the exact on-disk shape `dev` produces.
     */
    function writePid(
      worktreePath: string,
      worktreeKey: string,
      service: string,
      pid: number | string,
    ): string {
      const dir = join(worktreePath, '.lich', 'state', worktreeKey, 'pids');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${service}.pid`);
      writeFileSync(path, `${pid}\n`, 'utf8');
      return path;
    }

    // Pre-seed the docker mock with "nothing to sweep" responses so the
    // --all path falls straight through the container/network sweep and we
    // can focus on pid-file behavior.
    function stubDockerEmpty(): void {
      setNextSpawn({ exitCode: 0 }); // docker info
      setNextSpawn({ exitCode: 0, stdout: '' }); // ps -a
      setNextSpawn({ exitCode: 0, stdout: '' }); // network ls
    }

    it('removes pid files for dead pids and leaves alive processes alone without --force', async () => {
      const live = join(tmp, 'live');
      mkdirSync(live);
      await reg.upsert('live', {
        path: live,
        branch: '',
        ports: {},
        urls: {},
        containers: [],
        network: '',
        logDir: '',
        createdAt: '',
      });

      // Alive: the test runner itself.
      const alivePath = writePid(live, 'live', 'api', process.pid);
      // Dead: a pid that hasn't been allocated. Vitest spawns workers, so use
      // a pid that's vanishingly unlikely to exist on any UNIX (32-bit max).
      const deadPath = writePid(live, 'live', 'web', 2147483646);
      // Invalid: empty file.
      const invalidPath = writePid(live, 'live', 'worker', '');

      stubDockerEmpty();

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({
        cwd: tmp,
        format: 'json',
        args: [],
        flags: { all: true },
      })) as any;

      const byService = new Map<string, any>(
        result.reapedProcesses.map((r: any) => [r.service, r]),
      );
      expect(byService.get('web')?.result).toBe('stale');
      expect(byService.get('worker')?.result).toBe('invalid');
      expect(byService.get('api')?.result).toBe('skipped');

      // Dead/invalid pid files removed; alive pid file preserved.
      expect(existsSync(deadPath)).toBe(false);
      expect(existsSync(invalidPath)).toBe(false);
      expect(existsSync(alivePath)).toBe(true);
    });

    it('kills alive processes when --force is set and the worktree still exists', async () => {
      const live = join(tmp, 'live');
      mkdirSync(live);
      await reg.upsert('live', {
        path: live,
        branch: '',
        ports: {},
        urls: {},
        containers: [],
        network: '',
        logDir: '',
        createdAt: '',
      });

      // Spawn a real child that we can probe + kill. The mock falls through
      // to the actual spawn for any non-docker command, so this hits the
      // real OS and gives us a real pid for `process.kill` to land on.
      const child = testSpawn(
        process.execPath,
        ['-e', 'setInterval(()=>{}, 1000)'],
        { stdio: 'ignore' },
      );
      try {
        // Wait for the child to actually have a pid.
        await new Promise<void>((resolve, reject) => {
          if (typeof child.pid === 'number') return resolve();
          child.once('spawn', () => resolve());
          child.once('error', reject);
        });
        const childPid = child.pid!;
        const pidFile = writePid(live, 'live', 'api', childPid);

        stubDockerEmpty();

        const cmd = makeStacksPruneCommand(() => reg);
        const result = (await cmd.run({
          cwd: tmp,
          format: 'json',
          args: [],
          flags: { all: true, force: true },
        })) as any;

        const api = result.reapedProcesses.find((r: any) => r.service === 'api');
        expect(api).toBeDefined();
        expect(['terminated', 'killed']).toContain(api.result);
        expect(api.pid).toBe(childPid);
        expect(existsSync(pidFile)).toBe(false);

        // Confirm the child is actually dead.
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('exit', () => resolve());
          // Backstop: if for some reason we missed exit, resolve after 1s.
          setTimeout(() => resolve(), 1000);
        });
        let stillAlive = true;
        try {
          process.kill(childPid, 0);
        } catch {
          stillAlive = false;
        }
        expect(stillAlive).toBe(false);
      } finally {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    });

    it('reaps pid files in ghost worktrees that no longer exist', async () => {
      // Ghost: a worktree whose directory we'll delete BEFORE running prune,
      // simulating `git worktree remove` having yanked the path. The registry
      // entry's `path` won't pathExists; the standard prune logic should drop
      // the entry. Because the pid dir lives inside the worktree, it's also
      // gone — so the reap loop has nothing to read for this key. The test
      // asserts that the prune path doesn't crash on this case and that the
      // entry is in `pruned`.
      const ghost = join(tmp, 'ghost');
      mkdirSync(ghost);
      // Stage a pid file inside the ghost worktree first…
      writePid(ghost, 'ghost', 'api', 2147483646);
      await reg.upsert('ghost', {
        path: ghost,
        branch: '',
        ports: {},
        urls: {},
        containers: [],
        network: '',
        logDir: '',
        createdAt: '',
      });
      // …then nuke the worktree directory to simulate a stale registry entry.
      const { rmSync } = await import('node:fs');
      rmSync(ghost, { recursive: true, force: true });

      stubDockerEmpty();

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({
        cwd: tmp,
        format: 'json',
        args: [],
        flags: { all: true },
      })) as any;

      expect(result.pruned).toEqual(['ghost']);
      // The pid dir was inside the worktree we just deleted, so no entries
      // are produced for it. The reap path must NOT throw.
      const ghostEntries = result.reapedProcesses.filter(
        (r: any) => r.worktreeKey === 'ghost',
      );
      expect(ghostEntries).toEqual([]);
    });

    it('does not signal foreign pids (EPERM) and leaves their pid files in place', async () => {
      // PID 1 (init/launchd) exists on every UNIX but isn't ours — sending a
      // signal returns EPERM. The reap path must classify this as `foreign`,
      // not `alive`, and refuse to either kill it or delete the marker.
      const live = join(tmp, 'live');
      mkdirSync(live);
      await reg.upsert('live', {
        path: live,
        branch: '',
        ports: {},
        urls: {},
        containers: [],
        network: '',
        logDir: '',
        createdAt: '',
      });
      const pidFile = writePid(live, 'live', 'api', 1);

      stubDockerEmpty();

      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({
        cwd: tmp,
        format: 'json',
        args: [],
        flags: { all: true, force: true },
      })) as any;

      const api = result.reapedProcesses.find((r: any) => r.service === 'api');
      // Either 'foreign' (EPERM — pid 1 not ours) or, when the test runs as
      // root, 'terminated'/'killed'. Vitest CI never runs as root so the
      // common path is 'foreign'.
      if (process.getuid && process.getuid() === 0) {
        // Test environment is root — pid 1 IS reachable. We don't actually
        // want to kill init in that case. Skip the assertion safely.
        expect(api).toBeDefined();
      } else {
        expect(api?.result).toBe('foreign');
        // Pid file preserved because we can't prove it's safe to delete.
        expect(existsSync(pidFile)).toBe(true);
      }
    });

    it('includes reapedProcesses in JSON output even when no pids exist', async () => {
      stubDockerEmpty();
      const cmd = makeStacksPruneCommand(() => reg);
      const result = (await cmd.run({
        cwd: tmp,
        format: 'json',
        args: [],
        flags: { all: true },
      })) as any;
      expect(result.reapedProcesses).toEqual([]);
    });

    it('renders reaped pid files in pretty output', async () => {
      const live = join(tmp, 'live');
      mkdirSync(live);
      await reg.upsert('live', {
        path: live,
        branch: '',
        ports: {},
        urls: {},
        containers: [],
        network: '',
        logDir: '',
        createdAt: '',
      });
      writePid(live, 'live', 'web', 2147483646); // dead

      stubDockerEmpty();

      const cmd = makeStacksPruneCommand(() => reg);
      const out = (await cmd.run({
        cwd: tmp,
        format: 'pretty',
        args: [],
        flags: { all: true },
      })) as string;
      expect(out).toContain('reaped 1 orphan owned-service pid file(s)');
      expect(out).toContain('live/web');
      expect(out).toContain('stale');
    });

    it('mentions --force in the pretty output when alive processes are skipped', async () => {
      const live = join(tmp, 'live');
      mkdirSync(live);
      await reg.upsert('live', {
        path: live,
        branch: '',
        ports: {},
        urls: {},
        containers: [],
        network: '',
        logDir: '',
        createdAt: '',
      });
      writePid(live, 'live', 'api', process.pid);

      stubDockerEmpty();

      const cmd = makeStacksPruneCommand(() => reg);
      const out = (await cmd.run({
        cwd: tmp,
        format: 'pretty',
        args: [],
        flags: { all: true },
      })) as string;
      expect(out).toContain('--force');
      expect(out).toContain('live/api');
    });
  });
});
