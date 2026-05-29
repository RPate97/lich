# Interpolation

Lich resolves `${...}` references inside string values at stack startup, after every port has been allocated and every env layer has been merged. This page is a focused reference for the interpolation syntax; the [full `lich.yaml` reference](/reference/lich-yaml) covers when each form is appropriate.

## Where interpolation runs

`${...}` references are resolved inside the values of:

- Top-level `env:` literals
- Per-service `env:` literals (under `services.<name>` and `owned.<name>`)
- Profile `env:` literals
- `env_groups:` entries
- `ready_when` probe targets (`tcp: "localhost:${owned.X.port}"`, etc.)

They are NOT resolved inside `cmd:` strings — those are already shell lines, so use `$VAR` shell expansion. The resolved env is what your `cmd:` reads from.

## The reference forms

### Compose services

- `${services.<name>.host_port}` — first host port for a compose service.
- `${services.<name>.host_port_<idx>}` — Nth port (0-indexed) for multi-port compose services using the array form.
- `${services.<name>.ports.<key>}` — named-port lookup, where `<key>` is the port-key in the service's `ports:` map (NOT the `env:` field name).

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - { container: 5432, env: POSTGRES_HOST_PORT }

env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
```

### Owned (host) processes

- `${owned.<name>.port}` — port for a single-port owned service.
- `${owned.<name>.ports.<key>}` — named-port lookup for multi-port owned services. `<key>` is the port-key in the `ports:` map.
- `${owned.<name>.captured.<key>}` — value from a service's `ready_when.capture` block (for tunnel / ephemeral-URL services).

```yaml
owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { env: PORT }
    ready_when:
      http_get: /health
  supabase:
    cmd: supabase start
    oneshot: true
    stop_cmd: supabase stop
    ports:
      api: { env: SUPABASE_API_PORT }
      db:  { env: SUPABASE_DB_PORT }
    ready_when:
      tcp: "localhost:${owned.supabase.ports.api}"   # use the port-key, NOT the env field name

env:
  API_URL: "http://localhost:${owned.api.port}"
  SUPABASE_URL: "http://localhost:${owned.supabase.ports.api}"
```

### Worktree

- `${worktree.name}` — sanitized worktree directory name (e.g. `my-app`).
- `${worktree.id}` — stable 12-hex-char hash of the worktree's absolute path (e.g. `a4e87c8572d0`). Same path → same id across runs. Perfect for per-worktree namespacing of external resources so parallel stacks don't collide.
- `${worktree.path}` — absolute path to the worktree root.

```yaml
owned:
  supabase:
    cmd: supabase start
    oneshot: true
    stop_cmd: supabase stop
    env:
      # Per-worktree project_id keeps parallel lich stacks from colliding
      # on the same set of supabase containers.
      SUPABASE_PROJECT_ID: "myapp-${worktree.id}"
```

## What's NOT supported

- **No `${env.VAR}` form.** The host shell's env is automatically inherited at the lowest precedence layer, so any shell var (`DATABASE_URL`, `OPENAI_API_KEY`, etc.) is already visible to spawned services unless something higher up overrides it. To reference a host-shell var inside another env entry, use `$VAR` shell expansion inside a `cmd:` line, or pull it via `env_from:` / `env_files:` so it joins the lich pipeline.

- **No nested interpolation.** `${...}` is not recursive — you can't reference another interpolation result inside an interpolation. Order the layering so the value you want is at the top level.

- **No fallback / default syntax.** There's no `${VAR:-default}`. Either the reference resolves or it errors at startup. Provide a value (possibly `null` — see below) or move the conditional logic into a `cmd:` line.

## Port-allocation timing

Ports are allocated **once, up front** during step 4 of `lich up` — before any service starts. That means `${owned.X.port}` / `${owned.X.ports.<key>}` are already resolved to real integers by the time another service's `cmd` or env runs. This is what lets oneshot launchers (supabase et al.) configure their spawned services with lich-allocated ports without pinning anything.

See [Oneshot services](/concepts/oneshot-services) for how this enables external CLI launchers.

## Unsetting a value (`null`)

Set an env key to `null` to remove it from the resolved env — useful for scrubbing a value pulled in by `env_from`, `env_files`, or the parent shell:

```yaml
env:
  PORT: "3000"
  NEXT_PUBLIC_AUTH_SUPABASE_URL: null   # explicit unset; spawned services see no key
```

Empty string is NOT equivalent. `null` makes `process.env.FOO === undefined` (JS) / `[ -z "${FOO+x}" ]` true (bash) rather than `""`.

The drop happens before interpolation, so a nulled value with a `${...}` reference doesn't surface "unresolved reference" errors.

## Common interpolation errors

### "unknown reference path: `${services.X.host_port}`"

The named service doesn't exist in `services:`. Check spelling. Or the service uses multi-port and you need `host_port_<idx>` or `ports.<name>`.

### "interpolation cycle: `${owned.a.port} → ${owned.b.port} → ${owned.a.port}`"

Two services depend on each other's port via env. Break the cycle (use `depends_on` for ordering, but not for env wiring both ways).

### "unknown reference path: `${owned.X.ports.SOMETHING}`" when `SOMETHING` looks like an env var

The `<key>` in `${owned.X.ports.<key>}` is the **port-key** from the service's `ports:` map, not the `env:` field name. Example:

```yaml
owned:
  supabase:
    ports:
      api: { env: SUPABASE_API_PORT }   # port-key is `api`; env field is `SUPABASE_API_PORT`
```

Reference it as `${owned.supabase.ports.api}` — NOT `${owned.supabase.ports.SUPABASE_API_PORT}`.

For the full list of validate errors and remediation, see the [`lich.yaml` reference](/reference/lich-yaml#common-validate-errors).
