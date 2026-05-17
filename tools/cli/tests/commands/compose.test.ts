import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../src/errors';
import { makeComposeCommand } from '../../src/commands/compose';

/**
 * Lightweight spawn double. Returns a fake ChildProcess that emits a close
 * event with the queued exit code on the next tick — matches real spawn()
 * semantics (events fire only after the caller has had a chance to attach
 * listeners) without forking an actual process.
 *
 * Each call appends to `spawnCalls` so tests can assert on what `docker
 * compose` was invoked with. `setNextExit` queues the next exit code so
 * tests can simulate compose failures.
 */
interface SpawnCall {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

function makeSpawnDouble() {
  const spawnCalls: SpawnCall[] = [];
  const exitQueue: number[] = [];
  const errorQueue: NodeJS.ErrnoException[] = [];

  const spawn = (cmd: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ cmd, args, options });
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: string) => boolean;
    };
    proc.stdout = Readable.from([]);
    proc.stderr = Readable.from([]);
    proc.kill = () => true;
    const err = errorQueue.shift();
    const exitCode = exitQueue.shift() ?? 0;
    setImmediate(() => {
      if (err) {
        proc.emit('error', err);
        return;
      }
      proc.emit('close', exitCode);
    });
    return proc;
  };

  return {
    spawn: spawn as unknown as typeof import('node:child_process').spawn,
    spawnCalls,
    queueExit(code: number) {
      exitQueue.push(code);
    },
    queueError(err: NodeJS.ErrnoException) {
      errorQueue.push(err);
    },
  };
}

let projectDir: string;
let composeFile: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-proj-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  mkdirSync(join(projectDir, '.levelzero'), { recursive: true });
  composeFile = join(projectDir, '.levelzero', 'docker-compose.yml');
  writeFileSync(composeFile, "version: '3'\nservices: {}\n");
});

describe('levelzero compose', () => {
  it('exports a Command named "compose"', () => {
    const { spawn } = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn });
    expect(cmd.name).toBe('compose');
    expect(typeof cmd.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const { spawn } = makeSpawnDouble();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-outside-')));
    const cmd = makeComposeCommand({ spawn });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('forwards `ps` to `docker compose -p levelzero-<key> -f <compose-file> ps`', async () => {
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['ps'],
      flags: {},
    })) as { exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(dbl.spawnCalls).toHaveLength(1);
    const call = dbl.spawnCalls[0]!;
    expect(call.cmd).toBe('docker');
    // First arg is 'compose', then -p <project>, -f <file>, then the user's
    // subcommand and args.
    expect(call.args[0]).toBe('compose');
    expect(call.args[1]).toBe('-p');
    expect(call.args[2]!.startsWith('levelzero-')).toBe(true);
    expect(call.args[3]).toBe('-f');
    expect(call.args[4]).toBe(composeFile);
    expect(call.args[5]).toBe('ps');
    expect(call.args).toHaveLength(6);
  });

  it('forwards trailing args transparently (e.g., `logs postgres`)', async () => {
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn });
    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['logs', 'postgres'],
      flags: {},
    });
    const call = dbl.spawnCalls[0]!;
    // Last two args should be the user's subcommand + arg, unchanged.
    expect(call.args.slice(-2)).toEqual(['logs', 'postgres']);
  });

  it('forwards multi-word args like `exec postgres psql -U levelzero` transparently', async () => {
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn });
    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['exec', 'postgres', 'psql', '-U', 'levelzero'],
      flags: {},
    });
    const call = dbl.spawnCalls[0]!;
    expect(call.args.slice(-5)).toEqual(['exec', 'postgres', 'psql', '-U', 'levelzero']);
  });

  it('uses stdio: "inherit" so compose output streams to the operator', async () => {
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn });
    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['ps'],
      flags: {},
    });
    const call = dbl.spawnCalls[0]!;
    expect(call.options.stdio).toBe('inherit');
  });

  it('propagates non-zero exit code from docker compose', async () => {
    const dbl = makeSpawnDouble();
    dbl.queueExit(2);
    const cmd = makeComposeCommand({ spawn: dbl.spawn });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['ps'],
      flags: {},
    })) as { exitCode: number };
    expect(result.exitCode).toBe(2);
  });

  it('requires a subcommand and errors CLIError when none is given', async () => {
    const { spawn } = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('errors with a clear hint when the compose file does not exist yet', async () => {
    const { spawn } = makeSpawnDouble();
    // Fresh project without a generated compose file.
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-fresh-')));
    writeFileSync(join(fresh, 'levelzero.config.ts'), 'export default {};');
    const cmd = makeComposeCommand({ spawn });
    await expect(
      cmd.run({ cwd: fresh, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(/dev|compose/i);
  });

  it('surfaces spawn errors (e.g., docker not on PATH) as CLIError', async () => {
    const dbl = makeSpawnDouble();
    const err = Object.assign(new Error('spawn docker ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    dbl.queueError(err);
    const cmd = makeComposeCommand({ spawn: dbl.spawn });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('uses the worktree key (12-char hex) for the project name suffix', async () => {
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn });
    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['ps'],
      flags: {},
    });
    const projectArg = dbl.spawnCalls[0]!.args[2]!;
    expect(projectArg).toMatch(/^levelzero-[a-f0-9]{12}$/);
  });
});
