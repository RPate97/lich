/**
 * LEV-194 — default detached `lich dev` path.
 * LEV-245 — detached runner writes structured JSONL (not raw .log).
 *
 * Companion to dev.test.ts and dev.owned.test.ts. Where those exercise the
 * `--live` foreground runner (today's behavior), this file pins the detached
 * behavior: spawn unrefs the children, pid files land under
 * `.lich/state/<key>/pids/`, and the per-service `.jsonl` file under
 * `.lich/state/<key>/logs/` accumulates structured JSONL records.
 *
 * Each test spawns a real `sh` child via `runOwnedServicesDetached` so the
 * detached / unref / pipe semantics are exercised end-to-end. A mock
 * compose runner keeps docker out of the loop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  realpathSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeUpCommand } from '../../src/commands/up';
import { CLIError } from '../../src/errors';
import { runCli } from '../../src/cli';
import { CommandRegistry } from '../../src/commands/registry';
import type { ComposeRunner } from '../../src/compose/runner';
import type { OwnedService, Service } from '../../src/services/types';

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

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-det-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-det-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

/**
 * Wait until a predicate returns true or a budget expires. Used in detached
 * tests to give the freshly-spawned child a beat to write to its log file —
 * `runOwnedServicesDetached` returns as soon as `spawn` returns the pid, not
 * when the child has produced output.
 */
