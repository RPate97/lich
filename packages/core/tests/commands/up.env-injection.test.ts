/**
 * LEV-182 unit tests — host vs container env resolution + compose env injection.
 *
 * The companion to `tests/env/resolve.test.ts`: that file exercises the
 * resolver in isolation; this one wires the resolver through `dev` (mocked
 * compose) and checks that:
 *
 *   1. Compose services receive their resolved env in the emitted YAML's
 *      `environment:` block (fixes pre-existing "compose services get no env"
 *      bug).
 *   2. Owned services receive their resolved env via the spawned process's
 *      environment (host-context resolver picked).
 *   3. The same source key resolves differently for host vs container
 *      consumers within the same `dev` invocation — the canonical Plan 16
 *      requirement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Registry } from '../../src/registry';
import { makeUpCommand } from '../../src/commands/up';
import { EnvSourceRegistry } from '../../src/env/registry';
import type { ComposeRunner } from '../../src/compose/runner';
import type { OwnedService, Service } from '../../src/services/types';
import type {
  ComposeServiceDef,
  ComposeVolumeDef,
} from '../../src/plugins/types';

function makeMockComposeFactory() {
  const constructed: Array<{ projectName: string; composeFile: string }> = [];
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const factory = (projectName: string, composeFile: string): ComposeRunner => {
    constructed.push({ projectName, composeFile });
    const record = (op: string, ...args: unknown[]) => {
      calls.push({ op, args });
    };
    return {
      async up(o) {
        record('up', o);
      },
      async down(o) {
        record('down', o);
      },
      async ps() {
        record('ps');
        return [];
      },
      async logs(svc, o) {
        record('logs', svc, o);
        return '';
      },
      async exec(svc, cmd) {
        record('exec', svc, cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
  };
  return { factory, constructed, calls };
}

/**
 * Build the standard `postgres.url` named source. `host()` derives the
 * localhost URL with the allocated port; `container()` returns the compose-
 * DNS form. Same source key, two values — the canonical Plan 16 split.
 */
