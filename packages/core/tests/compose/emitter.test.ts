import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { emitCompose } from '../../src/compose/emitter';
import type {
  ComposeServiceDef,
  ComposeVolumeDef,
  ComposeNetworkDef,
} from '../../src/plugins/types';

describe('emitCompose', () => {
  it('emits a single postgres service as valid YAML', () => {
    const services: Record<string, ComposeServiceDef> = {
      postgres: {
        image: 'postgres:16',
        ports: ['${PORT_postgres}:5432'],
        environment: { POSTGRES_PASSWORD: 'postgres' },
      },
    };
    const yaml = emitCompose({
      services,
      volumes: {},
      networks: {},
      projectName: 'myapp',
      allocatedPorts: { postgres: 54000 },
    });

    const parsed = parseYaml(yaml) as {
      name: string;
      services: Record<string, ComposeServiceDef>;
    };

    expect(parsed.name).toBe('myapp');
    expect(parsed.services.postgres).toBeDefined();
    expect(parsed.services.postgres!.image).toBe('postgres:16');
    expect(parsed.services.postgres!.ports).toEqual(['54000:5432']);
    expect(parsed.services.postgres!.environment).toEqual({
      POSTGRES_PASSWORD: 'postgres',
    });
  });

  it('emits multi-service compose with depends_on preserved', () => {
    const services: Record<string, ComposeServiceDef> = {
      postgres: {
        image: 'postgres:16',
        ports: ['${PORT_postgres}:5432'],
      },
      api: {
        image: 'node:20',
        depends_on: {
          postgres: { condition: 'service_healthy' },
        },
      },
    };
    const yaml = emitCompose({
      services,
      volumes: {},
      networks: {},
      projectName: 'multi',
      allocatedPorts: { postgres: 54010 },
    });

    const parsed = parseYaml(yaml) as {
      services: Record<string, ComposeServiceDef>;
    };

    expect(parsed.services.api!.depends_on).toEqual({
      postgres: { condition: 'service_healthy' },
    });
    expect(parsed.services.postgres!.ports).toEqual(['54010:5432']);
  });

  it('preserves healthcheck fields verbatim', () => {
    const services: Record<string, ComposeServiceDef> = {
      postgres: {
        image: 'postgres:16',
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U postgres'],
          interval: '5s',
          timeout: '5s',
          retries: 10,
          start_period: '2s',
        },
      },
    };
    const yaml = emitCompose({
      services,
      volumes: {},
      networks: {},
      projectName: 'hc',
      allocatedPorts: {},
    });

    const parsed = parseYaml(yaml) as {
      services: Record<string, ComposeServiceDef>;
    };

    expect(parsed.services.postgres!.healthcheck).toEqual({
      test: ['CMD-SHELL', 'pg_isready -U postgres'],
      interval: '5s',
      timeout: '5s',
      retries: 10,
      start_period: '2s',
    });
  });

  it('emits volume and network references', () => {
    const services: Record<string, ComposeServiceDef> = {
      postgres: {
        image: 'postgres:16',
        volumes: ['pgdata:/var/lib/postgresql/data'],
      },
    };
    const volumes: Record<string, ComposeVolumeDef> = {
      pgdata: { driver: 'local' },
    };
    const networks: Record<string, ComposeNetworkDef> = {
      backend: { driver: 'bridge' },
    };

    const yaml = emitCompose({
      services,
      volumes,
      networks,
      projectName: 'vols',
      allocatedPorts: {},
    });

    const parsed = parseYaml(yaml) as {
      services: Record<string, ComposeServiceDef>;
      volumes: Record<string, ComposeVolumeDef>;
      networks: Record<string, ComposeNetworkDef>;
    };

    expect(parsed.services.postgres!.volumes).toEqual([
      'pgdata:/var/lib/postgresql/data',
    ]);
    expect(parsed.volumes).toEqual({ pgdata: { driver: 'local' } });
    expect(parsed.networks).toEqual({ backend: { driver: 'bridge' } });
  });

  it('substitutes ${PORT_<name>} placeholders from allocatedPorts', () => {
    const services: Record<string, ComposeServiceDef> = {
      web: {
        image: 'nginx',
        ports: ['${PORT_web}:80', '${PORT_admin}:8080'],
      },
    };
    const yaml = emitCompose({
      services,
      volumes: {},
      networks: {},
      projectName: 'subst',
      allocatedPorts: { web: 54020, admin: 54021 },
    });

    const parsed = parseYaml(yaml) as {
      services: Record<string, ComposeServiceDef>;
    };

    expect(parsed.services.web!.ports).toEqual(['54020:80', '54021:8080']);
  });

  it('throws when a ${PORT_<name>} placeholder has no allocated port', () => {
    const services: Record<string, ComposeServiceDef> = {
      web: {
        image: 'nginx',
        ports: ['${PORT_missing}:80'],
      },
    };
    expect(() =>
      emitCompose({
        services,
        volumes: {},
        networks: {},
        projectName: 'bad',
        allocatedPorts: {},
      }),
    ).toThrow(/missing/i);
  });

  it('omits top-level volumes/networks when empty', () => {
    const yaml = emitCompose({
      services: { web: { image: 'nginx' } },
      volumes: {},
      networks: {},
      projectName: 'svc-only',
      allocatedPorts: {},
    });

    const parsed = parseYaml(yaml) as {
      services: Record<string, ComposeServiceDef>;
      volumes?: unknown;
      networks?: unknown;
    };

    expect(parsed.services.web).toBeDefined();
    expect(parsed.volumes).toBeUndefined();
    expect(parsed.networks).toBeUndefined();
  });

  it('round-trips: yaml.parse(emitCompose(input)) matches input contributions (after port substitution)', () => {
    const services: Record<string, ComposeServiceDef> = {
      postgres: {
        image: 'postgres:16',
        ports: ['${PORT_postgres}:5432'],
        environment: { POSTGRES_PASSWORD: 'pw' },
        volumes: ['pgdata:/var/lib/postgresql/data'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready'],
          interval: '5s',
          retries: 3,
        },
      },
      api: {
        build: { context: './api', dockerfile: 'Dockerfile' },
        depends_on: { postgres: { condition: 'service_healthy' } },
      },
    };
    const volumes: Record<string, ComposeVolumeDef> = {
      pgdata: { driver: 'local', driver_opts: { type: 'none' } },
    };
    const networks: Record<string, ComposeNetworkDef> = {
      app: { driver: 'bridge' },
    };
    const allocatedPorts = { postgres: 54030 };

    const yaml = emitCompose({
      services,
      volumes,
      networks,
      projectName: 'roundtrip',
      allocatedPorts,
    });

    const parsed = parseYaml(yaml) as {
      name: string;
      services: Record<string, ComposeServiceDef>;
      volumes: Record<string, ComposeVolumeDef>;
      networks: Record<string, ComposeNetworkDef>;
    };

    // Expected: same as input, except port placeholders substituted.
    const expectedServices: Record<string, ComposeServiceDef> = {
      ...services,
      postgres: {
        ...services.postgres!,
        ports: ['54030:5432'],
      },
    };

    expect(parsed.name).toBe('roundtrip');
    expect(parsed.services).toEqual(expectedServices);
    expect(parsed.volumes).toEqual(volumes);
    expect(parsed.networks).toEqual(networks);
  });
});
