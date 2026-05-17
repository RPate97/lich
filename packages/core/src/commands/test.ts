import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../errors';
import { Registry } from '../registry';
import { pgService } from '../services/postgres';
import { apiService, webService } from '../services/builtins';
import { resolveStackContext } from '../services/context';
import { vitestAdapter } from '@levelzero/plugin-vitest';
import { playwrightTestAdapter } from '../adapters/test-runner/playwright';
import type { TestRunnerAdapter } from '../adapters/test-runner/types';
import type { Command, CommandContext } from './types';

export interface MakeTestCommandOptions {
  /** Registry provider; defaults to a Registry under $LEVELZERO_HOME/.levelzero/registry.json. */
  getRegistry?: () => Registry;
  /** Vitest adapter for unit + integration runs. Defaults to the real spawning adapter. */
  vitestAdapter?: TestRunnerAdapter;
  /** Playwright adapter for e2e runs. Defaults to the real spawning adapter. */
  playwrightAdapter?: TestRunnerAdapter;
}

const USAGE_HINT = 'usage: levelzero test <unit|integration|e2e>';

function defaultRegistry(): Registry {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return new Registry(join(home, '.levelzero', 'registry.json'));
}

/**
 * Build `levelzero test [unit|integration|e2e]`. Dispatches the requested
 * subcommand to the appropriate `TestRunnerAdapter` with a per-subcommand env
 * map:
 *
 *   - `unit`        → vitest, `tests/unit/**`, env: {}  (no stack required)
 *   - `integration` → vitest, `tests/integration/**`, env: { DATABASE_URL, API_URL }
 *   - `e2e`         → playwright, `tests/e2e/**`, env: { API_URL, WEB_URL }
 *
 * Env derivation mirrors the running stack's `pgService` / `apiService` /
 * `webService` envContributions — single source of truth lives in
 * `services/postgres.ts` and `services/builtins.ts`. `integration` and `e2e`
 * require a running stack (a registry entry for the current worktree);
 * `unit` skips the stack lookup entirely so unit tests stay runnable without
 * `levelzero dev`.
 */
export function makeTestCommand(opts?: MakeTestCommandOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const vitest = opts?.vitestAdapter ?? vitestAdapter;
  const playwright = opts?.playwrightAdapter ?? playwrightTestAdapter;

  return {
    name: 'test',
    describe: 'Run unit, integration, or e2e tests against the current stack',
    async run(ctx: CommandContext) {
      const sub = ctx.args[0];
      if (sub === undefined) {
        throw new CLIError(
          'CONFIG_INVALID',
          'levelzero test requires a subcommand',
          USAGE_HINT,
        );
      }

      if (sub === 'unit') {
        // Unit tests are pure — they don't need DATABASE_URL/API_URL, and
        // forcing a running stack would be hostile to local TDD.
        return await vitest.run({
          cwd: ctx.cwd,
          pattern: 'tests/unit/**',
          env: {},
        });
      }

      if (sub === 'integration') {
        const { databaseUrl, apiUrl } = await resolveStackEnv(ctx, getRegistry, {
          needPostgres: true,
          needApi: true,
          needWeb: false,
        });
        return await vitest.run({
          cwd: ctx.cwd,
          pattern: 'tests/integration/**',
          env: {
            DATABASE_URL: databaseUrl!,
            API_URL: apiUrl!,
          },
        });
      }

      if (sub === 'e2e') {
        const { apiUrl, webUrl } = await resolveStackEnv(ctx, getRegistry, {
          needPostgres: false,
          needApi: true,
          needWeb: true,
        });
        return await playwright.run({
          cwd: ctx.cwd,
          pattern: 'tests/e2e/**',
          env: {
            API_URL: apiUrl!,
            WEB_URL: webUrl!,
          },
        });
      }

      throw new CLIError(
        'CONFIG_INVALID',
        `unknown test subcommand: ${sub}`,
        USAGE_HINT,
      );
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
 * WEB_URL from the live service envContributions. Throws a CLIError with a
 * NO_PROJECT code when the worktree isn't a levelzero project, when no stack
 * is running, or when a required service is missing from the running stack.
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
      'run `levelzero dev` first to bring services up',
    );
  }

  const result: ResolvedStackEnv = {};

  if (needs.needPostgres) {
    const env = pgService.envContributions(entry.ports);
    const databaseUrl = env['DATABASE_URL'];
    if (!databaseUrl || !entry.ports['postgres']) {
      throw new CLIError(
        'NO_PROJECT',
        'current stack has no postgres service',
        'ensure postgres is part of the stack and `levelzero dev` has been run',
      );
    }
    result.databaseUrl = databaseUrl;
  }

  if (needs.needApi) {
    const env = apiService.envContributions(entry.ports);
    const apiUrl = env['API_URL'];
    if (!apiUrl || !entry.ports['api-http']) {
      throw new CLIError(
        'NO_PROJECT',
        'current stack has no api service',
        'ensure the api service is part of the stack and `levelzero dev` has been run',
      );
    }
    result.apiUrl = apiUrl;
  }

  if (needs.needWeb) {
    const env = webService.envContributions(entry.ports);
    const webUrl = env['WEB_URL'];
    if (!webUrl || !entry.ports['web-http']) {
      throw new CLIError(
        'NO_PROJECT',
        'current stack has no web service',
        'ensure the web service is part of the stack and `levelzero dev` has been run',
      );
    }
    result.webUrl = webUrl;
  }

  return result;
}

export const testCommand: Command = makeTestCommand();
