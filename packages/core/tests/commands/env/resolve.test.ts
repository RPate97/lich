import { describe, it, expect } from 'vitest';
import { EnvSourceRegistry } from '../../../src/env/registry';
import {
  envResolveCommand,
  makeEnvResolveCommand,
  type EnvResolveResult,
} from '../../../src/commands/env/resolve';
import type { BulkEnvSource, EnvSource } from '../../../src/env/types';
import { CLIError } from '../../../src/errors';

interface RunCtxOpts {
  args?: string[];
  flags?: Record<string, string | boolean>;
}

function ctx(opts?: RunCtxOpts) {
  const flags = opts?.flags ?? {};
  // LEV-168 — pretty is the new default; the CLI's `pickFormat` sets
  // `format: 'json'` only when `--json` is on the invocation, so mirror
  // that here when the test set `flags.json = true`.
  return {
    cwd: '/tmp/lz-env-resolve-test',
    format: (flags['json'] ? 'json' : 'pretty') as 'json' | 'pretty',
    args: opts?.args ?? [],
    flags,
  };
}

function postgresUrl(): EnvSource {
  return {
    host: ({ ports }) => `postgres://u:p@localhost:${ports.postgres}/db`,
    container: () => 'postgres://u:p@postgres:5432/db',
    protocol: 'postgres',
  };
}

function infisical(values: Record<string, string>): BulkEnvSource {
  return { resolve: () => values };
}

function registryWithFixtures(): EnvSourceRegistry {
  const registry = new EnvSourceRegistry();
  registry.registerNamed({
    namespace: 'postgres',
    name: 'url',
    fullKey: 'postgres.url',
    source: postgresUrl(),
    pluginName: '@lich/plugin-postgres',
  });
  registry.registerBulk({
    namespace: 'infisical',
    source: infisical({ STRIPE_KEY: 'sk_test', SENTRY_DSN: 'https://x' }),
    pluginName: '@lich/plugin-infisical',
  });
  return registry;
}

const STACK_INPUT = {
  ports: { postgres: 5433, api: 3001 },
  projectRoot: '/tmp/lz-env-resolve-test',
  worktreeKey: 'wt-abcd1234',
};

describe('lich env resolve', () => {
  it('exports a command named "env.resolve"', () => {
    expect(envResolveCommand.name).toBe('env.resolve');
    expect(typeof envResolveCommand.describe).toBe('string');
  });

  it('throws CLIError when the service argument is missing', async () => {
    const cmd = makeEnvResolveCommand({});
    await expect(cmd.run(ctx())).rejects.toBeInstanceOf(CLIError);
  });

  it('throws CLIError when extra positional args are passed', async () => {
    const cmd = makeEnvResolveCommand({});
    await expect(cmd.run(ctx({ args: ['api', 'extra'] }))).rejects.toBeInstanceOf(CLIError);
  });

  it('throws CLIError for an invalid --context value', async () => {
    const cmd = makeEnvResolveCommand({});
    await expect(
      cmd.run(ctx({ args: ['api'], flags: { context: 'bogus' } })),
    ).rejects.toBeInstanceOf(CLIError);
  });

  it('resolves named + bulk sources for a service and renders KEY=value lines (pretty)', async () => {
    const cmd = makeEnvResolveCommand({
      getEnvSourceRegistry: () => registryWithFixtures(),
      getEnvInjection: () => ({ DATABASE_URL: 'postgres.url', importAll: ['infisical'] }),
      getStackInput: async () => STACK_INPUT,
    });
    const output = (await cmd.run(ctx({ args: ['api'] }))) as string;
    expect(output).toBe(
      '# resolved env for service "api" (context: container)\n' +
        'DATABASE_URL=postgres://u:p@postgres:5432/db\n' +
        'SENTRY_DSN=https://x\n' +
        'STRIPE_KEY=sk_test\n',
    );
  });

  it('honors --context host to switch named sources from container to host resolver', async () => {
    const cmd = makeEnvResolveCommand({
      getEnvSourceRegistry: () => registryWithFixtures(),
      getEnvInjection: () => ({ DATABASE_URL: 'postgres.url' }),
      getStackInput: async () => STACK_INPUT,
    });
    const output = (await cmd.run(ctx({ args: ['api'], flags: { context: 'host' } }))) as string;
    expect(output).toContain('# resolved env for service "api" (context: host)');
    expect(output).toContain('DATABASE_URL=postgres://u:p@localhost:5433/db');
  });

  it('emits structured JSON when --json is passed', async () => {
    const cmd = makeEnvResolveCommand({
      getEnvSourceRegistry: () => registryWithFixtures(),
      getEnvInjection: () => ({ DATABASE_URL: 'postgres.url' }),
      getStackInput: async () => STACK_INPUT,
    });
    const output = (await cmd.run(
      ctx({ args: ['api'], flags: { json: true, context: 'container' } }),
    )) as EnvResolveResult;
    expect(output).toEqual({
      service: 'api',
      context: 'container',
      env: { DATABASE_URL: 'postgres://u:p@postgres:5432/db' },
    });
  });

  it('returns an empty env (with a note in pretty mode) when envInjection is undefined', async () => {
    const cmd = makeEnvResolveCommand({
      getEnvSourceRegistry: () => registryWithFixtures(),
      getEnvInjection: () => undefined,
      getStackInput: async () => STACK_INPUT,
    });
    const output = (await cmd.run(ctx({ args: ['api'] }))) as string;
    expect(output).toContain('(no env vars injected');

    const json = (await cmd.run(
      ctx({ args: ['api'], flags: { json: true } }),
    )) as EnvResolveResult;
    expect(json.env).toEqual({});
  });

  it('surfaces ENV_SOURCE_MISSING when envInjection references an unknown source', async () => {
    const cmd = makeEnvResolveCommand({
      getEnvSourceRegistry: () => registryWithFixtures(),
      getEnvInjection: () => ({ STRIPE_API_KEY: 'doppler.STRIPE_API_KEY' }),
      getStackInput: async () => STACK_INPUT,
    });
    await expect(cmd.run(ctx({ args: ['api'] }))).rejects.toMatchObject({
      code: 'ENV_SOURCE_MISSING',
    });
  });
});
