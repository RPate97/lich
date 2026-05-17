import { describe, it, expect } from 'vitest';
import { postgresComposeService, postgresPgdataVolume } from '../src/compose';

describe('postgresComposeService', () => {
  it('pins postgres:16-alpine', () => {
    expect(postgresComposeService.image).toBe('postgres:16-alpine');
  });

  it('publishes the ${PORT_postgres} placeholder mapped to container 5432', () => {
    expect(postgresComposeService.ports).toEqual(['${PORT_postgres}:5432']);
  });

  it('seeds POSTGRES_USER/PASSWORD/DB to the levelzero defaults', () => {
    expect(postgresComposeService.environment).toEqual({
      POSTGRES_USER: 'levelzero',
      POSTGRES_PASSWORD: 'levelzero',
      POSTGRES_DB: 'levelzero',
    });
  });

  it('mounts the pgdata named volume at /var/lib/postgresql/data', () => {
    expect(postgresComposeService.volumes).toEqual([
      'pgdata:/var/lib/postgresql/data',
    ]);
  });

  it('runs pg_isready as the healthcheck against the seed user/db', () => {
    expect(postgresComposeService.healthcheck).toBeDefined();
    expect(postgresComposeService.healthcheck!.test).toEqual([
      'CMD-SHELL',
      'pg_isready -U levelzero -d levelzero',
    ]);
    expect(postgresComposeService.healthcheck!.interval).toBe('5s');
    expect(postgresComposeService.healthcheck!.retries).toBe(10);
  });
});

describe('postgresPgdataVolume', () => {
  it('declares no `name:` pin so compose namespaces it under the stack project', () => {
    expect(postgresPgdataVolume).toEqual({});
  });
});
