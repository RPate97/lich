import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../errors';
import { Registry } from '../registry';
import { resolveStackContext } from '../services/context';
import { AdapterRegistry } from '../adapters/registry';
import type { TestRunnerAdapter } from '../adapters/test-runner/types';
import type { Command, CommandContext } from './types';

export interface MakeTestCommandOptions {
  /** Registry provider; defaults to a Registry under $LICH_HOME/.lich/registry.json. */
  getRegistry?: () => Registry;
  /** Vitest adapter for unit + integration runs. When omitted, looked up by name `vitest` under the `test-runner` slot via `getAdapterRegistry`. */
  vitestAdapter?: TestRunnerAdapter;
  /** Playwright adapter for e2e runs. When omitted, looked up by name `playwright` under the `test-runner` slot via `getAdapterRegistry`. */
  playwrightAdapter?: TestRunnerAdapter;
  /**
   * AdapterRegistry provider — used to resolve the vitest/playwright
   * test-runner adapters when explicit adapter overrides are not supplied.
   * The CLI dispatcher (`bin.ts`) injects the merged plugin-aware registry;
   * tests typically pass adapters directly via `vitestAdapter` /
   * `playwrightAdapter` instead.
   */
  getAdapterRegistry?: () => AdapterRegistry;
}

const USAGE_HINT = 'usage: lich test <unit|integration|e2e>';

function defaultRegistry(): Registry {
  const home = process.env['LICH_HOME'] ?? homedir();
  return new Registry(join(home, '.lich', 'registry.json'));
}

/**
 * Build `lich test [unit|integration|e2e]`. Dispatches the requested
 * subcommand to the appropriate `TestRunnerAdapter` with a per-subcommand env
 * map:
 *
 *   - `unit`        → vitest, `tests/unit/**`, env: {}  (no stack required)
 *   - `integration` → vitest, `tests/integration/**`, env: { DATABASE_URL, API_URL }
 *   - `e2e`         → playwright, `tests/e2e/**`, env: { API_URL, WEB_URL }
 *
 * URL derivation mirrors the formulas the postgres/hono/next plugins
 * publish through their `addEnvSource('url', …)` registrations (LEV-187).
 * Inlined here because EnvSource resolution isn't yet plumbed into the
 * command-context (Plan 16 Tier 2 lands that separately); once it is, this
 * helper collapses to a single registry-aware lookup. `integration` and
 * `e2e` require a running stack (a registry entry for the current
 * worktree); `unit` skips the stack lookup entirely so unit tests stay
 * runnable without `lich dev`.
 */
