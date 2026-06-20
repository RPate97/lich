# lich.yaml reference

The schema, semantics, and validate-error remediation for `lich.yaml`. Read this when proposing a shape or fixing validate failures.

## Cheatsheet

**Load env vars from a `.env` file** (the most common question):

```yaml
env_files:
  - .env
  - .env.local    # optional, gitignored overrides
```

Works across git worktrees. Keep one `.env` in your main checkout and every `git worktree add`'d branch picks it up automatically. No symlinks. See [env_files](#env_files).

**Other env sources**

- Secret-manager CLI (Infisical, 1Password, Doppler): `env_from:` with `cmd:`. See [env_from](#env_from).
- Pass through a single var from the user's shell (`GITHUB_TOKEN`, `NPM_TOKEN`): `env_from: [VAR_NAME]`. See [env_from](#env_from).
- Literal values inline: `env:`. See [env](#env).
- Different env for one service only: per-service `env:`. See [owned](#owned-host-processes).
- Different env for one shell-out command: see [env_groups](#env_groups).

**Wire one service to another's port or URL**

- Compose service's port: `${services.<name>.host_port}`. See [interpolation](#interpolation).
- Owned service's port: `${owned.<name>.port}`. See [interpolation](#interpolation).
- Multi-port service: `${owned.<name>.ports.<key>}` (port-key, not env-var name). See [interpolation](#interpolation).
- Per-worktree unique value (project IDs, namespaces): `${worktree.id}`. See [interpolation](#interpolation).

**Add a service**

- Runs on the host (Node, Bun, Python, etc.): see [owned](#owned-host-processes).
- Runs in a docker container: see [services](#services-compose).
- CLI launcher that exits after spawning (supabase, dbmate): see [oneshot launchers](#one-shot-launchers).

**Service readiness**

- HTTP server with `/health`: `ready_when.http_get`. See [ready_when](#ready_when).
- Worker that logs a "started" line: `ready_when.log_match`. See [ready_when](#ready_when).
- Just need a TCP port to accept connections: `ready_when.tcp`. See [ready_when](#ready_when).
- Service that prints its URL to logs (tunnels): `ready_when.capture`. See [ready_when](#ready_when).

**Scripts at stack boundaries**

- Migrations or seeds after services start: `lifecycle.after_up`. See [lifecycle](#lifecycle).
- Cleanup before stopping: `lifecycle.before_down`. See [lifecycle](#lifecycle).
- Prereq check before anything starts: `lifecycle.before_up`. See [lifecycle](#lifecycle).

**Different modes (fast iteration vs full-stack)**

- Two profiles, one default: `profiles:`. See [profiles](#profiles).

**`lich validate` is failing**

- See [common validate errors](#common-validate-errors).

---

## Top-level structure

<!-- @include: ./_generated/yaml-fields.md#top-level -->

Minimum viable yaml: `version` plus either `services` or `owned`. Usually both.

```yaml
version: "1"
owned:
  api:
    cmd: bun run dev
```

That's a complete, valid yaml. Everything else is incremental.

**`sandbox`** routes the entire stack into a Tart microVM with warm-fork. The first `lich up` cold-boots and bakes a snapshot; every subsequent up (in any worktree, until `bake_inputs` content changes) clones the snapshot in ~14s. macOS Apple Silicon only — Tart requires Apple Virtualization.framework. Requires a one-time `bash packages/lich/scripts/build-sandbox-image.sh` to build the local `lich-sandbox-base` image. Minimum block:

```yaml
runtime:
  sandbox:
    backend: tart                   # only supported backend in v0
    image: lich-sandbox-base
    warm_fork: true
    bake_inputs:                    # required; ≥1 entry, content-addressed
      - "lich.yaml"
      - "bun.lock"
```

See `sandbox-warm-fork.md` (in the agent skill bundle) for the full surface: when to suggest sandbox during instrumentation, the prerequisite install steps, what to put in `bake_inputs`, how lifecycle hooks bake into the golden, the `lich sandbox` subcommand surface, and the common gotchas (first up is slow, `node_modules` lives in the VM, macOS-only).

---

## `services` (compose)

Each entry is a docker-compose service. Lich generates a per-stack `compose.override.yaml` with allocated ports plus env injection.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - { container_port: 5432, published_env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp
    tmpfs:
      - /var/lib/postgresql/data    # in-RAM data dir; gone on `lich down`
    volumes:
      - ./local-data:/var/lib/postgresql/data    # alternative: persisted to disk
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d myapp"]
      interval: 1s
      timeout: 1s
      retries: 30
    depends_on: [other-service]
```

<!-- @include: ./_generated/yaml-fields.md#services -->

### Port shapes

`ports:` accepts two forms: a list (compose-spec passthrough) or a keyed map (logical-name lookup). Both accept the same two entry shapes:

- **Scalar**: `5432` is shorthand for "publish container port 5432, no env var injection." Use when lich's proxy, dashboard, or interpolation consumes the port instead of an env var.
- **Block**: `{ container_port: 5432, published_env: POSTGRES_HOST_PORT }` publishes the container port AND injects the allocated host port as the named env var. Optionally pin the host side with `host_port: <N>`.

A bare `{ container_port: 5432 }` block (no `published_env`) is rejected. Use the scalar shorthand instead. One way to say each thing.

```yaml
ports:
  - 5432                                                # scalar in list shape
  - { container_port: 5432, published_env: PG_PORT }    # block in list shape

# keyed shape (multi-port logical names)
ports:
  http: 3000                                            # scalar
  admin:                                                # block
    container_port: 3001
    published_env: ADMIN_PORT
```

### Key points

- `ports.published_env` is the env var lich exposes **inside the container**. The actual host port is dynamic, allocated by lich per stack.
- Use `tmpfs` for dev databases you want gone on tear-down. Use `volumes` for persisted state.
- `healthcheck` lets `depends_on` block until the service is actually ready, not just running. Skip for stateless services.
- Multi-port: each entry in `ports:` gets its own `published_env` name. Reference them via `host_port_<idx>` (0-indexed, for array-form ports) or via `${services.<name>.ports.<key>}` for the Record-form, where `<key>` is the port-key in the `ports:` map, **not** the `published_env:` field name.

### Allowed compose-spec passthroughs

In v1: `image`, `environment`, `volumes`, `tmpfs`, `healthcheck`, `depends_on`, `networks`, `profiles`.

Anything else (`command`, `entrypoint`, `working_dir`, `user`, `restart`, `build`, etc.) is rejected by `lich validate`. The schema is closed (`additionalProperties: false`), so unknown keys surface as errors. If you need fields beyond this list, write them into a sibling `compose.yaml` and point at it via `compose_file:` / `service:` instead of inlining.

---

## `owned` (host processes)

Host processes lich starts directly. Logs are captured to `<LICH_HOME>/stacks/<id>/logs/<service>.log`.

```yaml
owned:
  api:
    cmd: bun run dev               # required; runs in a shell
    cwd: apps/api                  # optional; relative to repo root, default = root
    port: { published_env: PORT }  # optional; lich allocates, injects as process.env.PORT
    ports:                         # multi-port shape (alternative to `port:`)
      api: { published_env: API_PORT }
      metrics: { published_env: METRICS_PORT }
    # oneshot: true                # for CLI launchers that exit after spawning (see "One-shot launchers" below)
    # stop_cmd: "supabase stop"    # paired with oneshot (see "One-shot launchers" below)
    env:
      FOO: bar                     # service-scoped env (merges with top-level `env:`)
    env_files:                     # optional; service-scoped dotenv files (merges with top-level)
      - .env.api
    env_from:                      # optional; service-scoped shell-out (merges with top-level; per-service wins)
      - cmd: infisical export --env=dev --path=/api --format=dotenv
        format: dotenv
    ready_when:
      http_get: /health            # 200 OK from this path = ready
      timeout: 30s                 # how long to wait before giving up
    fail_when:
      log_match: "EADDRINUSE|Cannot find module"   # regex; matching log = hard fail (short-circuits ready_when)
    depends_on: [other-owned-or-compose]
```

<!-- @include: ./_generated/yaml-fields.md#owned -->

### Common patterns

- **HTTP service**: `cmd: <dev server>` plus `port:` plus `ready_when.http_get: /health` (or `/` for SPAs).
- **CLI background worker**: `cmd: <worker>` plus `ready_when.log_match: "Worker started"`.
- **External CLI launcher (supabase, dbmate, etc.)**: `oneshot: true` plus `stop_cmd:`. The launcher exits after spawning side-effects; lich tracks the side-effect for teardown. See [One-shot launchers](#one-shot-launchers) below.
- **One-shot setup script (migrations, seeds)**: prefer `lifecycle.after_up` for plain scripts that don't leave a long-lived side-effect behind.

### `ready_when`

Pick one of:

- `http_get: <path>`: most common. Path is relative to the service's `port`.
- `log_match: <regex>`: for services that don't expose HTTP (workers, queues). Watches the log for a matching line.
- `cmd: <shell command>`: runs the command periodically. Exit 0 = ready.
- `tcp: "<host>:<port>"`: TCP-level readiness. Succeeds when a connection to that host:port succeeds; no HTTP body check. Interpolation works here, so the typical shape is `tcp: "localhost:${owned.<name>.ports.<key>}"`.
- `capture: <regex>`: for tunnel and ephemeral-URL services that print their URL once. The captured value becomes available as `${owned.<name>.captured.<key>}`.

`timeout:` sets how long to wait before giving up. Defaults to 60s; the stack-wide default is configurable via `runtime.ready_when_timeout`.

### `fail_when`

Escape hatch for services that produce a "won't recover" signal. Without it, `ready_when` waits the full timeout even when the process is doomed.

```yaml
fail_when:
  log_match: "EADDRINUSE|Cannot find module|FATAL"
```

A matching log line short-circuits `ready_when` and fails the stack immediately.

### One-shot launchers

Some "services" are actually CLI launchers (`supabase start`, `dbmate up`, `prisma migrate dev`, a container orchestrator-of-orchestrators) where the command spawns side-effects (containers, daemons, files) and then exits. Modeling these as long-lived owned services fails: lich treats the exit as a crash. Modeling them as `lifecycle.before_up` works for the start side but leaves the side-effects orphaned on `lich down`, or worse, leaks them across runs.

Lich supports them with the `oneshot` plus `stop_cmd` pair:

```yaml
owned:
  supabase:
    cmd: supabase start            # launcher; exits after spawning its containers
    oneshot: true                  # lich runs cmd to completion (non-zero = fail); doesn't track as running
    stop_cmd: supabase stop        # invoked on `lich down` / `lich nuke` to clean up the side-effect
    env:
      SUPABASE_PROJECT_ID: "myapp-${worktree.id}"   # per-worktree namespace; see `${worktree.id}` below
    ports:
      api: { published_env: SUPABASE_API_PORT }
      db:  { published_env: SUPABASE_DB_PORT }
    ready_when:
      tcp: "localhost:${owned.supabase.ports.api}"   # succeed when the launcher's containers are listening
      timeout: 120s
```

**Semantics:**

- `oneshot: true`: lich runs `cmd` synchronously and waits for exit. Non-zero exit fails `lich up` with the log tail. After exit, lich still considers the service "up" so downstream services with `depends_on: [<this>]` proceed.
- `stop_cmd: "..."`: invoked by `lich down` and `lich nuke` with the same env and cwd the `cmd` ran with. So `supabase stop` sees the same `SUPABASE_PROJECT_ID`, finds the containers it spawned, and tears them down. Without `stop_cmd`, oneshot side-effects leak.
- `ports:` still works. Lich allocates host ports up-front (during stack definition, step 4 of `lich up`) and injects them as env vars. The launcher reads them and configures its spawned services accordingly. This is what makes oneshot launchers safe to run in multiple worktrees in parallel.
- `ready_when:` runs after the cmd exits, against the side-effect. Typically `tcp:` against one of the allocated ports.

**When to use `oneshot` vs `lifecycle.after_up`:**

- `oneshot` plus `stop_cmd` when there's a side-effect to tear down later (containers, daemons, allocated cloud resources). Lich tracks it; `lich down` reverses it.
- `lifecycle.after_up` for fire-and-forget scripts (run a migration, seed the DB). Nothing to tear down.

See `references/external-cli-services.md` for the full worked example.

### Glob-based discovery (`discover:`)

For monorepos with N near-identical owned services (typically 3+ workers, processors, or similar processes that all share the same shape but differ by the file they run), a single `discover:` block expands at parse time into N synthetic owned services, each with its own logs, restart, and state.

**When to use:**

- 3+ owned services with the same shape (same `ready_when`, same `fail_when`, same `env`, same `depends_on`) that differ only in the file or command they invoke.
- The set is file-driven. Adding a new file under `workers/` should automatically pick it up without yaml edits.
- You want per-service logs, restart, and state, not the lossy `concurrently`-style "one entry runs all of them" workaround.

**When NOT to use:**

- 1 or 2 services. Write them out by hand; the indirection costs more than it saves.
- The services have meaningfully different shapes (different `ready_when` per worker, different ports per worker). `discover:` applies the parent's fields verbatim to every instance, so heterogeneous shapes don't fit.
- The set isn't file-driven (e.g. you want services named `worker-1`, `worker-2`, `worker-3` not tied to any file).

**Canonical shape** (an 11-worker monorepo where each worker is one `*TemporalWorker.ts` file; pre-discover, ~110 lines of yaml; post-discover, ~10):

```yaml
owned:
  workers:
    discover:
      glob: "src/temporal/workers/*TemporalWorker.ts"
      name_template: "${basename_no_ext | strip_suffix:TemporalWorker | kebab}-worker"
      cmd_template: "pnpm exec nodemon -r ./tsconfigPathsDist.js dist/temporal/workers/${basename_no_ext}.js"
      cwd: apps/workers
    ready_when:
      log_match: "Temporal worker created successfully|state: 'RUNNING'"
    fail_when:
      log_match: "FATAL|UnhandledPromiseRejection"
```

Expands at parse time to:

```yaml
owned:
  cleanup-worker:
    cmd: pnpm exec nodemon -r ./tsconfigPathsDist.js dist/temporal/workers/CleanupTemporalWorker.js
    cwd: apps/workers
    ready_when: { log_match: "Temporal worker created successfully|state: 'RUNNING'" }
    fail_when: { log_match: "FATAL|UnhandledPromiseRejection" }
  email-worker:
    cmd: pnpm exec nodemon -r ./tsconfigPathsDist.js dist/temporal/workers/EmailTemporalWorker.js
    cwd: apps/workers
    ready_when: { log_match: "Temporal worker created successfully|state: 'RUNNING'" }
    fail_when: { log_match: "FATAL|UnhandledPromiseRejection" }
  # ...one synthetic entry per matched file, sorted alphabetically by materialized name
```

Each synthetic service is identical to a hand-written one: own log file, own restart state, own `depends_on` graph node, own dashboard tile.

**Mutual exclusivity:** an entry with `discover:` MUST NOT set `cmd:` at the entry root. The per-instance command lives on `discover.cmd_template`. The schema rejects the combination at `lich validate` time.

**Fields:**

| Field | Required | Purpose |
|-------|----------|---------|
| `discover.glob` | yes | Micromatch-style pattern. Relative to `discover.cwd`, or parent's `cwd` if unset, or the config dir as a last resort. |
| `discover.name_template` | yes | Template producing the synthetic service name. See template grammar below. |
| `discover.cmd_template` | yes | Template producing the per-instance shell command. Same grammar. |
| `discover.cwd` | no | Glob root and per-instance working dir. Defaults to the parent entry's `cwd`. |

**Template grammar:** `${var}` or `${var | filter1 | filter2:arg}`. Pipeline syntax: filters apply left to right.

| Var | Yields |
|-----|--------|
| `basename` | Full filename with extension (`EmailTemporalWorker.ts`) |
| `basename_no_ext` | Filename without the final extension (`EmailTemporalWorker`) |
| `dirname` | Parent dir relative to the glob root (`""` for files at the root) |

| Filter | Effect |
|--------|--------|
| `kebab` | Lowercase plus non-alphanumeric collapsed to `-`. PascalCase / camelCase boundaries become separators (`EmailWorker` becomes `email-worker`). |
| `snake` | Lowercase plus non-alphanumeric collapsed to `_`. |
| `strip_suffix:X` | Removes trailing `X` if present (no-op otherwise). |
| `strip_prefix:X` | Removes leading `X` if present (no-op otherwise). |

Unknown vars, filters, or unterminated `${` blocks fail at `lich validate` with a "did you mean" hint when a near-match exists.

**Determinism:** matched files are sorted alphabetically by *materialized* name before being inserted into the parsed config, so `lich up` always starts the services in the same order across machines, git checkouts, and glob traversal quirks.

**Name collisions:** the parse layer rejects a synthetic name that collides with another `owned.<name>` (whether hand-written or produced by another discover block). Rename the colliding entry or adjust the `name_template` to disambiguate.

---

## `env` + interpolation

Lich resolves env vars from multiple sources and exposes the merged result to every service. The most common shape is loading from a `.env` file plus a few interpolated values that wire services together.

### `env`

Literal values declared inline. Top-level `env:` is exposed to **every** owned service's process env.

```yaml
env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
  API_URL: "http://localhost:${owned.api.port}"
  CANARY: "from-top-level"
```

Per-service `env:` (under `owned.<name>.env:`) merges with the top-level; per-service wins on collisions.

**Unsetting an inherited variable (`null`).** Set a value to `null` to remove the key from the resolved env. Useful for scrubbing a value pulled in by `env_from`, `env_files`, or the parent shell:

```yaml
env:
  PORT: "3000"
  NEXT_PUBLIC_AUTH_SUPABASE_URL: null   # explicit unset; spawned services see no key (NOT empty string)
```

`null` wins after all other layering. It applies to `process.env`, `env_from`, `env_files`, top-level / profile / per-service `env` literals, and `env_groups`. Per-service `env: { FOO: null }` removes FOO for that service only; siblings still see whatever lower layers set. The drop happens before interpolation, so a nulled value with a `${...}` reference doesn't surface "unresolved reference" errors. Empty string is NOT equivalent: `null` makes `process.env.FOO === undefined` (JS) / `[ -z "${FOO+x}" ]` true (bash) rather than `""`.

### `env_files`

Dotenv files loaded into the stack env. The common pattern is one gitignored `.env` at the repo root plus optional overrides:

```yaml
env_files:
  - .env
  - .env.local
```

Multiple files merge in declared order; later files override earlier ones. Missing files are silently skipped, so listing `.env.local` even though only `.env` exists is fine.

**Worktree behavior.** Each git worktree resolves `env_files` against the worktree containing `lich.yaml` first. If a relative path isn't found there, lich falls back to the same path in the main worktree (the directory containing the shared `.git` dir). So you can keep one `.env` at your repo root and every `git worktree add`'d branch picks it up automatically; no symlinks, no copying.

Resolution rules:

- Relative path found in the current worktree: use that. Current worktree always wins.
- Relative path not in current worktree but exists in the main worktree: use the main worktree's copy.
- Relative path not in either: silently skipped.
- Absolute path: used as-is; never resolved against the fallback.

If you want worktree-specific overrides, declare both files and put the override-only one in the local worktree:

```yaml
env_files:
  - .env          # lives in main checkout; loaded by every worktree
  - .env.local    # if it exists in this worktree, overrides .env values
```

Per-service `env_files:` (under `owned.<name>.env_files:`) merges with the top-level.

### `env_from`

Shell-out sources for stack env. Two forms:

**Command form** for secret-manager CLIs (Infisical, 1Password, Doppler, vault) or anything that prints `KEY=VALUE` lines or flat JSON to stdout:

```yaml
env_from:
  - cmd: "infisical export --env=dev --format=dotenv"
    format: dotenv          # or: json (for a flat object). Defaults to dotenv.
```

The cmd runs every `lich up`. Stdout is parsed in the chosen format, and the result merges into the stack env. More examples:

```yaml
env_from:
  - cmd: "op inject -i .env.tpl"             # 1Password CLI
    format: dotenv
  - cmd: "vault kv get -format=json -field=data secret/myapp/dev"
    format: json
  - cmd: "aws secretsmanager get-secret-value --secret-id myapp/dev --query SecretString --output text"
    format: json
```

**Pass-through form** for inheriting a named env var from the parent shell. Useful for `GITHUB_TOKEN` or other dev-machine credentials you don't want to commit:

```yaml
env_from:
  - GITHUB_TOKEN
  - NPM_TOKEN
```

Per-service `env_from:` (under `owned.<name>.env_from:`) merges with the top-level; per-service wins on collisions. Use the per-service form when different services pull from different secret-manager paths (e.g. `infisical export --path=/web` for the web app, `--path=/services` for the api). Siblings without their own `env_from:` see only top-level vars; scoped values do NOT leak across services.

### Precedence

When the same key appears in multiple places, later layers win. Within a single service the order is:

1. `process.env` (the shell that invoked `lich up`)
2. `env_from:` (cmd output or pass-through)
3. `env_files:` (dotenv files)
4. `env:` (literal values in `lich.yaml`)
5. Profile-scoped equivalents (when a profile is active)
6. Per-service equivalents

So an inline per-service `env:` value always overrides one from a `.env` file or a secret CLI; handy for pinning a value during local debugging without touching the source.

**There is no `${env.VAR}` form for inheriting from the host shell.** The host process's env is automatically inherited at the lowest precedence layer, so a key already set in your shell is visible to spawned services unless a higher precedence layer overrides it. To reference such a value inside another env entry, use `$VAR` shell expansion inside the service's `cmd:` (since `cmd` is a shell line), or load it via top-level `env_files:` or `env_from:` so it participates in the lich env pipeline.

### Interpolation

Lich evaluates `${...}` expressions in yaml values at well-defined points in the up sequence. Use interpolation to wire dynamic values (allocated ports, worktree identity, captured values) into env vars, commands, and lifecycle hook entries.

**Where interpolation works:**

- `env:` values (top-level and per-service)
- `cmd:` strings (services, lifecycle hooks, custom commands)
- `stop_cmd:` strings
- Any string value in the yaml (lich resolves recursively)

**Evaluation timing:**

- Most keys are resolved AT UP TIME, after port allocation has completed for all services.
- `worktree.*` keys are resolved immediately, before any service starts.
- `owned.<name>.captured.<key>` keys are resolved as log captures complete. Each service starts as soon as its own dependencies are ready, so declare `depends_on: [<name>]` on the reading service to guarantee the capture is available before it starts — without that edge the value may still be unset.

**Port allocation timing.** Ports are allocated **once, up front** during step 4 of `lich up`, before any service (compose, owned, or oneshot launcher) starts. That means `${owned.X.port}` / `${owned.X.ports.<key>}` are already resolved to real integers by the time another service's `cmd` or env runs. This is what lets oneshot launchers (supabase et al.) configure their spawned services with lich-allocated ports without pinning anything.

**Valid keys:**

<!-- @include: ./_generated/interpolation-keys.md -->

**Common patterns.**

Inject the allocated postgres host port into an API service's `DATABASE_URL`:

```yaml
services:
  postgres:
    ports:
      - { container_port: 5432, published_env: POSTGRES_HOST_PORT }
owned:
  api:
    env:
      DATABASE_URL: "postgres://postgres@localhost:${services.postgres.host_port}/app"
```

Use the worktree name in service identifiers so two parallel worktrees don't collide:

```yaml
services:
  redis:
    image: redis:7
    environment:
      REDIS_PREFIX: "lich-${worktree.name}"
```

Use `${worktree.id}` for per-worktree namespacing of external resources (compose project names, supabase project_id, KV namespaces, etc.):

```yaml
owned:
  supabase:
    env:
      SUPABASE_PROJECT_ID: "myapp-${worktree.id}"
```

---

## `lifecycle`

Hooks at stack boundaries. Top-level hooks live in four places (`before_up`, `after_up`, `before_down`, `after_down`); per-service hooks live in three more (`before_start`, `after_ready`, `before_down`, under `services.<name>.lifecycle` or `owned.<name>.lifecycle`). `after_up` is the one users reach for most.

```yaml
lifecycle:
  before_up:                        # runs before any service starts
    - ./scripts/check-prereqs.sh
  after_up:                         # runs once all services are ready
    - psql "$DATABASE_URL" -f db/migrations/01_init.sql
    - cmd: ./scripts/seed.sh
      env_group: stack-plus-test    # optional; use a named env bundle
  before_down:                      # runs before any service stops
    - ./scripts/dump-state.sh
```

**Top-level phases** (under `lifecycle:` at the root):

<!-- @include: ./_generated/yaml-fields.md#lifecycle-top-level -->

**Per-service phases** (under `services.<name>.lifecycle:` or `owned.<name>.lifecycle:`):

<!-- @include: ./_generated/yaml-fields.md#lifecycle-per-service -->

Entries are either a string (the cmd) or an object: `{ cmd: ..., env_group?: ..., cwd?: ... }`.

Which phase to use:

- `after_up`: migrations, seeds, anything that needs services running.
- `before_down`: dump state from a live service before it stops.
- `after_down`: external resource cleanup (drop a supabase workdir, remove per-stack scratch dirs, delete tmp socket files) that's only safe once services are fully torn down.
- `before_up`: prereq checks, version pins, anything that should block startup if it fails.

Hook output is captured to `<LICH_HOME>/stacks/<id>/logs/<phase>.log` (one file per phase, all entries appended with command-header separators) and surfaced inline on completion. Use `lich logs before_up` (or any phase name) to inspect hook output after the fact. The full combined stdout+stderr is capped at ~1 MB per phase.

**Env contract.** `before_down` and `after_down` see the same env as `before_up` / `after_up`: top-level `env:`, profile-scoped `env:`, `env_from:`, `env_files:`, port-derived interpolation, and `null` unsets are all honored. On the down path the env is reconstructed from `state.json` (the snapshot of what the stack actually ran with), so port allocations and captured values from the up survive into teardown. A `supabase stop --workdir "$SUPABASE_WORKDIR"` in `after_down` sees the same `SUPABASE_WORKDIR` that `lich up` set.

**Profile-scoped lifecycle MERGES with top-level; it does NOT replace.** A profile that declares `lifecycle.after_up: [pnpm db:seed]` runs `pnpm db:seed` AFTER any top-level `after_up` entries; it does not skip them. See [profile lifecycle merge](#profile-lifecycle-merge) below.

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
    extends: dev                    # inherits dev's services, owned, lifecycle
    env:
      DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp_test"
```

<!-- @include: ./_generated/yaml-fields.md#profiles -->

`lich up <profile-name>` switches between them. Top-level `services:` / `owned:` / `env:` / `lifecycle:` define the **superset**; profiles pick subsets and override.

**When to use profiles:** the user wants different startup modes (fast iteration vs full-stack) or different env values (test DB vs dev DB) from one yaml.

**When NOT to use profiles:** the user has one way they always run the stack. Profiles add maintenance overhead.

### Profile lifecycle merge

Profile-scoped `lifecycle:` blocks **merge** with the top-level `lifecycle:` block. They do NOT replace. Same model as `env:`, `services:`, `owned:`: top-level defines the baseline; the active profile adds to it.

Merge order:

| Phase | Order |
|-------|-------|
| `before_up` | top-level entries, then profile entries |
| `after_up` | top-level entries, then profile entries |
| `before_down` | profile entries, then top-level entries (LIFO: undo specialization before tearing down base) |
| `after_down` | profile entries, then top-level entries (LIFO: same rule as `before_down`) |

There is no `!replace` marker, no `lifecycle_replace:` key. If you want a profile to skip a top-level entry, gate the entry on `$LICH_PROFILE`:

```yaml
lifecycle:
  before_up:
    - '[ "$LICH_PROFILE" = "fullstack" ] && pnpm db:reset || true'
```

**Worked example.** Two profiles share an `npm install` bootstrap and a stack-wide `codegen`; only one runs a DB seed. Do NOT duplicate the shared steps into each profile:

```yaml
lifecycle:
  before_up:
    - npm install                # always runs first
  after_up:
    - pnpm codegen               # always runs first
  before_down:
    - ./scripts/dump-state.sh

profiles:
  fullstack:
    default: true
    services: [postgres]
    owned: [api, web]
    lifecycle:
      after_up:
        - pnpm db:migrate        # appended AFTER pnpm codegen
        - pnpm db:seed
      before_down:
        - pnpm db:dump           # runs BEFORE ./scripts/dump-state.sh

  lite:
    owned: [api, web]
    # No lifecycle block: inherits the top-level entries as-is.
```

Resolved phases for `lich up` (default = `fullstack`):

- `before_up`: `npm install`
- `after_up`: `pnpm codegen`, `pnpm db:migrate`, `pnpm db:seed`
- `lich down` `before_down`: `pnpm db:dump`, `./scripts/dump-state.sh`

For `lich up lite`:

- `before_up`: `npm install`
- `after_up`: `pnpm codegen`
- `lich down` `before_down`: `./scripts/dump-state.sh`

**Common mistake.** Don't copy top-level entries into every profile to "be safe." They already run; the profile's block only adds.

**Inside an `extends` chain.** A child profile's lifecycle is composed with its parent profiles the same way (parent first, then child, with LIFO for `before_down`), THEN the merged result is appended to the top-level at the call site.

---

## `env_groups`

Named env-var bundles for use with `lich exec` and `lifecycle` hooks. Three patterns:

```yaml
env_groups:
  # Pattern A: standalone (only these vars, no inheritance)
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
  # `stack` is implicit. It contains top-level `env:` plus per-service `port:` / `host_port` exposures.
```

<!-- @include: ./_generated/yaml-fields.md#env-groups -->

Use these for `lich exec --env-group <name> <cmd>` or `lifecycle.after_up[].env_group:`.

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
    env_group: isolated-tools       # optional; use a named env bundle instead of stack env
    help: |
      Diagnostic: print the env vars under the `isolated-tools` group.
```

<!-- @include: ./_generated/yaml-fields.md#commands -->

User runs `lich db:psql` and gets the stack's resolved env loaded into the process. `lich <name> --help` prints the `help:` text.

---

## `runtime`

Engine knobs: compose CLI selection, proxy port pin, default ready-when timeout, cascade-kill behavior. All fields optional and defaults are usually correct.

```yaml
runtime:
  compose_cli: auto          # auto | docker | podman | nerdctl
  proxy_port: 3300           # daemon's reverse-proxy port (default 3300; override via env LICH_PROXY_PORT)
  ready_when_timeout: 180s   # stack-wide default for every owned service's ready_when.timeout
  kill_others_on_fail: true  # cascade-kill siblings on startup failure (default true)
```

<!-- @include: ./_generated/yaml-fields.md#runtime -->

`compose_cli: auto` detects what's installed and is almost always correct. Only pin `proxy_port` if you need stable friendly URLs across teammates (e.g. for webhook URLs hardcoded in third-party tools).

**`ready_when_timeout`** is the per-stack default for owned services' `ready_when.timeout`. Useful when many services share the same long timeout (e.g. 11 workers each needing 360s); set it once at the runtime level instead of duplicating it on every service. Same duration grammar as `ready_when.timeout` (`30s`, `2m`, `1h`, or a raw integer ms). Per-service `ready_when.timeout` overrides this; when both are unset the built-in 60s baseline applies.

```yaml
runtime:
  ready_when_timeout: 180s   # default for every owned service
owned:
  api:
    cmd: bun run dev
    ready_when:
      http_get: /health      # no timeout here; inherits 180s
  postgres_init:
    cmd: ./scripts/wait-for-pg.sh
    ready_when:
      cmd: pg_isready
      timeout: 30s           # explicit override (this one needs less)
```

**`kill_others_on_fail`** controls the cascade-kill behavior when one service fails during `lich up`'s startup race. Defaults to `true` (matches bash `concurrently --kill-others-on-fail`): a failed service tears down its still-running siblings via SIGTERM->SIGKILL (owned) plus `compose down` (compose) so you don't end up with zombies. Set `false` to keep siblings running on a startup failure (the user has to `lich down` to clean up). Only fires during startup; once `lich up` reaches the running state, post-startup failures are handled by the supervisor, dashboard, and `lich logs --failed` surface instead.

---

## Common validate errors

### "unknown reference path: ${services.X.host_port}"

The named service doesn't exist in `services:`. Check spelling. Or the service uses multi-port and you need `host_port_<idx>` or `ports.<name>`.

### "owned service X has no `cmd`"

`cmd:` is required for every owned service.

### "duplicate port allocation: X conflicts with Y"

Two services declare the same `port: { published_env: SAME_VAR }` value. Each `published_env:` name must be unique across the stack.

### "profile X extends Y but Y is not defined"

`extends:` references a missing profile. Check spelling, or define the parent first.

### "service X in profile Y is not in top-level `services` or `owned`"

Profile entries reference services that don't exist in the superset. Add them to top-level first.

### "interpolation cycle: ${owned.a.port} -> ${owned.b.port} -> ${owned.a.port}"

Two services depend on each other's port via env. Break the cycle (use `depends_on` for ordering, but not for env wiring both ways).

### "compose service X has no `image` ..." (from docker/podman at runtime, not validate)

Lich's schema doesn't require `image:` to be present, but compose itself rejects services without an image (or a build context) at start time. `build:` is NOT in lich's allowed compose-spec passthrough set; if you need to build an image, write the build block to a sibling `compose.yaml` and reference it from `lich.yaml` via `compose_file:` / `service:`, or build the image out-of-band in a `lifecycle.before_up` hook.

### "`lifecycle.after_up[N]` references env_group X that doesn't exist"

Define the group in top-level `env_groups:`.

### "fail_when.log_match is not a valid regex"

The regex doesn't compile. Test it: `echo "test" | grep -E "<pattern>"` to debug.

### "additionalProperties: 'port_open' is not allowed" (or similar) on `ready_when`

There is no `port_open` key. The TCP-level readiness probe is `tcp: "<host>:<port>"`. Rewrite:

```yaml
ready_when:
  port_open: 5432           # WRONG: not a real key
```

```yaml
ready_when:
  tcp: "localhost:5432"     # right
  # or, with interpolation against an allocated port:
  tcp: "localhost:${services.postgres.host_port}"
```

### "unknown reference path: ${owned.X.ports.SOMETHING}" when SOMETHING looks like an env var

The `<key>` in `${owned.X.ports.<key>}` is the **port-key** from the service's `ports:` map, not the `published_env:` field name. Example:

```yaml
owned:
  supabase:
    ports:
      api: { published_env: SUPABASE_API_PORT }   # port-key is `api`; published_env field is `SUPABASE_API_PORT`
```

Reference it as `${owned.supabase.ports.api}`, NOT `${owned.supabase.ports.SUPABASE_API_PORT}`.

---

## Notes on what lich does NOT support

- `version: "2"` or later. Only `"1"` is supported.
- Per-environment yaml files (e.g. `lich.yaml.production`). Use profiles instead.
- Secret management. Lich doesn't store secrets. Load them via top-level `env_files:` (a gitignored `.env`) or `env_from:` (shell-out to a secret manager like Infisical, 1Password, Doppler). Loaded values become part of the resolved stack env and are referenced inline via shell expansion in `cmd:` lines (e.g. `psql "$DATABASE_URL"`); there's no `${env.VAR}` interpolation form.
- Container image building (`build:` in services). `image:` only. If you have a Dockerfile you want lich to build, run `docker buildx build` in a `lifecycle.before_up` hook.
