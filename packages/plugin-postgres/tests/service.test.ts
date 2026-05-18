import { describe, it, expect } from 'vitest';
import { pgService } from '../src/service';

describe('pgService (legacy DockerService re-export)', () => {
  it('is kind=docker with name "postgres"', () => {
    expect(pgService.kind).toBe('docker');
    expect(pgService.name).toBe('postgres');
  });

  it('exposes a single port named "postgres"', () => {
    expect(pgService.portNames).toEqual(['postgres']);
  });

  it('uses postgres:16-alpine', () => {
    expect(pgService.image).toBe('postgres:16-alpine');
  });

  it('maps host port to container 5432', () => {
    expect(pgService.containerPortName).toBe('postgres');
    expect(pgService.containerPortInContainer).toBe(5432);
  });

  it('volume-mounts /var/lib/postgresql/data', () => {
    expect(pgService.volumeMountPath).toBe('/var/lib/postgresql/data');
  });

  it('no longer carries an envContributions field (replaced by addEnvSource in LEV-187)', () => {
    // The legacy `envContributions(ports)` shape was removed when the plugin
    // migrated to explicit `api.addEnvSource('url', …)` calls. The plugin-level
    // test (`plugin.test.ts`) covers the new contract.
    expect(pgService.envContributions).toBeUndefined();
  });

  it('passes POSTGRES_USER/PASSWORD/DB into the container env', () => {
    expect(pgService.containerEnv).toMatchObject({
      POSTGRES_USER: 'levelzero',
      POSTGRES_PASSWORD: 'levelzero',
      POSTGRES_DB: 'levelzero',
    });
  });

  it('has a healthCommand using pg_isready', () => {
    expect(pgService.healthCommand?.[0]).toBe('pg_isready');
  });
});
