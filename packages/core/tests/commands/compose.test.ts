import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../src/errors';
import { makeComposeCommand } from '../../src/commands/compose';
import { Registry, type StackEntry } from '../../src/registry';
import { computeWorktreeKey } from '../../src/worktree';

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
let registry: Registry;
let registryPath: string;
let worktreeKey: string;

/**
 * Seed a registry entry mirroring what `dev` writes — most importantly,
 * `composeFile` set to the actual on-disk file path so the passthrough finds
 * it. The path lives under the per-worktree subdir (`.lich/<key>/…`),
 * matching what `buildComposeBundle` produces post-LEV-208.
 */
function seedRegistryEntry(overrides: Partial<StackEntry> = {}): Promise<void> {
  const entry: StackEntry = {
    path: projectDir,
    branch: 'main',
    ports: {},
    urls: {},
    containers: [],
    network: `lich-${worktreeKey}`,
    logDir: '.lich/logs',
    createdAt: new Date().toISOString(),
    composeFile,
    ...overrides,
  };
  return registry.upsert(worktreeKey, entry);
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-proj-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  worktreeKey = computeWorktreeKey(projectDir);
  // Compose file lives under the per-worktree subdir, matching what `dev`
  // writes (LEV-208 — passthrough reads `entry.composeFile` from the
  // registry, so this is the path that has to be on disk).
  const composeDir = join(projectDir, '.lich', worktreeKey);
  mkdirSync(composeDir, { recursive: true });
  composeFile = join(composeDir, 'docker-compose.yml');
  writeFileSync(composeFile, "version: '3'\nservices: {}\n");

  // Per-test registry isolated to a tempdir — no risk of leaking entries
  // between tests or polluting the dev user's `~/.lich/registry.json`.
  const regDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-reg-')));
  registryPath = join(regDir, 'registry.json');
  registry = new Registry(registryPath);
});

describe('lich compose', () => {
  it('exports a Command named "compose"', () => {
    const { spawn } = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn, getRegistry: () => registry });
    expect(cmd.name).toBe('compose');
    expect(typeof cmd.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a lich project', async () => {
    const { spawn } = makeSpawnDouble();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-outside-')));
    const cmd = makeComposeCommand({ spawn, getRegistry: () => registry });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('forwards `ps` to `docker compose -p lich-<key> -f <compose-file> ps`', async () => {
    await seedRegistryEntry();
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
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
    expect(call.args[2]!.startsWith('lich-')).toBe(true);
    expect(call.args[3]).toBe('-f');
    expect(call.args[4]).toBe(composeFile);
    expect(call.args[5]).toBe('ps');
    expect(call.args).toHaveLength(6);
  });

  it('reads the compose file path from the registry entry, not a hardcoded subpath (LEV-208)', async () => {
    // Place the compose file at a NON-default location and record that path
    // in the registry. The passthrough must follow what the registry says,
    // not where it guesses the file might live.
    const customDir = join(projectDir, '.lich', 'custom-location');
    mkdirSync(customDir, { recursive: true });
    const customComposeFile = join(customDir, 'docker-compose.yml');
    writeFileSync(customComposeFile, "version: '3'\nservices: {}\n");
    await seedRegistryEntry({ composeFile: customComposeFile });

    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
    await cmd.run({ cwd: projectDir, format: 'json', args: ['ps'], flags: {} });
    expect(dbl.spawnCalls[0]!.args[4]).toBe(customComposeFile);
  });

  it('forwards trailing args transparently (e.g., `logs postgres`)', async () => {
    await seedRegistryEntry();
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
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

  it('forwards multi-word args like `exec postgres psql -U lich` transparently', async () => {
    await seedRegistryEntry();
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['exec', 'postgres', 'psql', '-U', 'lich'],
      flags: {},
    });
    const call = dbl.spawnCalls[0]!;
    expect(call.args.slice(-5)).toEqual(['exec', 'postgres', 'psql', '-U', 'lich']);
  });

  it('uses stdio: "inherit" so compose output streams to the operator', async () => {
    await seedRegistryEntry();
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
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
    await seedRegistryEntry();
    const dbl = makeSpawnDouble();
    dbl.queueExit(2);
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
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
    const cmd = makeComposeCommand({ spawn, getRegistry: () => registry });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('errors with a clear hint when no registry entry exists yet (stack not running)', async () => {
    const { spawn } = makeSpawnDouble();
    // Fresh project without ever calling `dev` — no registry entry.
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-fresh-')));
    writeFileSync(join(fresh, 'lich.config.ts'), 'export default {};');
    const cmd = makeComposeCommand({ spawn, getRegistry: () => registry });
    await expect(
      cmd.run({ cwd: fresh, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(/dev|compose|stack/i);
  });

  it('errors when the registry entry points at a missing file', async () => {
    // Entry recorded but the file was deleted out from under us — surface
    // a NO_PROJECT with a hint to re-run `dev`.
    const missing = join(projectDir, '.lich', worktreeKey, 'gone.yml');
    await seedRegistryEntry({ composeFile: missing });
    const { spawn } = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn, getRegistry: () => registry });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(/no compose file|dev/i);
  });

  it('errors for legacy registry entries with an empty composeFile', async () => {
    // Pre-LEV-208 registry entries written without `composeFile` get `''`
    // from the read path. Treat that as "stack not running from this
    // command's perspective" — operator re-runs `dev` to refresh.
    await seedRegistryEntry({ composeFile: '' });
    const { spawn } = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn, getRegistry: () => registry });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(/dev|stack/i);
  });

  it('surfaces spawn errors (e.g., docker not on PATH) as CLIError', async () => {
    await seedRegistryEntry();
    const dbl = makeSpawnDouble();
    const err = Object.assign(new Error('spawn docker ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    dbl.queueError(err);
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['ps'], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('uses the worktree key (12-char hex) for the project name suffix', async () => {
    await seedRegistryEntry();
    const dbl = makeSpawnDouble();
    const cmd = makeComposeCommand({ spawn: dbl.spawn, getRegistry: () => registry });
    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['ps'],
      flags: {},
    });
    const projectArg = dbl.spawnCalls[0]!.args[2]!;
    expect(projectArg).toMatch(/^lich-[a-f0-9]{12}$/);
  });
});
