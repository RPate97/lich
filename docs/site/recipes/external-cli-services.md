# External CLI services (supabase, dbmate, prisma migrate, etc.)

When the stack you're instrumenting depends on a CLI that **spawns its own side-effects** (`supabase start` brings up ~10 containers), `localstack start` runs AWS simulation via docker. This type of service fits neither standard `owned` services nor `before_up`.

The right shape is a **oneshot owned service** with a `stop_cmd` for teardown and `${worktree.id}` for per-worktree namespacing where necessary. This file walks through why, with the canonical supabase example.

## The pattern

```yaml
owned:
  supabase:
    cmd: supabase start
    cwd: .
    oneshot: true
    stop_cmd: supabase stop
    env:
      SUPABASE_PROJECT_ID: "myapp-${worktree.id}"
      SUPABASE_AUTH_SITE_URL: "http://localhost:${owned.web.port}"

    ports:
      api:    { published_env: SUPABASE_API_PORT }
      db:     { published_env: SUPABASE_DB_PORT }
      studio: { published_env: SUPABASE_STUDIO_PORT }

    ready_when:
      tcp: "localhost:${owned.supabase.ports.api}"
      timeout: 120s

  web:
    cmd: pnpm dev
    cwd: apps/web
    port: { published_env: PORT }
    depends_on: [supabase]

env:
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:${owned.supabase.ports.api}"
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${owned.supabase.ports.db}/postgres"
```

This is sufficient if your stack only calls `supabase start` and `supabase stop`. If you also call other supabase CLI subcommands — `supabase db reset`, `supabase gen types`, `supabase migration up` — read the next section before proceeding.

## The env-vs-config-file split

The pattern above looks complete: lich allocates a port, sets `SUPABASE_API_PORT=<that-port>`, `supabase start` reads it, the API container listens on it. Same for `SUPABASE_DB_PORT` and `SUPABASE_STUDIO_PORT`. Same for `SUPABASE_PROJECT_ID`. Naively, every supabase subcommand would just read those env vars and Do The Right Thing.

It doesn't. The supabase CLI splits its config sources by subcommand:

- **`supabase start` and `supabase stop`** honor the `SUPABASE_*_PORT` and `SUPABASE_PROJECT_ID` env vars at runtime. So `start` writes the lich-allocated ports into the containers it spawns, and `stop` targets the right project.
- **`supabase db reset`, `supabase gen types`, `supabase migration up`, `supabase functions serve`, etc.** ignore those env vars. They read everything — `project_id`, every port — straight out of `supabase/config.toml`.

The default `supabase/config.toml` ships with hardcoded `port = 54321` (api), `54322` (db), `54323` (studio) and a static `project_id`. So with the naive recipe — set env vars, leave `supabase/config.toml` alone — this happens:

- Worktree A: `lich up` allocates port 51000 for api. `SUPABASE_API_PORT=51000`. `supabase start` brings up an api container on `:51000`. So far so good.
- Worktree A: `supabase db reset` reads `supabase/config.toml`, sees `port = 54322` for the db, tries to connect to `localhost:54322`. There's no container there — supabase actually spawned the db on the lich-allocated db port (say 51001). The reset fails (or, worse, hits a stale container from a previous run that happened to be on 54322).
- Worktree B: spins up in parallel. Allocates a different api port (say 52000). But `supabase db reset` from worktree B *also* reads `supabase/config.toml` and *also* targets `localhost:54322`. Both worktrees collide on the same hardcoded port for every non-`start` subcommand.

Templating only `project_id` into a per-worktree config (a common partial fix) makes `supabase db reset` find the right containers by name — but it still tries to connect to the hardcoded ports in the file, which aren't the lich-allocated ports the containers actually listen on. The fix has to do both: template the project_id AND every port the wrapped tool reads from config.

The shape:

