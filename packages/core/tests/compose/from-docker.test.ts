import { describe, it, expect } from 'vitest';
import { dockerServiceToCompose } from '../../src/compose/from-docker';
import { pgService } from '@levelzero/plugin-postgres';
import type { DockerService, StackContext } from '../../src/services/types';

const ctx: StackContext = {
  worktreeKey: '0123456789ab',
  worktreePath: '/tmp/lz-fake',
  branch: 'main',
};

describe('dockerServiceToCompose', () => {
  it('converts the postgres builtin into a compose-v2 service def', () => {
    const c = dockerServiceToCompose(pgService, ctx);

    expect(c.serviceName).toBe('postgres');
    expect(c.serviceDef.image).toBe('postgres:16-alpine');
    expect(c.serviceDef.container_name).toBe('levelzero-0123456789ab-postgres');
    expect(c.serviceDef.environment).toEqual({
      POSTGRES_USER: 'levelzero',
      POSTGRES_PASSWORD: 'levelzero',
      POSTGRES_DB: 'levelzero',
    });
    expect(c.serviceDef.ports).toEqual([
      '127.0.0.1:${PORT_postgres}:5432',
    ]);
    expect(c.serviceDef.volumes).toEqual([
      'levelzero-0123456789ab-postgres-data:/var/lib/postgresql/data',
    ]);
    expect(c.volumeName).toBe('levelzero-0123456789ab-postgres-data');
    expect(c.volumeDef).toEqual({ name: 'levelzero-0123456789ab-postgres-data' });
    expect(c.serviceDef.healthcheck?.test).toEqual([
      'CMD',
      'pg_isready',
      '-U',
      'levelzero',
      '-d',
      'levelzero',
    ]);
  });

  it('omits volume / volume_def when service has no volumeMountPath', () => {
    const svc: DockerService = {
      name: 'cache',
      kind: 'docker',
      portNames: ['cache'],
      image: 'redis:7-alpine',
      containerPortName: 'cache',
      containerPortInContainer: 6379,
      envContributions: () => ({}),
    };
    const c = dockerServiceToCompose(svc, ctx);
    expect(c.volumeName).toBeUndefined();
    expect(c.volumeDef).toBeUndefined();
    expect(c.serviceDef.volumes).toBeUndefined();
  });

  it('omits healthcheck when service has no healthCommand', () => {
    const svc: DockerService = {
      name: 'cache',
      kind: 'docker',
      portNames: ['cache'],
      image: 'redis:7-alpine',
      containerPortName: 'cache',
      containerPortInContainer: 6379,
      envContributions: () => ({}),
    };
    const c = dockerServiceToCompose(svc, ctx);
    expect(c.serviceDef.healthcheck).toBeUndefined();
  });

  it('omits ports when no containerPortName/containerPortInContainer is declared', () => {
    const svc: DockerService = {
      name: 'sidecar',
      kind: 'docker',
      portNames: [],
      image: 'busybox',
      envContributions: () => ({}),
    };
    const c = dockerServiceToCompose(svc, ctx);
    expect(c.serviceDef.ports).toBeUndefined();
  });
});
