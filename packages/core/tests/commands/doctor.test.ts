import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock child_process.spawn so the doctor `docker-compose` check never shells
// out to real docker during tests. Each test queues one spawn result via
// setNextSpawn(); the mock pops from that queue and records the args via
// spawnCalls.

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
import { makeDoctorCommand } from '../../src/commands/doctor';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-doc-')));
  reg = new Registry(join(tmp, 'registry.json'));
  spawnQueue.length = 0;
  spawnCalls.length = 0;
});

describe('levelzero doctor', () => {
  it('reports no_project when not inside a project, with all infra checks ok', async () => {
    // docker compose available
    setNextSpawn({
      exitCode: 0,
      stdout: JSON.stringify({ version: 'v2.30.3' }),
    });
    // docker network ls → no levelzero networks
    setNextSpawn({ exitCode: 0, stdout: '' });
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(true);
    expect(result.checks.find((c: any) => c.id === 'project').status).toBe('skipped');
    expect(result.checks.find((c: any) => c.id === 'registry').status).toBe('ok');
  });

  it('includes a node-version check reporting the running Node (LEV-114)', async () => {
    setNextSpawn({
      exitCode: 0,
      stdout: JSON.stringify({ version: 'v2.30.3' }),
    });
    setNextSpawn({ exitCode: 0, stdout: '' });
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    const node = result.checks.find((c: any) => c.id === 'node');
    expect(node).toBeDefined();
    // The test runner itself runs on the floor (Node 20+) or vitest wouldn't
    // have started — so we expect a pass here, with the version surfaced.
    expect(node.status).toBe('ok');
    expect(node.version).toBe(process.versions.node);
  });

  it('reports project ok when inside a valid project', async () => {
    setNextSpawn({
      exitCode: 0,
      stdout: JSON.stringify({ version: 'v2.30.3' }),
    });
    setNextSpawn({ exitCode: 0, stdout: '' });
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(true);
    expect(result.checks.find((c: any) => c.id === 'project').status).toBe('ok');
    expect(result.checks.find((c: any) => c.id === 'config').status).toBe('ok');
  });

  it('reports config error when the config file is malformed', async () => {
    setNextSpawn({
      exitCode: 0,
      stdout: JSON.stringify({ version: 'v2.30.3' }),
    });
    setNextSpawn({ exitCode: 0, stdout: '' });
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export const foo = 1;');
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(false);
    const cfg = result.checks.find((c: any) => c.id === 'config');
    expect(cfg.status).toBe('error');
    expect(cfg.message).toMatch(/default export/i);
  });

  describe('docker-compose check', () => {
    it('reports ok with the parsed version when docker compose v2 is installed', async () => {
      setNextSpawn({
        exitCode: 0,
        stdout: JSON.stringify({ version: 'v2.30.3' }),
      });
      setNextSpawn({ exitCode: 0, stdout: '' });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;

      const dc = result.checks.find((c: any) => c.id === 'docker-compose');
      expect(dc).toBeDefined();
      expect(dc.status).toBe('ok');
      expect(dc.version).toBe('2.30.3');
      expect(result.ok).toBe(true);

      // Confirm we invoked exactly `docker compose version --format json`.
      expect(spawnCalls[0]).toMatchObject({
        cmd: 'docker',
        args: ['compose', 'version', '--format', 'json'],
      });
    });

    it('strips a leading "v" but tolerates a bare semver', async () => {
      setNextSpawn({
        exitCode: 0,
        stdout: JSON.stringify({ version: '2.29.0' }),
      });
      setNextSpawn({ exitCode: 0, stdout: '' });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;

      const dc = result.checks.find((c: any) => c.id === 'docker-compose');
      expect(dc.status).toBe('ok');
      expect(dc.version).toBe('2.29.0');
    });

    it('skips cleanly with a reason when docker itself is not on PATH', async () => {
      // Compose check fails with ENOENT; network check then also fires and
      // hits the same ENOENT (mock returns default-{exitCode:0} after the
      // queue empties, so we queue a second ENOENT explicitly).
      setNextSpawn({ errorCode: 'ENOENT' });
      setNextSpawn({ errorCode: 'ENOENT' });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;

      const dc = result.checks.find((c: any) => c.id === 'docker-compose');
      expect(dc.status).toBe('skipped');
      expect(dc.message).toMatch(/docker/i);
      // Skipping must not flip overall ok to false.
      expect(result.ok).toBe(true);
    });

    it('errors with an install hint when docker exists but the compose plugin is missing', async () => {
      setNextSpawn({
        exitCode: 1,
        stderr: "docker: 'compose' is not a docker command.\n",
      });
      setNextSpawn({ exitCode: 0, stdout: '' });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;

      const dc = result.checks.find((c: any) => c.id === 'docker-compose');
      expect(dc.status).toBe('error');
      expect(dc.message).toMatch(/docs\.docker\.com\/compose/i);
      expect(result.ok).toBe(false);
    });

    it('errors when docker compose returns unparseable output', async () => {
      setNextSpawn({
        exitCode: 0,
        stdout: 'not json at all',
      });
      setNextSpawn({ exitCode: 0, stdout: '' });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;

      const dc = result.checks.find((c: any) => c.id === 'docker-compose');
      expect(dc.status).toBe('error');
      expect(dc.message).toMatch(/parse|json/i);
      expect(result.ok).toBe(false);
    });
  });

  describe('levelzero-networks check (LEV-120)', () => {
    it('reports ok with the count when below the warn threshold', async () => {
      // docker compose ok
      setNextSpawn({ exitCode: 0, stdout: JSON.stringify({ version: 'v2.30.3' }) });
      // docker network ls → 3 networks
      setNextSpawn({
        exitCode: 0,
        stdout: 'levelzero-aaa111\nlevelzero-bbb222\nlevelzero-ccc333\n',
      });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;

      const nc = result.checks.find((c: any) => c.id === 'levelzero-networks');
      expect(nc).toBeDefined();
      expect(nc.status).toBe('ok');
      expect(nc.message).toMatch(/3 network/);
      expect(result.ok).toBe(true);

      // Second spawn must be the network-ls invocation.
      expect(spawnCalls[1]).toMatchObject({
        cmd: 'docker',
        args: ['network', 'ls', '--filter', 'name=levelzero-', '--format', '{{.Name}}'],
      });
    });

    it('warns (but does not fail overall) when more than 20 levelzero-* networks exist', async () => {
      setNextSpawn({ exitCode: 0, stdout: JSON.stringify({ version: 'v2.30.3' }) });
      // 25 networks → exceeds the 20 threshold
      const lines = Array.from({ length: 25 }, (_, i) => `levelzero-${i.toString(16).padStart(12, '0')}`);
      setNextSpawn({ exitCode: 0, stdout: lines.join('\n') + '\n' });

      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;

      const nc = result.checks.find((c: any) => c.id === 'levelzero-networks');
      expect(nc.status).toBe('warn');
      expect(nc.message).toMatch(/25.*address pool/i);
      expect(nc.message).toMatch(/stacks prune --all/);
      // Warnings must not poison the overall ok signal.
      expect(result.ok).toBe(true);
    });

    it('skips cleanly when docker is not on PATH', async () => {
      // compose check sees ENOENT
      setNextSpawn({ errorCode: 'ENOENT' });
      // network check sees ENOENT too
      setNextSpawn({ errorCode: 'ENOENT' });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
      const nc = result.checks.find((c: any) => c.id === 'levelzero-networks');
      expect(nc.status).toBe('skipped');
      expect(result.ok).toBe(true);
    });

    it('skips when `docker network ls` itself fails (daemon down)', async () => {
      setNextSpawn({ exitCode: 0, stdout: JSON.stringify({ version: 'v2.30.3' }) });
      setNextSpawn({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon\n' });
      const cmd = makeDoctorCommand(() => reg);
      const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
      const nc = result.checks.find((c: any) => c.id === 'levelzero-networks');
      expect(nc.status).toBe('skipped');
      expect(nc.message).toMatch(/docker network ls failed/);
    });

    it('renders a [WARN] marker in pretty output when warning', async () => {
      setNextSpawn({ exitCode: 0, stdout: JSON.stringify({ version: 'v2.30.3' }) });
      const lines = Array.from({ length: 25 }, (_, i) => `levelzero-${i.toString(16).padStart(12, '0')}`);
      setNextSpawn({ exitCode: 0, stdout: lines.join('\n') + '\n' });
      const cmd = makeDoctorCommand(() => reg);
      const out = (await cmd.run({ cwd: tmp, format: 'pretty', args: [], flags: {} })) as string;
      expect(out).toContain('[WARN] levelzero-networks');
      // Despite the warning the bottom line must still say `doctor: ok`.
      expect(out).toMatch(/doctor: ok/);
    });
  });
});
