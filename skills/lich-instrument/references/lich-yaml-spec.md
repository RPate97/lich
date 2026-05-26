# lich.yaml reference

The schema, semantics, and validate-error remediation for `lich.yaml`. Read this when proposing a shape or fixing validate failures.

## Table of contents

1. [Top-level structure](#top-level-structure)
2. [`runtime`](#runtime)
3. [`services` (compose)](#services-compose)
4. [`owned` (host processes)](#owned-host-processes)
5. [`env` + interpolation](#env--interpolation)
6. [`env_groups`](#env_groups)
7. [`lifecycle`](#lifecycle)
8. [`profiles`](#profiles)
9. [`commands`](#commands)
10. [Common validate errors](#common-validate-errors)

---

## Top-level structure

| Key | Required | Purpose |
|-----|----------|---------|
| `version` | yes | `"1"` (only supported version) |
| `runtime` | no | compose CLI selection + proxy port pin |
| `services` | no | docker-compose services lich orchestrates |
| `owned` | no | host processes lich runs directly |
| `env` | no | env vars exposed to every owned service |
| `env_groups` | no | named env-var bundles for `lich exec` / lifecycle hooks |
| `lifecycle` | no | before_up / after_up / before_down / after_down hooks |
| `profiles` | no | named subsets of services + custom env |
| `commands` | no | custom CLI commands (e.g. `lich db:psql`) |

Minimum viable yaml: `version` + either `services` or `owned` (usually both).

```yaml
version: "1"
owned:
  api:
    cmd: bun run dev
```

That's a complete, valid yaml. Everything else is incremental.

---

## `runtime`

```yaml
runtime:
  compose_cli: auto          # auto | docker | podman | nerdctl
  proxy_port: 3300           # daemon's reverse-proxy port (default 3300, derived from LICH_HOME if unset)
```

Both fields optional. `auto` is the default for `compose_cli` and is almost always correct. Only pin `proxy_port` if you need stable friendly URLs across teammates (e.g. for webhook URLs hardcoded in third-party tools).

---

## `services` (compose)

Each entry is a docker-compose service. Lich generates a per-stack `compose.override.yaml` with allocated ports + env injection.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - { container: 5432, env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp
    tmpfs:
      - /var/lib/postgresql/data    # in-RAM data dir — gone on `lich down`
    volumes:
      - ./local-data:/var/lib/postgresql/data    # alternative: persisted to disk
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d myapp"]
      interval: 1s
      timeout: 1s
      retries: 30
    depends_on: [other-service]
```

**Key points:**

- `ports.env` is the env var lich exposes **inside the container** — the actual host port is dynamic, allocated by lich per stack.
- Use `tmpfs` for dev databases you want gone on tear-down. Use `volumes` for persisted state.
- `healthcheck` lets `depends_on` block until the service is actually ready, not just running. Skip for stateless services.
- Multi-port: each entry in `ports:` gets its own `env` name. Reference them via `host_port_<idx>` (0-indexed) or by env name.

**Most compose features pass through verbatim:** `image`, `environment`, `volumes`, `tmpfs`, `healthcheck`, `depends_on`, `command`, `entrypoint`, `working_dir`, `user`, `restart`, etc. If it works in `docker-compose.yml`, it works here.

---

## `owned` (host processes)

Host processes lich starts directly. Logs are captured to `<LICH_HOME>/stacks/<id>/logs/<service>.log`.

```yaml
owned:
  api:
    cmd: bun run dev               # required; runs in a shell
    cwd: apps/api                  # optional; relative to repo root, default = root
    port: { env: PORT }            # optional; lich allocates, injects as process.env.PORT
    ports:                         # multi-port shape — alternative to `port:`
      api: { env: API_PORT }
      metrics: { env: METRICS_PORT }
    env:
      FOO: bar                     # service-scoped env (merges with top-level `env:`)
    ready_when:
      http_get: /health            # 200 OK from this path = ready
      timeout: 30s                 # how long to wait before giving up
    fail_when:
      log_match: "EADDRINUSE|Cannot find module"   # regex; matching log = hard fail (short-circuits ready_when)
    depends_on: [other-owned-or-compose]
```

**Common patterns:**

- **HTTP service**: `cmd: <dev server>` + `port:` + `ready_when.http_get: /health` (or `/` for SPAs).
- **CLI background worker**: `cmd: <worker>` + `ready_when.log_match: "Worker started"`.
- **One-shot setup (rarely)**: just `cmd:` with no `ready_when` — lich treats it as "starting" forever, which usually isn't what you want. Use `lifecycle.after_up` instead for one-shots.

**`ready_when` options:**

- `http_get: <path>` — most common. Path is relative to the service's `port`.
- `log_match: <regex>` — for services that don't expose HTTP (workers, queues). Watches the log for a matching line.
- `cmd: <shell command>` — runs the command periodically; exit 0 = ready.
- `port_open: <port>` — TCP-level readiness, no HTTP body check.
- `capture:` — for tunnel/ephemeral-URL services that print their URL once. See dogfood example.

**`fail_when.log_match`** is the escape hatch for services that produce a "won't recover" signal. Without it, `ready_when` waits the full timeout even when the process is doomed.

---

## `env` + interpolation

Top-level `env:` is exposed to **every** owned service's process env. Most useful for interpolated values that wire services together.

```yaml
env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
  API_URL: "http://localhost:${owned.api.port}"
```

**Interpolation syntax (most used):**

- `${services.<name>.host_port}` — first host port for a compose service
- `${services.<name>.host_port_<idx>}` — Nth port (0-indexed) for multi-port compose services
- `${services.<name>.ports.<env-name>}` — named-port lookup by `env:` field
- `${owned.<name>.port}` — port for an owned service
- `${owned.<name>.ports.<env-name>}` — named-port lookup for multi-port owned services
- `${env.VAR}` — pass-through from the host shell env (fails if unset; use `${env.VAR:-default}` for fallback)
- `${owned.<name>.captured.<key>}` — value from a service's `ready_when.capture` block

Variables resolve at stack startup. Each service sees the same resolved values in its env.

---

## `env_groups`

Named env-var bundles for use with `lich exec` and `lifecycle` hooks. Three patterns:

```yaml
env_groups:
  # Pattern A: standalone — only these vars, no inheritance
  isolated-tools:
    process_env: false              # don't inherit shell env either
    env:
      TOOL_MODE: standalone

  # Pattern B: extends another group
  stack-plus-test:
    extends: stack                  # inherits stack's resolved env
    env:
      TEST_MODE: integration

  # Pattern C: stack-derived (built-in `stack` group)
  # `stack` is implicit — contains top-level `env:` + per-service `port:` / `host_port` exposures
```

Use these for `lich exec --env-group <name> <cmd>` or `lifecycle.after_up[].env_group:`.

---

## `lifecycle`

Hooks at stack boundaries. Five places hooks can live; only two are commonly needed:

```yaml
lifecycle:
  before_up:                        # runs before any service starts
    - ./scripts/check-prereqs.sh
  after_up:                         # runs once all services are ready
    - psql "$DATABASE_URL" -f db/migrations/01_init.sql
    - cmd: ./scripts/seed.sh
      env_group: stack-plus-test    # optional — use a named env bundle
  before_down:                      # runs before any service stops
    - ./scripts/dump-state.sh
  after_down:                       # runs after all services have stopped
    - rm -rf /tmp/myapp-cache
```

Entries are either a string (the cmd) or an object: `{ cmd: ..., env_group?: ..., cwd?: ... }`.

`after_up` is the most useful — that's where migrations / seeds go.

---

## `profiles`

Named subsets of the stack. Useful when you want fast iteration (skip DB) AND full DB testing from the same yaml:

```yaml
profiles:
  dev:fast:
    default: true                   # `lich up` (no arg) picks this
    services: []                    # no compose services
    owned: [api, web]               # subset of owned

  dev:
    services: [postgres]
    owned: [api, web]
    env:
      DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
    lifecycle:
      after_up:
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql

  dev:test-env:
    extends: dev                    # inherits dev's services + owned + lifecycle
    env:
      DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp_test"
```

`lich up <profile-name>` switches between them. Top-level `services:` / `owned:` / `env:` / `lifecycle:` define the **superset**; profiles pick subsets and override.

**When to use profiles:** the user wants different startup modes (fast iteration vs full-stack) or different env values (test DB vs dev DB) from one yaml.

**When NOT to use profiles:** the user has one way they always run the stack. Profiles add maintenance overhead.

---

## `commands`

Custom CLI commands invoked via `lich <name>`. Inherit the stack's env.

```yaml
commands:
  db:psql:
    cmd: psql "$DATABASE_URL"
    help: |
      Open a psql shell against the local Postgres.

  tools:env-check:
    cmd: printenv DATABASE_URL API_URL
    env_group: isolated-tools       # optional — use a named env bundle instead of stack env
    help: |
      Diagnostic: print the env vars under the `isolated-tools` group.
```

User runs `lich db:psql` and gets the stack's resolved env loaded into the process. `lich help <name>` prints the `help:` text.

---

## Common validate errors

### "unknown reference path: ${services.X.host_port}"
The named service doesn't exist in `services:`. Check spelling. Or the service uses multi-port and you need `host_port_<idx>` or `ports.<name>`.

### "owned service X has no `cmd`"
`cmd:` is required for every owned service.

### "duplicate port allocation: X conflicts with Y"
Two services declare the same `port: { env: SAME_VAR }` value. Each `env:` name must be unique across the stack.

### "profile X extends Y but Y is not defined"
`extends:` references a missing profile. Check spelling, or define the parent first.

### "service X in profile Y is not in top-level `services` or `owned`"
Profile entries reference services that don't exist in the superset. Add them to top-level first.

### "interpolation cycle: ${owned.a.port} → ${owned.b.port} → ${owned.a.port}"
Two services depend on each other's port via env. Break the cycle (use `depends_on` for ordering, but not for env wiring both ways).

### "compose service X has no `image` or `build`"
Compose services need one or the other. `image:` is the common case.

### "`lifecycle.after_up[N]` references env_group X that doesn't exist"
Define the group in top-level `env_groups:`.

### "fail_when.log_match is not a valid regex"
The regex doesn't compile. Test it: `echo "test" | grep -E "<pattern>"` to debug.

---

## Notes on what lich does NOT support

- `version: "2"` or later — only `"1"` is supported.
- Per-environment yaml files (e.g. `lich.yaml.production`) — use profiles instead.
- Secret management — lich doesn't store secrets. Use a `.env` file (gitignored) and reference its values via `${env.VAR}`.
- Container image building (`build:` in services) — `image:` only. If the user has a Dockerfile they want lich to build, point them at a `docker buildx build` lifecycle hook.
