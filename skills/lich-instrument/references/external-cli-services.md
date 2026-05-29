# External CLI services (supabase, dbmate, prisma migrate, etc.)

When the stack you're instrumenting depends on a CLI that **spawns its own side-effects** — `supabase start` brings up ~10 containers, `dbmate up` runs migrations, `prisma migrate dev` runs migrations and (sometimes) starts a shadow DB — the right shape in `lich.yaml` is rarely "wrap it as a regular long-lived `owned` service" and rarely "shell out from `before_up`."

The right shape is a **oneshot owned service** with a `stop_cmd` for teardown and `${worktree.id}` for per-worktree namespacing. This file walks through why, with the canonical supabase example.

## The pattern

```yaml
owned:
  supabase:
    cmd: supabase start
    cwd: .
    oneshot: true
    stop_cmd: supabase stop
    env:
      # Per-worktree project_id keeps parallel lich stacks from colliding on
      # the same set of supabase containers. The supabase CLI honors this env
      # var at runtime, overriding supabase/config.toml's project_id.
      # ${worktree.id} is the 12-hex-char stable hash of the worktree path.
      SUPABASE_PROJECT_ID: "myapp-${worktree.id}"

      # SITE_URL needs to point at the web app's allocated port. Lich allocates
      # ports up-front (step 4 of `lich up`, before any service.cmd runs), so
      # ${owned.web.port} is already a real integer here. The supabase CLI
      # honors SUPABASE_AUTH_SITE_URL as the env override for config.toml's
      # auth.site_url — no pinning, no pre-baking, no shell-script wrapper.
      SUPABASE_AUTH_SITE_URL: "http://localhost:${owned.web.port}"

    ports:
      api:    { env: SUPABASE_API_PORT }
      db:     { env: SUPABASE_DB_PORT }
      studio: { env: SUPABASE_STUDIO_PORT }

    ready_when:
      # Probe the side-effect, not the launcher. supabase start exits in
      # ~5-10s; the containers it spawned are ready a moment after that
      # when the API container's port starts accepting connections.
      tcp: "localhost:${owned.supabase.ports.api}"
      timeout: 120s     # cold-cache image pulls on first run can be slow

  web:
    cmd: pnpm dev
    cwd: apps/web
    port: { env: PORT }
    depends_on: [supabase]

env:
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:${owned.supabase.ports.api}"
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${owned.supabase.ports.db}/postgres"
```

## Why each piece is there

### `oneshot: true`

`supabase start` is a launcher: it spawns ~10 docker containers and then exits. If you modeled it as a regular long-lived owned service, lich would see the exit and report a crash. `oneshot: true` tells lich to **run the cmd to completion, treat non-zero exit as a hard failure (with the log tail), and otherwise consider the service "up"** so downstream `depends_on:` proceeds.

### `stop_cmd: supabase stop`

Without this, the side-effect leaks. `lich down` would stop tracking the service but the docker containers `supabase start` spawned would keep running. On the next `lich up`, port allocation might clash. After a week of `up`/`down` cycles you'd have a graveyard of orphan supabase stacks.

`stop_cmd` runs with the **same env and cwd** the original `cmd` ran with. That's load-bearing: `supabase stop` finds the containers it spawned by reading `SUPABASE_PROJECT_ID` from the env. Without env preservation, `supabase stop` would target a default project_id and leave the per-worktree containers running.

### `${worktree.id}` in `SUPABASE_PROJECT_ID`

The supabase CLI uses `project_id` to name the docker containers it spawns (`supabase_db_${PROJECT_ID}`, `supabase_api_${PROJECT_ID}`, etc.). If you have two worktrees of the same project running side-by-side and both default to `project_id: myapp`, the second `supabase start` will collide on container names and fail (or, worse, silently attach to the first worktree's containers).

`${worktree.id}` is a stable 12-hex-char hash of the worktree's absolute path. Same worktree path → same id forever. Different worktrees → different ids. So `myapp-${worktree.id}` becomes `myapp-a4e87c8572d0` in one worktree and `myapp-b91d3e6f1c00` in another, and the two stacks coexist.

This pattern works for anything that needs per-instance namespacing: docker compose project names, KV namespaces, S3 prefixes, temporal task queues, etc.

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
