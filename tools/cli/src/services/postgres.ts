import type { DockerService } from './types';

export const pgService: DockerService = {
  name: 'postgres',
  kind: 'docker',
  portNames: ['postgres'],
  image: 'postgres:16-alpine',
  containerEnv: {
    POSTGRES_USER: 'levelzero',
    POSTGRES_PASSWORD: 'levelzero',
    POSTGRES_DB: 'levelzero',
  },
  containerPortName: 'postgres',
  containerPortInContainer: 5432,
  volumeMountPath: '/var/lib/postgresql/data',
  envContributions: (ports) => ({
    DATABASE_URL: `postgres://levelzero:levelzero@localhost:${ports.postgres}/levelzero`,
  }),
  healthCommand: ['pg_isready', '-U', 'levelzero', '-d', 'levelzero'],
};
