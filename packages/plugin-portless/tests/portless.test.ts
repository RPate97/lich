import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process.spawn so we never shell out to a real portless binary.
// Each test queues one "spawn result" via setNextSpawn(); the mock pops from
// that queue and also records the args it was called with into spawnCalls.

interface FakeSpawnResult {
  stdout?: string;
  stderr?: string;
  // exitCode is what the 'close' event fires with. If errorCode is set, an
  // 'error' event fires *before* close (mirroring ENOENT behaviour where the
  // child process never starts).
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

      // Defer emitting events until after the caller has had a chance to
      // attach listeners, mirroring real spawn() behaviour.
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

import { portlessAdapter } from '../src/portless';

beforeEach(() => {
  spawnQueue.length = 0;
  spawnCalls.length = 0;
});

describe('portlessAdapter', () => {
  it('exposes the adapter name "portless"', () => {
    expect(portlessAdapter.name).toBe('portless');
  });

  describe('available()', () => {
    it('returns false when portless is not on PATH (spawn emits ENOENT)', async () => {
      setNextSpawn({ errorCode: 'ENOENT' });
      const ok = await portlessAdapter.available();
      expect(ok).toBe(false);
      expect(spawnCalls[0]).toMatchObject({ cmd: 'portless', args: ['--version'] });
    });

    it('returns true when `portless --version` exits 0', async () => {
      setNextSpawn({ exitCode: 0, stdout: 'portless 1.2.3\n' });
      const ok = await portlessAdapter.available();
      expect(ok).toBe(true);
    });

    it('returns false when `portless --version` exits non-zero', async () => {
      setNextSpawn({ exitCode: 1, stderr: 'broken\n' });
      const ok = await portlessAdapter.available();
      expect(ok).toBe(false);
    });
  });

  describe('register()', () => {
    it('shells out `portless register <host> <target>` on success', async () => {
      setNextSpawn({ exitCode: 0 });
      await portlessAdapter.register({
        host: 'app.example.test',
        target: 'http://127.0.0.1:3000',
      });
      expect(spawnCalls[0]).toEqual({
        cmd: 'portless',
        args: ['register', 'app.example.test', 'http://127.0.0.1:3000'],
      });
    });

    it('throws when portless exits non-zero, including stderr in the message', async () => {
      setNextSpawn({ exitCode: 2, stderr: 'host already registered\n' });
      await expect(
        portlessAdapter.register({ host: 'dup.test', target: 'http://127.0.0.1:3000' }),
      ).rejects.toThrow(/host already registered/);
    });

    it('throws when spawn itself errors (e.g. ENOENT)', async () => {
      setNextSpawn({ errorCode: 'ENOENT' });
      await expect(
        portlessAdapter.register({ host: 'x.test', target: 'http://127.0.0.1:3000' }),
      ).rejects.toThrow(/ENOENT|portless/);
    });
  });

  describe('unregister()', () => {
    it('shells out `portless unregister <host>` on success', async () => {
      setNextSpawn({ exitCode: 0 });
      await portlessAdapter.unregister('app.example.test');
      expect(spawnCalls[0]).toEqual({
        cmd: 'portless',
        args: ['unregister', 'app.example.test'],
      });
    });

    it('throws when portless exits non-zero', async () => {
      setNextSpawn({ exitCode: 1, stderr: 'no such host\n' });
      await expect(portlessAdapter.unregister('missing.test')).rejects.toThrow(/no such host/);
    });
  });

  describe('list()', () => {
    it('shells out `portless list --json` and parses an array of entries', async () => {
      const payload = [
        { host: 'app.example.test', target: 'http://127.0.0.1:3000' },
        { host: 'api.example.test', target: 'http://127.0.0.1:4000', service: 'backend' },
      ];
      setNextSpawn({ exitCode: 0, stdout: JSON.stringify(payload) });

      const entries = await portlessAdapter.list();
      expect(spawnCalls[0]).toEqual({ cmd: 'portless', args: ['list', '--json'] });
      expect(entries).toEqual(payload);
    });

    it('returns an empty array when portless prints an empty JSON array', async () => {
      setNextSpawn({ exitCode: 0, stdout: '[]\n' });
      const entries = await portlessAdapter.list();
      expect(entries).toEqual([]);
    });

    it('throws when portless exits non-zero', async () => {
      setNextSpawn({ exitCode: 1, stderr: 'cannot read state\n' });
      await expect(portlessAdapter.list()).rejects.toThrow(/cannot read state/);
    });

    it('throws when stdout is not valid JSON', async () => {
      setNextSpawn({ exitCode: 0, stdout: 'not json at all' });
      await expect(portlessAdapter.list()).rejects.toThrow();
    });
  });
});