function postgresPlugin(): {
  registry: EnvSourceRegistry;
  composeService: { name: string; def: ComposeServiceDef };
  composeVolume: { name: string; def: ComposeVolumeDef };
} {
  const registry = new EnvSourceRegistry();
  registry.registerNamed({
    namespace: 'postgres',
    name: 'url',
    fullKey: 'postgres.url',
    source: {
      host: ({ ports }) =>
        `postgres://u:p@localhost:${ports.postgres}/db`,
      container: () => 'postgres://u:p@postgres:5432/db',
      protocol: 'postgres',
    },
    pluginName: '@lich/plugin-postgres',
  });
  const composeService: { name: string; def: ComposeServiceDef } = {
    name: 'postgres',
    def: {
      image: 'postgres:16-alpine',
      container_name: 'lich-test-postgres',
      ports: ['${PORT_postgres}:5432'],
    },
  };
  const composeVolume: { name: string; def: ComposeVolumeDef } = {
    name: 'pgdata',
    def: {},
  };
  return { registry, composeService, composeVolume };
}

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-envinj-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-envinj-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('lich up — Plan 16 env injection (LEV-182)', () => {
  it('writes the container-resolved env into the compose `environment:` block', async () => {
    const pg = postgresPlugin();
    const { factory } = makeMockComposeFactory();

    const cmd = makeUpCommand(() => registry, {
      // No DockerService entries; postgres ships only as a compose
      // contribution (mirrors the post-LEV-148 architecture).
      getServices: (): Service[] => [],
      getPluginCompose: () => ({
        services: { [pg.composeService.name]: pg.composeService.def },
        volumes: { [pg.composeVolume.name]: pg.composeVolume.def },
        networks: {},
      }),
      composeRunnerFactory: factory,
      getEnvSourceRegistry: () => pg.registry,
      getEnvInjection: () => ({ DATABASE_URL: 'postgres.url' }),
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { key: string; ports: Record<string, number> };

    const yamlPath = join(
      projectDir,
      '.lich',
      result.key,
      'docker-compose.yml',
    );
    const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    // Container-context: postgres compose DNS form, NOT localhost.
    expect(doc.services.postgres!.environment?.DATABASE_URL).toBe(
      'postgres://u:p@postgres:5432/db',
    );
  });

  it('passes the host-resolved env to spawned owned services', async () => {
    const pg = postgresPlugin();
    const { factory } = makeMockComposeFactory();

    // Owned service that prints its resolved env so we can assert from the
    // log. The test exit codes path keeps the suite well under the timeout.
    const echoer: OwnedService = {
      name: 'echoer',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo URL=$DATABASE_URL; echo done"',
      envContributions: () => ({}),
    };

    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [echoer],
      getPluginCompose: () => ({
        services: { [pg.composeService.name]: pg.composeService.def },
        volumes: { [pg.composeVolume.name]: pg.composeVolume.def },
        networks: {},
      }),
      composeRunnerFactory: factory,
      getEnvSourceRegistry: () => pg.registry,
      getEnvInjection: () => ({ DATABASE_URL: 'postgres.url' }),
    });

    // LEV-194 — `--live` keeps the foreground concurrently runner so the
    // test can read each owned service's JSONL log to verify the env it
    // received. The default detached path dumps raw stdout instead.
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { live: true },
    })) as { key: string; ports: Record<string, number>; owned?: unknown };

    expect(result.owned).toBeDefined();
    const logPath = join(projectDir, '.lich', 'logs', 'echoer.jsonl');
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { message: string });
    // Host context: localhost + allocated port.
    expect(
      lines.some((l) =>
        l.message.includes(
          `URL=postgres://u:p@localhost:${result.ports.postgres}/db`,
        ),
      ),
    ).toBe(true);
  });

  it('same source key resolves host vs container differently in one dev invocation', async () => {
    // The canonical Plan 16 acceptance: compose service gets compose-DNS URL,
    // owned service (web) gets localhost URL, both from `postgres.url`.
    const pg = postgresPlugin();
    const { factory } = makeMockComposeFactory();

    const web: OwnedService = {
      name: 'web',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo URL=$DATABASE_URL; echo done"',
      envContributions: () => ({}),
    };

    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [web],
      getPluginCompose: () => ({
        services: { [pg.composeService.name]: pg.composeService.def },
        volumes: { [pg.composeVolume.name]: pg.composeVolume.def },
        networks: {},
      }),
      composeRunnerFactory: factory,
      getEnvSourceRegistry: () => pg.registry,
      getEnvInjection: () => ({ DATABASE_URL: 'postgres.url' }),
    });

    // LEV-194 — `--live` keeps the foreground concurrently runner so the
    // test can read each owned service's JSONL log to verify the env it
    // received.
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { live: true },
    })) as { key: string; ports: Record<string, number> };

    // Compose side: container URL.
    const yamlPath = join(
      projectDir,
      '.lich',
      result.key,
      'docker-compose.yml',
    );
    const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(doc.services.postgres!.environment?.DATABASE_URL).toBe(
      'postgres://u:p@postgres:5432/db',
    );

    // Owned side: host URL.
    const logPath = join(projectDir, '.lich', 'logs', 'web.jsonl');
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { message: string });
    expect(
      lines.some((l) =>
        l.message.includes(
          `URL=postgres://u:p@localhost:${result.ports.postgres}/db`,
        ),
      ),
    ).toBe(true);
  });

  it('importAll bulk source flows into compose AND owned services', async () => {
    const reg = new EnvSourceRegistry();
    reg.registerBulk({
      namespace: 'secrets',
      source: { resolve: () => ({ STRIPE_KEY: 'sk_test_xyz', SENTRY_DSN: 'https://s.io' }) },
      pluginName: '@org/plugin-secrets',
    });

    const composeSvc: ComposeServiceDef = {
      image: 'redis:7-alpine',
      container_name: 'lich-test-redis',
      ports: ['${PORT_redis}:6379'],
    };
    const consumer: OwnedService = {
      name: 'consumer',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo STRIPE=$STRIPE_KEY; echo done"',
      envContributions: () => ({}),
    };
    const { factory } = makeMockComposeFactory();

    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [consumer],
      getPluginCompose: () => ({
        services: { redis: composeSvc },
        volumes: {},
        networks: {},
      }),
      composeRunnerFactory: factory,
      getEnvSourceRegistry: () => reg,
      getEnvInjection: () => ({ importAll: ['secrets'] }),
    });

    // LEV-194 — `--live` so JSONL log read is meaningful.
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { live: true },
    })) as { key: string };

    const yamlPath = join(
      projectDir,
      '.lich',
      result.key,
      'docker-compose.yml',
    );
    const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    // Compose service received every bulk key.
    expect(doc.services.redis!.environment).toMatchObject({
      STRIPE_KEY: 'sk_test_xyz',
      SENTRY_DSN: 'https://s.io',
    });

    // Owned consumer saw the same key via its inherited env.
    const logPath = join(projectDir, '.lich', 'logs', 'consumer.jsonl');
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { message: string });
    expect(lines.some((l) => l.message.includes('STRIPE=sk_test_xyz'))).toBe(true);
  });

  it('writes a .env.<service> snapshot under .lich/state/<wt>/env/ for every service (LEV-183)', async () => {
    // Verifies the acceptance for LEV-183: after `dev`, every running service
    // — compose-managed AND owned — has a dotenv snapshot on disk under
    // `.lich/state/<worktreeKey>/env/`, and the file contents match the
    // values LEV-182 injected.
    const pg = postgresPlugin();
    const { factory } = makeMockComposeFactory();

    const web: OwnedService = {
      name: 'web',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "echo URL=$DATABASE_URL; echo done"',
      envContributions: () => ({}),
    };

    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [web],
      getPluginCompose: () => ({
        services: { [pg.composeService.name]: pg.composeService.def },
        volumes: { [pg.composeVolume.name]: pg.composeVolume.def },
        networks: {},
      }),
      composeRunnerFactory: factory,
      getEnvSourceRegistry: () => pg.registry,
      getEnvInjection: () => ({ DATABASE_URL: 'postgres.url' }),
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { key: string; ports: Record<string, number> };

    const envDir = join(
      projectDir,
      '.lich',
      'state',
      result.key,
      'env',
    );
    // Compose side: container-resolved URL (compose DNS).
    const composeFile = readFileSync(join(envDir, 'postgres.env'), 'utf8');
    expect(composeFile).toMatch(/^# generated by lich up on .+ — DO NOT EDIT/m);
    expect(composeFile).toContain('DATABASE_URL=postgres://u:p@postgres:5432/db');

    // Owned side: host-resolved URL (localhost + port).
    const ownedFile = readFileSync(join(envDir, 'web.env'), 'utf8');
    expect(ownedFile).toContain(
      `DATABASE_URL=postgres://u:p@localhost:${result.ports.postgres}/db`,
    );

    // Same snapshot the YAML received — sanity-check the file contents
    // really mirror what LEV-182 injected.
    const yamlPath = join(
      projectDir,
      '.lich',
      result.key,
      'docker-compose.yml',
    );
    const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(doc.services.postgres!.environment?.DATABASE_URL).toBe(
      'postgres://u:p@postgres:5432/db',
    );
  });

  it('skips env injection when no registry is provided (legacy path unchanged)', async () => {
    const pg = postgresPlugin();
    const { factory } = makeMockComposeFactory();

    const cmd = makeUpCommand(() => registry, {
      getServices: (): Service[] => [],
      getPluginCompose: () => ({
        services: { [pg.composeService.name]: pg.composeService.def },
        volumes: { [pg.composeVolume.name]: pg.composeVolume.def },
        networks: {},
      }),
      composeRunnerFactory: factory,
      // No env-source registry / injection getter — legacy path.
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { key: string };

    const yamlPath = join(
      projectDir,
      '.lich',
      result.key,
      'docker-compose.yml',
    );
    const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    // No injection → no `environment:` block beyond what the service def
    // carries (which is nothing for our test fixture).
    expect(doc.services.postgres!.environment).toBeUndefined();
  });
});