1. **Allocate every port the wrapped tool uses** in `ports:` (api, db, studio for Supabase — add `inbucket`, `analytics`, `pooler` if you use them).
2. **Render a per-worktree `config.toml`** in a `before_up` hook with `project_id` AND every port substituted from the env vars lich populated.
3. **Pass `--workdir <per-worktree-dir>` to every supabase invocation** — `start`, `stop`, `db reset`, `gen types`, custom commands.

The full yaml + `before_up` hook is in "Full per-worktree isolation: templated workdir" below.

## Why each piece is there

### `oneshot: true`

`supabase start` is a launcher: it spawns ~10 docker containers and then exits. If you modeled it as a regular long-lived owned service, lich would see the exit and report a crash. `oneshot: true` tells lich to **run the cmd to completion, treat non-zero exit as a hard failure (with the log tail), and otherwise consider the service "up"** so downstream `depends_on:` proceeds.

### `stop_cmd: supabase stop`

Without this, the side-effect leaks. `lich down` would stop tracking the service but the docker containers `supabase start` spawned would keep running. On the next `lich up`, port allocation might clash. After a week of `up`/`down` cycles you'd have a graveyard of orphan supabase stacks.

`stop_cmd` runs with the **same env and cwd** the original `cmd` ran with. That's load-bearing: `supabase stop` finds the containers it spawned by reading `SUPABASE_PROJECT_ID` from the env. Without env preservation, `supabase stop` would target a default project_id and leave the per-worktree containers running.

### `owned_containers` — sweep stop_cmd misses

`stop_cmd` is at the mercy of the wrapped CLI. If the CLI's `stop` subcommand misses a container — stuck in restart-backoff, race with a slow healthcheck, edge case in the CLI itself — and the container carries Docker's `restart: always` policy, the container survives `lich down` indefinitely.

Add `owned_containers` so lich can sweep stragglers after `stop_cmd` returns:

```yaml
owned:
  supabase:
    cmd: supabase start
    oneshot: true
    stop_cmd: supabase stop
    owned_containers:
      label: "com.supabase.cli.project=myapp-${worktree.id}"
```

