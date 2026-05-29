# Canonical lich.yaml example (the dogfood stack)

This is the yaml that lich itself uses for development. It exercises most features — read it when you need to see what a real, working configuration looks like with postgres + an HTTP API + a Next.js frontend + profiles + lifecycle hooks + custom commands.

## The yaml, annotated

```yaml
# yaml-language-server: $schema=https://lich.sh/schema/v1.json
version: "1"

runtime:
  compose_cli: auto
  proxy_port: 3300        # pinned so friendly URLs are stable across teammates

services:
  postgres:
    image: postgres:16-alpine
    ports:
      - { container: 5432, env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: dogfood
    tmpfs:
      - /var/lib/postgresql/data    # ephemeral — gone on lich down
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d dogfood"]
      interval: 1s
      timeout: 1s
      retries: 30

owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { env: PORT }             # lich allocates a free host port, sets PORT env
    # No depends_on: [postgres] — the api code tolerates missing DATABASE_URL
    # (returns 503 on routes that need DB). Lets `dev:fast` profile work.
    ready_when:
      http_get: /health             # api exposes a /health route returning 200 OK
      timeout: 30s
    fail_when:
      # Express prints these on hard startup failures; short-circuits the
      # ready_when wait when we know recovery isn't going to happen.
      log_match: "EADDRINUSE|Cannot find module"

  web:
    cmd: bun run dev
    cwd: apps/web
    port: { env: PORT }
    depends_on: [api]               # web doesn't try to render before the api is up
    ready_when:
      http_get: /                   # Next.js dev server returns 200 on / once compiled
      timeout: 60s                  # next dev compile is slow on cold cache

env:
  # API_URL wired into the web app so it can fetch from the api regardless
  # of which port the allocator picked.
  API_URL: "http://localhost:${owned.api.port}"
  # DATABASE_URL is NOT here — it depends on `services.postgres.host_port`
  # which doesn't resolve under dev:fast (no postgres). Lives in profile env
  # below so only profiles that run postgres see it.

env_groups:
  # "stack-plus-test" inherits the resolved stack env (DATABASE_URL etc.)
  # AND adds TEST_MODE. Used by `lich exec --env-group stack-plus-test ...`
  # and by the after_up hook below.
  stack-plus-test:
    extends: stack
    env:
      TEST_MODE: integration

profiles:
  # Default profile — no DB. The api code returns 503 on DB routes;
  # the web app shows a graceful placeholder. Fast iteration (~2s startup).
  dev:fast:
    default: true                   # `lich up` with no arg picks this
    services: []                    # no compose services
    owned: [api, web]

  # Full DB-backed stack. Tests that need postgres opt in via `lich up dev`.
  dev:
    services: [postgres]
    owned: [api, web]
    env:
      DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/dogfood"
    lifecycle:
      after_up:
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql
        - psql "$DATABASE_URL" -f db/seed.sql

  # Inherits dev's services / owned / lifecycle. Only overrides env.
  # Demonstrates the `extends:` profile pattern.
  dev:env-override:
    extends: dev
    env:
      DATABASE_URL: "postgresql://postgres:test@db.test.example.com:5432/dogfood"

commands:
  db:psql:
    cmd: psql "$DATABASE_URL"
    help: |
      Open a psql shell against the local Postgres.

  test:e2e:
    cmd: bun run test:e2e
    cwd: apps/api
    env_group: stack-plus-test
    help: |
      Run the api's e2e tests against the live stack with TEST_MODE=integration.
```

## Patterns this example shows

- **DB optional / DB required split via profiles** — `dev:fast` (no DB, fast) vs `dev` (DB, full). Lets the same yaml serve quick iteration AND integration testing.
- **Wiring env across services via interpolation** — `API_URL` exposes the api's allocated port to the web app; `DATABASE_URL` (profile-scoped) wires postgres's host port to anything reading the env.
- **`fail_when` short-circuit** — api's `ready_when` would otherwise wait 30s on a doomed startup. `fail_when.log_match` cuts that to subseconds when the failure mode is known.
- **`tmpfs` for ephemeral DB state** — `lich down → lich up` gives a clean postgres without `docker volume prune` gymnastics.
- **`env_groups.stack-plus-test` for integration tests** — `lich exec --env-group stack-plus-test bun test` gets the resolved stack env (DATABASE_URL etc.) plus a `TEST_MODE=integration` flag.
- **Profile `extends:`** — `dev:env-override` inherits services/owned/lifecycle from `dev` and only overrides `env`. Avoids duplication.
- **Custom `commands:`** — `lich db:psql` opens a psql shell with the stack's env already resolved. Wrapped CLI > the user remembering connection strings.

## When to copy this example vs simplify it

The dogfood stack uses **every feature** because it's a coverage testbed for lich itself. Most user repos don't need profiles + env_groups + custom commands all at once.

Default to **stripping**:

- Skip `profiles:` if the user has one way they always run the stack
- Skip `env_groups:` unless they want `lich exec` with custom env bundles
- Skip `commands:` unless they have stack-aware CLIs worth bundling
- Skip `runtime.proxy_port:` unless they need stable friendly URLs across teammates
- Skip `fail_when:` until the user hits a doomed-startup case worth catching

A minimal but useful first yaml is more like:

```yaml
version: "1"

services:
  postgres:
    image: postgres:16-alpine
    ports: [{ container: 5432, env: POSTGRES_HOST_PORT }]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp

owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { env: PORT }
    ready_when:
      http_get: /health

  web:
    cmd: bun run dev
    cwd: apps/web
    port: { env: PORT }
    depends_on: [api]
    ready_when:
      http_get: /

env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
  API_URL: "http://localhost:${owned.api.port}"
```

Add features as the user needs them — don't front-load.
