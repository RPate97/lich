import { describe, it, expect } from 'vitest';
import { EnvSourceRegistry } from '../../../src/env/registry';
import {
  envListCommand,
  makeEnvListCommand,
  type EnvListEntry,
  type EnvListResult,
} from '../../../src/commands/env/list';
import type { BulkEnvSource, EnvSource } from '../../../src/env/types';

interface RunCtxOpts {
  json?: boolean;
}

function ctx(opts?: RunCtxOpts) {
  const flags: Record<string, string | boolean> = {};
  if (opts?.json) flags['json'] = true;
  // LEV-168 — the CLI's `pickFormat` sets `format: 'json'` whenever
  // `--json` is on the invocation. The env command branches on
  // `ctx.format === 'json'`, so the test context has to mirror what
  // `runCli` would produce.
  return {
    cwd: '/tmp/lz-env-list-test',
    format: (opts?.json ? 'json' : 'pretty') as 'json' | 'pretty',
    args: [] as string[],
    flags,
  };
}

function postgresUrl(): EnvSource {
  return {
    host: () => 'postgres://u:p@localhost:5433/db',
    container: () => 'postgres://u:p@postgres:5432/db',
    protocol: 'postgres',
  };
}

function postgresHost(): EnvSource {
  return {
    host: () => 'localhost',
    container: () => 'postgres',
    protocol: 'postgres',
  };
}

function infisical(values: Record<string, string>): BulkEnvSource {
  return { resolve: () => values };
}

describe('levelzero env list', () => {
  it('exports a command named "env.list"', () => {
    expect(envListCommand.name).toBe('env.list');
    expect(typeof envListCommand.describe).toBe('string');
  });

  it('renders a friendly message when no sources are registered (pretty)', async () => {
    const cmd = makeEnvListCommand({ getEnvSourceRegistry: () => new EnvSourceRegistry() });
    const output = (await cmd.run(ctx())) as string;
    expect(output).toBe('no env sources registered\n');
  });

  it('returns an empty entries array with --json when no sources are registered', async () => {
    const cmd = makeEnvListCommand({ getEnvSourceRegistry: () => new EnvSourceRegistry() });
    const output = (await cmd.run(ctx({ json: true }))) as EnvListResult;
    expect(output).toEqual({ entries: [] });
  });

  it('lists every named + bulk source with plugin attribution (--json)', async () => {
    const registry = new EnvSourceRegistry();
    registry.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: postgresUrl(),
      pluginName: '@levelzero/plugin-postgres',
    });
    registry.registerNamed({
      namespace: 'postgres',
      name: 'host',
      fullKey: 'postgres.host',
      source: postgresHost(),
      pluginName: '@levelzero/plugin-postgres',
    });
    registry.registerBulk({
      namespace: 'infisical',
      source: infisical({ STRIPE_KEY: 'sk_test', SENTRY_DSN: 'https://x' }),
      pluginName: '@levelzero/plugin-infisical',
    });

    const cmd = makeEnvListCommand({ getEnvSourceRegistry: () => registry });
    const output = (await cmd.run(ctx({ json: true }))) as EnvListResult;
    expect(output.entries).toEqual<EnvListEntry[]>([
      {
        key: 'postgres.host',
        namespace: 'postgres',
        name: 'host',
        kind: 'named',
        protocol: 'postgres',
        plugin: '@levelzero/plugin-postgres',
      },
      {
        key: 'postgres.url',
        namespace: 'postgres',
        name: 'url',
        kind: 'named',
        protocol: 'postgres',
        plugin: '@levelzero/plugin-postgres',
      },
      {
        key: 'infisical.*',
        namespace: 'infisical',
        name: null,
        kind: 'bulk',
        protocol: null,
        plugin: '@levelzero/plugin-infisical',
      },
    ]);
  });

  it('renders pretty text with a header, named rows, and bulk rows annotated with (bulk)', async () => {
    const registry = new EnvSourceRegistry();
    registry.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: postgresUrl(),
      pluginName: '@levelzero/plugin-postgres',
    });
    registry.registerBulk({
      namespace: 'infisical',
      source: infisical({ STRIPE_KEY: 'sk' }),
      pluginName: '@levelzero/plugin-infisical',
    });

    const cmd = makeEnvListCommand({ getEnvSourceRegistry: () => registry });
    const output = (await cmd.run(ctx())) as string;

    // Header line + two rows.
    const lines = output.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^SOURCE\s+PROTOCOL\s+PLUGIN$/);
    expect(lines[1]).toMatch(/^postgres\.url\s+postgres\s+@levelzero\/plugin-postgres$/);
    expect(lines[2]).toMatch(/^infisical\.\* \(bulk\)\s+\(n\/a\)\s+@levelzero\/plugin-infisical$/);
  });

  it('falls back to "-" when a named source has no declared protocol', async () => {
    const registry = new EnvSourceRegistry();
    registry.registerNamed({
      namespace: 'custom',
      name: 'value',
      fullKey: 'custom.value',
      source: { host: () => 'h', container: () => 'c' },
      pluginName: '@levelzero/plugin-custom',
    });

    const cmd = makeEnvListCommand({ getEnvSourceRegistry: () => registry });
    const result = (await cmd.run(ctx({ json: true }))) as EnvListResult;
    expect(result.entries[0]?.protocol).toBeNull();

    const pretty = (await cmd.run(ctx())) as string;
    expect(pretty).toMatch(/custom\.value\s+-\s+@levelzero\/plugin-custom/);
  });
});
