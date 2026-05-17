import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { computeWorktreeKey } from '../../src/worktree';
import { CLIError } from '../../src/errors';
import { makeTestCommand, testCommand } from '../../src/commands/test';
import type { TestRunInput, TestResult, TestRunnerAdapter } from '../../src/adapters/test-runner/types';

const POSTGRES_PORT = 54123;
const API_PORT = 38211;
const WEB_PORT = 38222;

let projectDir: string;
let homeDir: string;
let registry: Registry;

function stubAdapter(name: string): TestRunnerAdapter & { calls: TestRunInput[] } {
  const calls: TestRunInput[] = [];
  const run = vi.fn(async (input: TestRunInput): Promise<TestResult> => {
    calls.push(input);
    return { passed: 1, failed: 0, skipped: 0, total: 1, durationMs: 1, raw: '{}' };
  });
  return { name, run, calls } as unknown as TestRunnerAdapter & { calls: TestRunInput[] };
}

async function seedRegistry(): Promise<void> {
  await registry.upsert(computeWorktreeKey(projectDir), {
    path: projectDir,
    branch: 'main',
    ports: {
      postgres: POSTGRES_PORT,
      'api-http': API_PORT,
      'web-http': WEB_PORT,
    },
    urls: {},
    containers: [],
    network: '',
    logDir: '.levelzero/logs',
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-test-cmd-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-test-cmd-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('levelzero test', () => {
  it('exports a command named "test"', () => {
    expect(testCommand.name).toBe('test');
    expect(typeof testCommand.describe).toBe('string');
  });

  it('errors with usage hint when no subcommand is given', async () => {
    const vitest = stubAdapter('vitest');
    const playwright = stubAdapter('playwright');
    const cmd = makeTestCommand({
      getRegistry: () => registry,
      vitestAdapter: vitest,
      playwrightAdapter: playwright,
    });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: [], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/subcommand|unit|integration|e2e/i);
    expect((err as CLIError).hint ?? '').toMatch(/unit|integration|e2e/i);
    expect(vitest.run).not.toHaveBeenCalled();
    expect(playwright.run).not.toHaveBeenCalled();
  });

  it('errors clearly when an unknown subcommand is given', async () => {
    const vitest = stubAdapter('vitest');
    const playwright = stubAdapter('playwright');
    const cmd = makeTestCommand({
      getRegistry: () => registry,
      vitestAdapter: vitest,
      playwrightAdapter: playwright,
    });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: ['nope'], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/nope|unknown|subcommand/i);
    expect(vitest.run).not.toHaveBeenCalled();
    expect(playwright.run).not.toHaveBeenCalled();
  });

  describe('unit subcommand', () => {
    it('dispatches to vitestAdapter with tests/unit/** pattern and empty env', async () => {
      const vitest = stubAdapter('vitest');
      const playwright = stubAdapter('playwright');
      const cmd = makeTestCommand({
        getRegistry: () => registry,
        vitestAdapter: vitest,
        playwrightAdapter: playwright,
      });

      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['unit'],
        flags: {},
      })) as TestResult;

      expect(vitest.run).toHaveBeenCalledTimes(1);
      expect(playwright.run).not.toHaveBeenCalled();
      expect(vitest.calls[0]!.pattern).toBe('tests/unit/**');
      expect(vitest.calls[0]!.env).toEqual({});
      expect(result.total).toBe(1);
      expect(result.passed).toBe(1);
    });

    it('does not require a running stack for unit tests', async () => {
      // No registry entry seeded — unit tests don't need DATABASE_URL/API_URL.
      const vitest = stubAdapter('vitest');
      const playwright = stubAdapter('playwright');
      const cmd = makeTestCommand({
        getRegistry: () => registry,
        vitestAdapter: vitest,
        playwrightAdapter: playwright,
      });

      await expect(
        cmd.run({ cwd: projectDir, format: 'json', args: ['unit'], flags: {} }),
      ).resolves.toBeDefined();
      expect(vitest.run).toHaveBeenCalledTimes(1);
    });
  });

  describe('integration subcommand', () => {
    it('dispatches to vitestAdapter with tests/integration/** pattern and DATABASE_URL + API_URL env', async () => {
      await seedRegistry();
      const vitest = stubAdapter('vitest');
      const playwright = stubAdapter('playwright');
      const cmd = makeTestCommand({
        getRegistry: () => registry,
        vitestAdapter: vitest,
        playwrightAdapter: playwright,
      });

      await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['integration'],
        flags: {},
      });

      expect(vitest.run).toHaveBeenCalledTimes(1);
      expect(playwright.run).not.toHaveBeenCalled();
      expect(vitest.calls[0]!.pattern).toBe('tests/integration/**');
      expect(vitest.calls[0]!.env).toEqual({
        DATABASE_URL: `postgres://levelzero:levelzero@localhost:${POSTGRES_PORT}/levelzero`,
        API_URL: `http://localhost:${API_PORT}`,
      });
    });

    it('errors when no stack is running for integration', async () => {
      const vitest = stubAdapter('vitest');
      const playwright = stubAdapter('playwright');
      const cmd = makeTestCommand({
        getRegistry: () => registry,
        vitestAdapter: vitest,
        playwrightAdapter: playwright,
      });

      await expect(
        cmd.run({ cwd: projectDir, format: 'json', args: ['integration'], flags: {} }),
      ).rejects.toThrow(/stack|dev/i);
      expect(vitest.run).not.toHaveBeenCalled();
    });

    it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-test-cmd-outside-')));
      const vitest = stubAdapter('vitest');
      const playwright = stubAdapter('playwright');
      const cmd = makeTestCommand({
        getRegistry: () => registry,
        vitestAdapter: vitest,
        playwrightAdapter: playwright,
      });

      await expect(
        cmd.run({ cwd: outside, format: 'json', args: ['integration'], flags: {} }),
      ).rejects.toThrow(CLIError);
      expect(vitest.run).not.toHaveBeenCalled();
    });
  });

  describe('e2e subcommand', () => {
    it('dispatches to playwrightAdapter with tests/e2e/** pattern and API_URL + WEB_URL env', async () => {
      await seedRegistry();
      const vitest = stubAdapter('vitest');
      const playwright = stubAdapter('playwright');
      const cmd = makeTestCommand({
        getRegistry: () => registry,
        vitestAdapter: vitest,
        playwrightAdapter: playwright,
      });

      await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['e2e'],
        flags: {},
      });

      expect(playwright.run).toHaveBeenCalledTimes(1);
      expect(vitest.run).not.toHaveBeenCalled();
      expect(playwright.calls[0]!.pattern).toBe('tests/e2e/**');
      expect(playwright.calls[0]!.env).toEqual({
        API_URL: `http://localhost:${API_PORT}`,
        WEB_URL: `http://localhost:${WEB_PORT}`,
      });
    });

    it('errors when no stack is running for e2e', async () => {
      const vitest = stubAdapter('vitest');
      const playwright = stubAdapter('playwright');
      const cmd = makeTestCommand({
        getRegistry: () => registry,
        vitestAdapter: vitest,
        playwrightAdapter: playwright,
      });

      await expect(
        cmd.run({ cwd: projectDir, format: 'json', args: ['e2e'], flags: {} }),
      ).rejects.toThrow(/stack|dev/i);
      expect(playwright.run).not.toHaveBeenCalled();
    });
  });

  it('default export uses real vitestAdapter + playwrightTestAdapter wiring (smoke)', () => {
    expect(typeof testCommand.run).toBe('function');
    expect(testCommand.name).toBe('test');
  });
});