export function makeTestCommand(opts?: MakeTestCommandOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const getAdapterRegistry = opts?.getAdapterRegistry;
  // After LEV-174 the test command never imports plugin packages directly.
  // Explicit adapter overrides (used by tests) win; otherwise resolve by name
  // under the `test-runner` slot from the injected AdapterRegistry. The
  // resolution happens at construction time so a missing adapter surfaces
  // immediately rather than only when a particular subcommand is invoked.
  const resolveAdapter = (name: 'vitest' | 'playwright'): TestRunnerAdapter => {
    if (!getAdapterRegistry) {
      throw new CLIError(
        'CONFIG_INVALID',
        `no ${name} test-runner adapter configured for \`test\``,
        `load \`@lich/plugin-${name}\` in your lich.config.ts, or pass an explicit ${name}Adapter override`,
      );
    }
    try {
      return getAdapterRegistry().get('test-runner', name) as TestRunnerAdapter;
    } catch {
      throw new CLIError(
        'CONFIG_INVALID',
        `no ${name} test-runner adapter configured for \`test\``,
        `load \`@lich/plugin-${name}\` in your lich.config.ts`,
      );
    }
  };
  const vitest = opts?.vitestAdapter ?? null;
  const playwright = opts?.playwrightAdapter ?? null;
  const getVitest = (): TestRunnerAdapter => vitest ?? resolveAdapter('vitest');
  const getPlaywright = (): TestRunnerAdapter =>
    playwright ?? resolveAdapter('playwright');

  return {
    name: 'test',
    describe: 'Run unit, integration, or e2e tests against the current stack',
    async run(ctx: CommandContext) {
      const sub = ctx.args[0];
      if (sub === undefined) {
        throw new CLIError(
          'CONFIG_INVALID',
          'lich test requires a subcommand',
          USAGE_HINT,
        );
      }

      let testResult;
      if (sub === 'unit') {
        // Unit tests are pure — they don't need DATABASE_URL/API_URL, and
        // forcing a running stack would be hostile to local TDD.
        testResult = await getVitest().run({
          cwd: ctx.cwd,
          pattern: 'tests/unit/**',
          env: {},
        });
      } else if (sub === 'integration') {
        const { databaseUrl, apiUrl } = await resolveStackEnv(ctx, getRegistry, {
          needPostgres: true,
          needApi: true,
          needWeb: false,
        });
        testResult = await getVitest().run({
          cwd: ctx.cwd,
          pattern: 'tests/integration/**',
          env: {
            DATABASE_URL: databaseUrl!,
            API_URL: apiUrl!,
          },
        });
      } else if (sub === 'e2e') {
        const { apiUrl, webUrl } = await resolveStackEnv(ctx, getRegistry, {
          needPostgres: false,
          needApi: true,
          needWeb: true,
        });
        testResult = await getPlaywright().run({
          cwd: ctx.cwd,
          pattern: 'tests/e2e/**',
          env: {
            API_URL: apiUrl!,
            WEB_URL: webUrl!,
          },
        });
      } else {
        throw new CLIError(
          'CONFIG_INVALID',
          `unknown test subcommand: ${sub}`,
          USAGE_HINT,
        );
      }

      if (ctx.format === 'json') return testResult;
      const lines: string[] = [];
      lines.push(
        `test ${sub}: ${testResult.passed} passed, ${testResult.failed} failed, ${testResult.skipped} skipped (${testResult.total} total, ${testResult.durationMs}ms)`,
      );
      return lines.join('\n') + '\n';
    },
  };
}

interface ResolvedStackEnv {
  databaseUrl?: string;
  apiUrl?: string;
  webUrl?: string;
}

interface ResolveNeeds {
  needPostgres: boolean;
  needApi: boolean;
  needWeb: boolean;
}

/**
 * Resolve the current worktree's stack entry and pull DATABASE_URL / API_URL /
 * WEB_URL via the same formulas the postgres / hono / next plugins publish
 * through their `addEnvSource('url', …)` registrations (LEV-187). Throws a
 * CLIError with a NO_PROJECT code when the worktree isn't a lich
 * project, when no stack is running, or when a required service is missing
 * from the running stack.
 */
async function resolveStackEnv(
  ctx: CommandContext,
  getRegistry: () => Registry,
  needs: ResolveNeeds,
): Promise<ResolvedStackEnv> {
  const stackCtx = await resolveStackContext(ctx.cwd);
  const entry = await getRegistry().get(stackCtx.worktreeKey);
  if (!entry) {
    throw new CLIError(
      'NO_PROJECT',
      'no stack running for this worktree',
      'run `lich up` first to bring services up',
    );
  }

  const result: ResolvedStackEnv = {};

  if (needs.needPostgres) {
    const postgresPort = entry.ports['postgres'];
    if (!postgresPort) {
      throw new CLIError(
        'NO_PROJECT',
        'current stack has no postgres service',
        'ensure postgres is part of the stack and `lich up` has been run',
      );
    }
    result.databaseUrl = `postgres://lich:lich@localhost:${postgresPort}/lich`;
  }

  if (needs.needApi) {
    const apiPort = entry.ports['api-http'];
    if (!apiPort) {
      throw new CLIError(
        'NO_PROJECT',
        'current stack has no api service',
        'ensure the api service is part of the stack and `lich up` has been run',
      );
    }
    result.apiUrl = `http://localhost:${apiPort}`;
  }

  if (needs.needWeb) {
    const webPort = entry.ports['web-http'];
    if (!webPort) {
      throw new CLIError(
        'NO_PROJECT',
        'current stack has no web service',
        'ensure the web service is part of the stack and `lich up` has been run',
      );
    }
    result.webUrl = `http://localhost:${webPort}`;
  }

  return result;
}

export const testCommand: Command = makeTestCommand();
