import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  Service,
  DockerService,
  StackContext,
  PortMap,
  RunningHandle,
  EnvContributions,
} from '../../src/services/types';

describe('service contract types', () => {
  it('StackContext has worktree fields', () => {
    const ctx: StackContext = {
      worktreeKey: 'a3f8c1234567',
      worktreePath: '/tmp/foo',
      branch: 'main',
    };
    expect(ctx.worktreeKey).toBe('a3f8c1234567');
  });

  it('PortMap is a string -> number record', () => {
    const m: PortMap = { postgres: 54123, api: 54124 };
    expect(m.postgres).toBe(54123);
  });

  it('a DockerService can be constructed and is assignable to Service', () => {
    const svc: DockerService = {
      name: 'postgres',
      kind: 'docker',
      portNames: ['postgres'],
      image: 'postgres:16-alpine',
      containerEnv: { POSTGRES_PASSWORD: 'pw' },
      containerPortInContainer: 5432,
      containerPortName: 'postgres',
      volumeMountPath: '/var/lib/postgresql/data',
      envContributions: (ports) => ({ DATABASE_URL: `postgres://...:${ports.postgres}/x` }),
    };
    const asService: Service = svc;
    expect(asService.kind).toBe('docker');
  });

  it('EnvContributions is a function PortMap -> Record<string,string>', () => {
    const fn: EnvContributions = (ports) => ({ FOO: String(ports.x ?? 0) });
    expect(fn({ x: 7 }).FOO).toBe('7');
  });

  it('RunningHandle carries the data needed for stop()', () => {
    const handle: RunningHandle = {
      serviceName: 'postgres',
      containerName: 'levelzero-a3f8c1234567-postgres',
      ports: { postgres: 54123 },
    };
    expect(handle.containerName).toContain('levelzero-');
  });

  it('Service discriminates on kind (compile-time check)', () => {
    expectTypeOf<Service['kind']>().toEqualTypeOf<'docker' | 'owned'>();
  });
});