async function waitFor(
  predicate: () => boolean,
  budgetMs = 3000,
  stepMs = 50,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('lich up (default detached, LEV-194)', () => {
  it('writes a pid file and structured JSONL log for each owned service (LEV-245)', async () => {
    const echoer: OwnedService = {
      name: 'echoer',
      kind: 'owned',
      portNames: [], // no probe -> readiness 'skipped'
      cwd: projectDir,
      // Sleep briefly so we can verify the pid file before the process
      // exits — keeps the test deterministic across slow CI boxes.
      command: 'sh -c "echo hello-detached; sleep 0.3"',
      envContributions: () => ({}),
    };

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [echoer],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 100,
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.detached).toBe(true);
    const pidPath = join(
      projectDir,
      '.lich',
      'state',
      result.key,
      'pids',
      'echoer.pid',
    );
    // LEV-245: detached runner now writes .jsonl, not .log.
    const jsonlPath = join(
      projectDir,
      '.lich',
      'state',
      result.key,
      'logs',
      'echoer.jsonl',
    );

    expect(existsSync(pidPath)).toBe(true);
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    expect(result.owned.pids.echoer).toBe(pid);
    expect(result.owned.readiness.echoer).toBe('skipped');

    // The JSONL file is written during the readiness window. Wait briefly
    // for the child to produce it and the writer to flush.
    await waitFor(() => {
      try {
        const content = readFileSync(jsonlPath, 'utf8');
        return content.includes('hello-detached');
      } catch {
        return false;
      }
    });
    const jsonlContent = readFileSync(jsonlPath, 'utf8');
    // Every line should be a valid JSON record with the expected shape.
    const records = jsonlContent
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { ts: string; service: string; stream: string; level: string; message: string });
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((r) => r.message.includes('hello-detached') && r.stream === 'stdout' && r.level === 'info')).toBe(true);
    // Records must have the service name set.
    expect(records.every((r) => r.service === 'echoer')).toBe(true);
  });

  it('readiness reports timeout when port has no listener and ready when one binds', async () => {
    // Service A: claims a port but never binds (sh echo). Probe should time
    // out within the short test budget.
    const a: OwnedService = {
      name: 'a',
      kind: 'owned',
      portNames: ['a'],
      cwd: projectDir,
      command: 'sh -c "echo a-up"',
      envContributions: () => ({}),
    };
    // Service B: no port -> probe skipped.
    const b: OwnedService = {
      name: 'b',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo b-up"',
      envContributions: () => ({}),
    };

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [a, b],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 100,
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.detached).toBe(true);
    expect(result.owned.readiness.a).toBe('timeout');
    expect(result.owned.readiness.b).toBe('skipped');
  });

  it('returns synchronously soon after spawn (does not wait for child exit)', async () => {
    // Child runs for ~2s. If `dev` waited on `done`, the call would block
    // for the full duration; the detached path should return in well under
    // a second (spawn + a single 100ms probe budget).
    const slow: OwnedService = {
      name: 'slow',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "sleep 2; echo done"',
      envContributions: () => ({}),
    };

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [slow],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 100,
    });

    const start = Date.now();
    await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    const elapsed = Date.now() - start;

    // Generous upper bound — slow CI machines can stall, but 1.5s is well
    // under the 2s the child runs for.
    expect(elapsed).toBeLessThan(1500);
  });

  // ---------------------------------------------------------------------------
  // LEV-219 — owned-service failure surfacing
  // ---------------------------------------------------------------------------
  it('a crashing owned service makes dev throw a CLIError (non-zero exit)', async () => {
    const crasher: OwnedService = {
      name: 'crasher',
      kind: 'owned',
      portNames: ['crasher'],
      cwd: projectDir,
      command: 'sh -c "echo prisma-did-not-initialize 1>&2; exit 1"',
      envContributions: () => ({}),
    };

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [crasher],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 3000,
    });

    let thrown: unknown;
    try {
      await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    } catch (err) {
      thrown = err;
    }
    // dev MUST throw so `runCli` reports a non-zero exit code — callers and
    // the dogfood e2e tier rely on it to detect partial failure.
    expect(thrown).toBeInstanceOf(CLIError);
    const err = thrown as CLIError;
    expect(err.message).toContain('crasher');
    // The structured payload rides along on `details.owned` for `--json`.
    const owned = (err.details as any)?.owned;
    expect(owned.statuses.crasher).toBe('failed');
    expect(owned.exitCodes.crasher).toBe(1);
    expect(owned.lastStderr.crasher).toContain('prisma-did-not-initialize');
  }, 10_000);

  it('a healthy + crashing mix still throws but reports both statuses', async () => {
    const ok: OwnedService = {
      name: 'ok',
      kind: 'owned',
      portNames: [], // no probe -> skipped
      cwd: projectDir,
      command: 'sh -c "sleep 2"',
      envContributions: () => ({}),
    };
    const crasher: OwnedService = {
      name: 'crasher',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo crash-detail 1>&2; exit 7"',
      envContributions: () => ({}),
    };

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [ok, crasher],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 3000,
    });

    let thrown: unknown;
    try {
      await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CLIError);
    const owned = ((thrown as CLIError).details as any)?.owned;
    expect(owned.statuses.ok).toBe('skipped');
    expect(owned.statuses.crasher).toBe('failed');
    expect(owned.exitCodes.crasher).toBe(7);

    // The pretty rendering of the failure includes the stderr tail block.
    const cmdPretty = makeUpCommand(() => registry, {
      getServices: (): Service[] => [ok, crasher],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 3000,
    });
    let prettyThrown: unknown;
    try {
      await cmdPretty.run({
        cwd: projectDir,
        format: 'pretty',
        args: [],
        flags: {},
      });
    } catch (err) {
      prettyThrown = err;
    }
    const summary = ((prettyThrown as CLIError).details as any)?.summary as string;
    expect(summary).toContain('crasher  pid=');
    expect(summary).toContain('failed');
    expect(summary).toContain('last stderr:');
    expect(summary).toContain('crash-detail');
  }, 12_000);

  it('through the runCli dispatcher, a crashing owned service yields exit code 1', async () => {
    // End-to-end of the LEV-219 wiring: `runCli` only reports a non-zero
    // exit code when the command throws — confirm the dev command's
    // CLIError actually propagates as exitCode 1 with the crash output on
    // stderr (both pretty and --json paths).
    const crasher: OwnedService = {
      name: 'crasher',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo fatal-startup-error 1>&2; exit 1"',
      envContributions: () => ({}),
    };
    const devCmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [crasher],
      composeRunnerFactory: makeMockComposeFactory().factory,
      readinessTimeoutMs: 3000,
    });
    const cmdReg = new CommandRegistry();
    cmdReg.register(devCmd);

    const pretty = await runCli(['up'], cmdReg, { cwd: projectDir });
    expect(pretty.exitCode).toBe(1);
    expect(pretty.stderr).toContain('crasher');
    expect(pretty.stderr).toContain('fatal-startup-error');

    const json = await runCli(['up', '--json'], cmdReg, { cwd: projectDir });
    expect(json.exitCode).toBe(1);
    const parsed = JSON.parse(json.stderr) as {
      code: string;
      details?: { owned?: { statuses: Record<string, string> } };
    };
    expect(parsed.details?.owned?.statuses.crasher).toBe('failed');
  }, 12_000);

  it('a clean detached run does not throw', async () => {
    const echoer: OwnedService = {
      name: 'echoer',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "sleep 1"',
      envContributions: () => ({}),
    };
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [echoer],
      composeRunnerFactory: factory,
      readinessTimeoutMs: 100,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;
    expect(result.detached).toBe(true);
    expect(result.owned.statuses.echoer).toBe('skipped');
  }, 10_000);

  it('--live flag re-engages the foreground runner (no pid file, JSONL log)', async () => {
    const echoer: OwnedService = {
      name: 'echoer',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo hello-live"',
      envContributions: () => ({}),
    };

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [echoer],
      composeRunnerFactory: factory,
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { live: true },
    })) as any;

    expect(result.live).toBe(true);
    expect(result.owned.exitCodes.echoer).toBe(0);

    // Foreground runner writes JSONL to .lich/logs, not the state dir.
    const jsonlPath = join(projectDir, '.lich', 'logs', 'echoer.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);

    // No pid file is created by the foreground path.
    const pidPath = join(
      projectDir,
      '.lich',
      'state',
      result.key,
      'pids',
      'echoer.pid',
    );
    expect(existsSync(pidPath)).toBe(false);
  });
});
