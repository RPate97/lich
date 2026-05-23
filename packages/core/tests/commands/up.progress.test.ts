/**
 * LEV-217 — `lich dev` per-phase progress UX integration tests.
 *
 * Companion to `dev.test.ts` / `dev.detached.test.ts`. Where those pin
 * behavior of the compose runner and the detached-spawn pipeline, this
 * file pins the *narration*: the dev command should call
 * `reporter.group(...)` with predictable labels for each meaningful
 * phase, and `--json` mode must produce zero stderr noise from progress.
 *
 * The reporter under test is a spy that records every call without doing
 * any actual IO — that keeps the assertion shape tight and lets us run
 * without a TTY (vitest workers don't have one).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeUpCommand } from '../../src/commands/up';
import { pgService } from '@lich/plugin-postgres';
import type { ComposeRunner } from '../../src/compose/runner';
import type { OwnedService, Service } from '../../src/services/types';
import type { ProgressReporter, Step } from '../../src/ui/progress';

function makeMockComposeFactory() {
  const factory = (_projectName: string, _composeFile: string): ComposeRunner => ({
    async up() {},
    async down() {},
    async ps() {
      return [];
    },
    async logs() {
      return '';
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  return { factory };
}

/**
 * Recording reporter — captures the label every `step()`/`group()` call
 * used, plus per-step `start`/`succeed`/`fail` invocations. The dev
 * command uses `group` exclusively today; the `step` recorder is there in
 * case a future refactor switches to the explicit start/succeed pattern.
 */
function makeRecordingReporter(): {
  reporter: ProgressReporter;
  groups: Array<{ label: string; outcome: 'pending' | 'ok' | 'fail' }>;
  steps: Array<{ label: string; state: 'start' | 'succeed' | 'fail' }>;
  shutdowns: number;
} {
  const groups: Array<{ label: string; outcome: 'pending' | 'ok' | 'fail' }> = [];
  const steps: Array<{ label: string; state: 'start' | 'succeed' | 'fail' }> = [];
  let shutdowns = 0;

  const makeStep = (label: string): Step => ({
    start() {
      steps.push({ label, state: 'start' });
    },
    succeed() {
      steps.push({ label, state: 'succeed' });
    },
    fail() {
      steps.push({ label, state: 'fail' });
    },
    update() {},
  });

  const reporter: ProgressReporter = {
    step(label) {
      return makeStep(label);
    },
    async group(label, fn) {
      const entry = { label, outcome: 'pending' as 'pending' | 'ok' | 'fail' };
      groups.push(entry);
      const s = makeStep(label);
      s.start();
      try {
        const r = await fn(s);
        s.succeed();
        entry.outcome = 'ok';
        return r;
      } catch (err) {
        s.fail();
        entry.outcome = 'fail';
        throw err;
      }
    },
    shutdown() {
      shutdowns++;
    },
  };

  return { reporter, groups, steps, shutdowns };
}

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-progress-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-progress-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('dev — per-phase progress narration (LEV-217)', () => {
  it('reports "Bringing up containers" when docker services are present', async () => {
    const { reporter, groups } = makeRecordingReporter();
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [pgService],
      composeRunnerFactory: factory,
    });

    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
      reporter,
    });

    const labels = groups.map((g) => g.label);
    expect(labels.some((l) => l.startsWith('Bringing up containers'))).toBe(true);
    // The matching group's label includes the service name list — matters
    // because a user with several compose services should see "postgres,
    // redis" not an opaque "Bringing up containers".
    const bringup = groups.find((g) => g.label.startsWith('Bringing up containers'))!;
    expect(bringup.label).toContain('postgres');
    expect(bringup.outcome).toBe('ok');
  });

  it('reports "Starting owned service(s)" with names for detached spawn', async () => {
    const echoer: OwnedService = {
      name: 'echoer',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo hi"',
      envContributions: () => ({}),
    };
    const { reporter, groups } = makeRecordingReporter();
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [echoer],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 100,
    });

    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
      reporter,
    });

    const labels = groups.map((g) => g.label);
    expect(labels.some((l) => l.startsWith('Starting owned service'))).toBe(true);
    const starter = groups.find((g) => g.label.startsWith('Starting owned service'))!;
    expect(starter.label).toContain('echoer');
    expect(starter.outcome).toBe('ok');
  });

  it('skips "Bringing up containers" when no compose services exist', async () => {
    const echoer: OwnedService = {
      name: 'echoer',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo hi"',
      envContributions: () => ({}),
    };
    const { reporter, groups } = makeRecordingReporter();
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [echoer],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 100,
    });

    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
      reporter,
    });

    // No compose services → the bringup phase is omitted entirely (rather
    // than emitting a spinner that completes instantly with nothing to
    // do).
    expect(
      groups.find((g) => g.label.startsWith('Bringing up containers')),
    ).toBeUndefined();
  });

  it('marks the "Bringing up containers" group as failed when compose up throws', async () => {
    const flakyFactory = (_p: string, _f: string): ComposeRunner => ({
      async up() {
        throw new Error('docker daemon not running');
      },
      async down() {},
      async ps() {
        return [];
      },
      async logs() {
        return '';
      },
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const { reporter, groups } = makeRecordingReporter();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [pgService],
      composeRunnerFactory: flakyFactory,
    });

    await expect(
      cmd.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: {},
        reporter,
      }),
    ).rejects.toThrow(/docker daemon not running/);

    const bringup = groups.find((g) => g.label.startsWith('Bringing up containers'));
    expect(bringup?.outcome).toBe('fail');
  });

  it('falls back to a silent reporter when ctx.reporter is omitted (test back-compat)', async () => {
    // Sanity test: existing tests construct CommandContext without a
    // reporter. The dev command must not crash on `ctx.reporter` being
    // undefined.
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [pgService],
      composeRunnerFactory: factory,
    });
    await expect(
      cmd.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: {},
      }),
    ).resolves.toBeDefined();
  });

  it('preserves the structured result shape — progress is purely additive', async () => {
    const { reporter } = makeRecordingReporter();
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [pgService],
      composeRunnerFactory: factory,
    });

    const withReporter = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
      reporter,
    })) as Record<string, unknown>;

    // Wipe + recreate registry so the second run starts clean.
    registry = new Registry(join(homeDir, 'registry2.json'));
    const cmd2 = makeUpCommand(() => registry, {
      getServices: (): Service[] => [pgService],
      composeRunnerFactory: factory,
    });
    const withoutReporter = (await cmd2.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as Record<string, unknown>;

    // Both runs should produce equivalent shapes (ignoring port numbers
    // and absolute paths which depend on the registry instance + tmpdir).
    expect(Object.keys(withReporter).sort()).toEqual(
      Object.keys(withoutReporter).sort(),
    );
    expect(withReporter['compose']).toEqual(withoutReporter['compose']);
  });
});