After `stop_cmd` runs (success or failure), lich runs `docker ps -aq --filter label=<value>` and `docker rm -f` every match. Pick exactly one of `label` (preferred; most reliable) or `name_pattern` (`supabase_*_${worktree.id}`-style globs, less precise but useful when the wrapped CLI doesn't set labels). Both fields support `${...}` interpolation so per-worktree filters work the same way `SUPABASE_PROJECT_ID` does.

### `${worktree.id}` in `SUPABASE_PROJECT_ID`

The supabase CLI uses `project_id` to name the docker containers it spawns (`supabase_db_${PROJECT_ID}`, `supabase_api_${PROJECT_ID}`, etc.). If you have two worktrees of the same project running side-by-side and both default to `project_id: myapp`, the second `supabase start` will collide on container names and fail (or, worse, silently attach to the first worktree's containers).

`${worktree.id}` is a stable 12-hex-char hash of the worktree's absolute path. Same worktree path → same id forever. Different worktrees → different ids. So `myapp-${worktree.id}` becomes `myapp-a4e87c8572d0` in one worktree and `myapp-b91d3e6f1c00` in another, and the two stacks coexist.

This pattern works for anything that needs per-instance namespacing: docker compose project names, KV namespaces, S3 prefixes, temporal task queues, etc.

**Important limitation:** `SUPABASE_PROJECT_ID` is honored at runtime by `supabase start` and `supabase stop`, but not by most other supabase subcommands. `supabase db reset`, `supabase gen types`, `supabase migration up`, and similar commands read `project_id` (and every port) directly from `supabase/config.toml`, ignoring the env vars. So with the above yaml, `supabase start` spawns containers named `supabase_db_myapp-a4e87c8572d0` (correct), but a subsequent `supabase db reset` looks for `supabase_db_<config-project-id>` and connects to the hardcoded ports in the file — wrong containers, wrong ports. This is the env-vs-config-file split described above; see "Full per-worktree isolation: templated workdir" below for the fix.

### `ports:` declared up front

Lich allocates host ports during stack definition (step 4 of `lich up`), **before** any service's `cmd` executes. The order of operations is:

1. Parse yaml
2. Resolve profile
3. Build the service graph
4. **Allocate every port declared in `ports:` / `port:` on every service. This produces a complete `port_map: { service.key → integer }` for the stack.**
5. Resolve all `${...}` interpolation against the port_map + worktree context
6. Start services in dependency order (compose first, then owned, with `oneshot:` and `stop_cmd:` semantics applied)

Because of step 4, when `supabase start` finally runs, `${owned.supabase.ports.api}` is already `54321` (or whatever), and the env vars set on the service (`SUPABASE_API_PORT=54321`) propagate to `supabase start`, which writes the right port into the containers it spawns. No port pinning, no shell-script wrapper, no double-`lich up` to discover ports.

### `ready_when.tcp` against the allocated port

Once `supabase start` exits successfully, the containers it spawned are still booting. `ready_when` probes the side-effect — open a TCP connection to the API container's allocated port; succeed when the connection succeeds. `tcp:` is the right probe here (no HTTP route to check yet on cold start). Timeout 120s on first run because supabase pulls a lot of images.

## Upfront port allocation: the load-bearing trick

The reason `SUPABASE_AUTH_SITE_URL: "http://localhost:${owned.web.port}"` works without pinning is that **lich allocates `owned.web.port` before `supabase start` runs**. So:

- `lich up` allocates a port for `web` (say, 53017)
- Resolves the env: `SUPABASE_AUTH_SITE_URL=http://localhost:53017`
- Runs `supabase start` with that env set
- `supabase start` writes `http://localhost:53017` into the auth config and spawns containers
- Lich runs `web` with `PORT=53017`
- Auth links emailed by supabase use port 53017, hit the right web app

Without upfront allocation, this would be circular: web needs to know what port supabase is on, supabase needs to know what port web is on, both want a port from the same allocator. With upfront allocation, both are integers by the time anyone reads them.

## Full per-worktree isolation: templated workdir

If you call any supabase subcommand beyond `start`/`stop`, the env vars aren't enough (see "The env-vs-config-file split" above). The full solution is to give each worktree its own `supabase/config.toml` with the correct `project_id` AND every port baked in, then pass `--workdir <path>` to every supabase invocation so the CLI reads from that workdir rather than the shared `supabase/` directory at the repo root.

The shape:

1. Keep the canonical config at `supabase/config.toml` in the repo (tracked in git, with the default `54321`/`54322`/`54323` ports as written by `supabase init`).
2. On `lich up`, a `before_up` hook renders a per-worktree copy into `.lich/supabase-${worktree.id}/supabase/config.toml`, with `project_id` and every port substituted from the env vars lich allocated.
3. Every supabase invocation — `start`, `stop`, `db reset`, `gen types`, etc. — passes `--workdir .lich/supabase-${worktree.id}`.

```yaml
lifecycle:
  before_up:
    - cmd: |
        set -euo pipefail
        WORKDIR=".lich/supabase-${worktree.id}"
        mkdir -p "$WORKDIR/supabase"
        sed -e "s/^project_id = .*/project_id = \"myapp-${worktree.id}\"/" \
            -e "s/^port = 54321/port = ${SUPABASE_API_PORT}/" \
            -e "s/^port = 54322/port = ${SUPABASE_DB_PORT}/" \
            -e "s/^port = 54323/port = ${SUPABASE_STUDIO_PORT}/" \
          supabase/config.toml > "$WORKDIR/supabase/config.toml"

owned:
  supabase:
    cmd: supabase start --workdir ".lich/supabase-${worktree.id}"
    cwd: .
    oneshot: true
    stop_cmd: supabase stop --workdir ".lich/supabase-${worktree.id}"
    env:
      SUPABASE_AUTH_SITE_URL: "http://localhost:${owned.web.port}"

    ports:
      api:    { published_env: SUPABASE_API_PORT }
      db:     { published_env: SUPABASE_DB_PORT }
      studio: { published_env: SUPABASE_STUDIO_PORT }

    ready_when:
      tcp: "localhost:${owned.supabase.ports.api}"
      timeout: 120s
```

With this setup, the per-worktree `config.toml` has both the right `project_id` and the right ports. `supabase db reset --workdir ".lich/supabase-${worktree.id}"` reads that file, finds the lich-allocated ports, and operates on the right containers. Parallel worktrees no longer collide on any subcommand — `db reset` in worktree A targets worktree A's db port, `db reset` in worktree B targets worktree B's db port, neither touches the other's containers.

A few notes on the sed pattern:

- The `before_up` hook sees the same env lich resolved for the owned service, including the `SUPABASE_*_PORT` vars from `ports:`. That's how the substitution gets the lich-allocated integers.
- Anchor on `^port = 54321` (start-of-line) rather than just `port = 54321` so a `[db.pooler]` section with its own `port = 54329` doesn't get rewritten accidentally. If your stack uses additional supabase services (inbucket, analytics, edge functions), add a `ports:` entry and a `sed -e "s/^port = <default>/port = ${SUPABASE_<KEY>_PORT}/"` line for each.
- Use `>` (overwrite), not `>>` (append) — re-running `lich up` should produce a fresh config from the template each time, not concatenate.

Add `.lich/` to `.gitignore` so the rendered workdirs aren't committed.

**Custom commands:** if the stack exposes `db:reset` or `gen:types` as custom lich commands, pass `--workdir` there too:

```yaml
commands:
  db:reset:
    cmd: supabase db reset --workdir ".lich/supabase-${worktree.id}"
  gen:types:
    cmd: supabase gen types typescript --local --workdir ".lich/supabase-${worktree.id}" > src/types/supabase.ts
```

## When this pattern fits

Use `oneshot: true` + `stop_cmd:` for any external CLI that:

- Spawns side-effects (containers, daemons, files, cloud resources)
- Exits after spawning
- Has a teardown command
- Needs to be reachable by the rest of the stack (so ports matter)

Examples beyond supabase:

- `dbmate up` — migrations. `oneshot: true`, no `stop_cmd` needed (no side-effect to tear down).
- `prisma migrate dev` — migrations + sometimes shadow DB. `oneshot: true`; `stop_cmd: prisma migrate reset --force` if you want clean teardown.
- `temporal server start-dev` — durable execution. Actually long-lived, **not a oneshot**; model as a regular owned service with `ready_when.tcp` instead.
- `localstack start` — local AWS. Has its own daemon; if it spawns and detaches, model as oneshot with `stop_cmd: localstack stop`.
- `firebase emulators:start` — same shape, daemonizes.

## When NOT to use this pattern

- The CLI runs in the foreground and doesn't exit (e.g., `temporal server start-dev`). That's a regular long-lived owned service, not a oneshot.
- The CLI runs once and produces an artifact (e.g., `prisma generate`). That belongs in `lifecycle.before_up` or `after_up` — no port, no readiness, no teardown.
- The user has a hard requirement that the CLI runs outside lich (e.g., they want to keep a single supabase instance across all worktrees on purpose). Use `before_up` as the escape hatch.

## Migration from `before_up`

If the user is currently running `supabase start` as a `lifecycle.before_up` hook, walk them through the upgrade:

1. Move the cmd into an `owned:` block with `oneshot: true` + `stop_cmd:` (as above)
2. Add per-worktree namespacing via `${worktree.id}` in `SUPABASE_PROJECT_ID`
3. Pull port literals out of any hardcoded URLs — replace with `${owned.supabase.ports.<key>}`
4. Update downstream services to `depends_on: [supabase]`

What they gain: parallel-stack support (two worktrees, two `lich up`s, no collision), automatic teardown on `lich down`, ports surfaced in `lich env stack` and on the dashboard.
