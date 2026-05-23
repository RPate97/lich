import type { ComposeServiceDef, ComposeVolumeDef } from '@lich/core';

/**
 * Compose service definition for postgres.
 *
 * Notes for plugin authors:
 *
 *  - **Image is pinned to a minor + variant** (`postgres:16-alpine`) so
 *    behaviour is reproducible across machines without dragging in a full
 *    Debian base.
 *  - **Port string uses the `${PORT_postgres}` placeholder.** The compose
 *    emitter substitutes a stack-allocated host port at render time, so
 *    multiple Lich stacks can run side-by-side without colliding on 5432.
 *    Container side stays fixed at `5432` (the image's listening port).
 *  - **Healthcheck uses `pg_isready` against the seed user/db.** Downstream
 *    services that wait via `depends_on: { condition: service_healthy }` will
 *    only start once postgres can answer a query, not just when the TCP socket
 *    is open.
 *  - **Volume `pgdata`** persists `/var/lib/postgresql/data` across container
 *    restarts. The plugin contributes the matching top-level named volume in
 *    `register()` via `addComposeVolume('pgdata', ...)`.
 *
 * Mirrors the env/healthcheck/volume layout of the legacy `pgService`
 * `DockerService` (re-exported from `./service.ts`) so behaviour is identical
 * regardless of which contribution surface a consumer wires up.
 */
export const postgresComposeService: ComposeServiceDef = {
  image: 'postgres:16-alpine',
  ports: ['${PORT_postgres}:5432'],
  environment: {
    POSTGRES_USER: 'lich',
    POSTGRES_PASSWORD: 'lich',
    POSTGRES_DB: 'lich',
  },
  healthcheck: {
    test: ['CMD-SHELL', 'pg_isready -U lich -d lich'],
    interval: '5s',
    timeout: '5s',
    retries: 10,
    start_period: '2s',
  },
  volumes: ['pgdata:/var/lib/postgresql/data'],
};

/**
 * Named volume backing `/var/lib/postgresql/data`.
 *
 * No `name:` pin: compose namespaces it under the stack's project
 * (`<project>_pgdata`), which is what we want now that postgres is contributed
 * via the plugin path rather than the legacy `dockerServiceToCompose` adapter
 * (which had to pin names to preserve `lich-<key>-postgres-data`).
 */
export const postgresPgdataVolume: ComposeVolumeDef = {};
