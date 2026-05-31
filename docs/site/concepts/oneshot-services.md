# Oneshot services

Some "services" aren't long-lived processes at all — they're CLI launchers that spawn side-effects (containers, daemons, files) and then exit. `supabase start`, `dbmate up`, `prisma migrate dev`, `firebase emulators:start`, `localstack start`, `temporal server start-dev`. Modeling them as regular owned services fails (lich sees the exit and reports a crash). Modeling them as `lifecycle.before_up` works for the start side but leaves the spawned containers orphaned on `lich down`.

Lich supports them with the `oneshot: true` + `stop_cmd:` pair on an owned service.

## The pattern

```yaml
owned:
  supabase:
    cmd: supabase start            # launcher; exits after spawning its containers
    oneshot: true                  # lich runs cmd to completion; treats exit as success
    stop_cmd: supabase stop        # invoked on `lich down` to clean up the side-effect
    env:
      SUPABASE_PROJECT_ID: "myapp-${worktree.id}"   # per-worktree namespace
    ports:
      api: { published_env: SUPABASE_API_PORT }
      db:  { published_env: SUPABASE_DB_PORT }
    ready_when:
      tcp: "localhost:${owned.supabase.ports.api}"
      timeout: 120s
```

## Why each piece matters

### `oneshot: true`

`supabase start` is a launcher: it spawns ~10 docker containers and then exits. If you modeled it as a regular long-lived owned service, lich would see the exit and report a crash. `oneshot: true` tells lich to run the cmd to completion, treat non-zero exit as a hard failure (with the log tail), and otherwise consider the service "up" so downstream `depends_on:` proceeds.

### `stop_cmd: ...`

Without this, the side-effect leaks. `lich down` would stop tracking the service but the docker containers `supabase start` spawned would keep running. On the next `lich up`, port allocation might clash. After a week of `up`/`down` cycles you'd have a graveyard of orphan supabase stacks.

`stop_cmd` runs with the **same env and cwd** the original `cmd` ran with — load-bearing because `supabase stop` finds the containers it spawned by reading `SUPABASE_PROJECT_ID` from the env.

### `${worktree.id}` for per-worktree namespacing

The supabase CLI uses `project_id` to name the containers it spawns (`supabase_db_${PROJECT_ID}`, `supabase_api_${PROJECT_ID}`, etc.). Two worktrees of the same project both default to `project_id: myapp` → collision. `${worktree.id}` is a stable 12-hex-char hash of the worktree path — different worktrees get different ids, so `myapp-${worktree.id}` becomes `myapp-a4e87c8572d0` in one worktree and `myapp-b91d3e6f1c00` in another.

Same pattern works for anything that needs per-instance namespacing: compose project names, KV namespaces, S3 prefixes, temporal task queues, cloud env names.

### `ports:` declared up front

Lich allocates host ports during stack definition (step 4 of `lich up`), **before** any service's `cmd` executes. So when `supabase start` runs, `${owned.supabase.ports.api}` is already `54321` (or whatever), and the env vars set on the service (`SUPABASE_API_PORT=54321`) propagate into the spawned containers. No port pinning, no shell-script wrapper.

### `ready_when.tcp` against the allocated port

Once `supabase start` exits successfully, the spawned containers are still booting. `ready_when` probes the side-effect — open a TCP connection to the API container's allocated port; succeed when the connection succeeds. `tcp:` is the right probe here (no HTTP route to check yet on cold start). Timeout 120s on first run because supabase pulls a lot of images.

## When to use `oneshot` vs `lifecycle.after_up`

| Use case | Right tool |
|----------|------------|
| External CLI with side-effects to tear down (containers, daemons, allocated cloud resources) | `oneshot: true` + `stop_cmd:` |
| Fire-and-forget script (run a migration, seed the DB) — nothing to tear down | `lifecycle.after_up` |

If there's something to undo on `lich down`, it's `oneshot`. Otherwise it's `lifecycle.after_up`.

## Read next

- [The full external-CLI walkthrough](https://github.com/RPate97/lich/blob/main/skills/lich-instrument/references/external-cli-services.md) — annotated supabase example, port-allocation timing, parallel-worktree semantics.
- [Recipes → External CLI services](/recipes/#recipe-1-external-cli-services-supabase-dbmate-prisma-migrate-firebase-emulators-localstack) — the short version.
- [`oneshot` + `stop_cmd` in the lich.yaml reference](/reference/lich-yaml#one-shot-launchers-oneshot-stop-cmd).