describe('runCli wires the reporter from --json into silent mode', () => {
  it('passes a silent reporter to the command when format=json', async () => {
    // We exercise the same path runCli takes by importing it directly and
    // using a probe command that captures ctx.reporter for inspection.
    const { runCli } = await import('../../src/cli');
    const { CommandRegistry } = await import('../../src/commands/registry');
    const capturedReporters: ProgressReporter[] = [];
    const cli = new CommandRegistry();
    cli.register({
      name: 'probe',
      describe: 'capture reporter',
      async run(ctx) {
        capturedReporters.push(ctx.reporter!);
        // Exercise the reporter; in silent mode this should be a no-op
        // and produce no stderr noise.
        await ctx.reporter!.group('inner', async () => 'ok');
        return { ok: true };
      },
    });

    const res = await runCli(['probe', '--json'], cli, { cwd: process.cwd() });
    expect(res.exitCode).toBe(0);
    expect(capturedReporters).toHaveLength(1);
    // The silent reporter's shutdown is a no-op, but we still call it —
    // assert by invoking and confirming no throw.
    expect(() => capturedReporters[0]!.shutdown()).not.toThrow();
  });

  it('passes a plain reporter when not --json and stream is not a TTY', async () => {
    const { runCli } = await import('../../src/cli');
    const { CommandRegistry } = await import('../../src/commands/registry');
    const sawGroupOutput = vi.fn();
    const cli = new CommandRegistry();
    cli.register({
      name: 'probe',
      describe: 'capture reporter',
      async run(ctx) {
        // Plain reporter writes to stderr — we can't intercept it through
        // runCli's return, but we can confirm the reporter exists and
        // exercises the group path without throwing.
        await ctx.reporter!.group('phase', async () => {
          sawGroupOutput();
        });
        return 'pretty-output';
      },
    });

    const res = await runCli(['probe'], cli, { cwd: process.cwd() });
    expect(res.exitCode).toBe(0);
    expect(sawGroupOutput).toHaveBeenCalled();
    // stdout shape unchanged — the command's string is what comes back.
    expect(res.stdout).toBe('pretty-output');
  });
});
