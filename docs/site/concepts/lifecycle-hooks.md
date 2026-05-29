# Lifecycle hooks

Hooks let you run commands at stack boundaries — before any service starts, after the stack is ready, before tearing down. The most common use is `after_up` for migrations and seeds.

## Top-level hooks

Three phases at the stack level:

```yaml
lifecycle:
  before_up:                       # runs before any service starts
    - ./scripts/check-prereqs.sh
  after_up:                        # runs once all services are ready
    - psql "$DATABASE_URL" -f db/migrations/01_init.sql
    - cmd: ./scripts/seed.sh
      env_group: stack-plus-test   # optional — use a named env bundle
  before_down:                     # runs before any service stops
    - ./scripts/dump-state.sh
```

There's also `after_down` (runs AFTER all services have stopped), for external resource cleanup that's only safe once services are fully torn down.

Entries are either a string (the cmd) or an object: `{ cmd: ..., env_group?: ..., cwd?: ... }`.

## Per-service hooks

Each `services.<name>` and `owned.<name>` can also declare hooks scoped to that service:

```yaml
owned:
  api:
    cmd: bun run dev
    lifecycle:
      before_start:                # runs before this service starts
        - ./scripts/api-prebuild.sh
      after_ready:                 # runs when this service's ready_when fires
        - ./scripts/api-warm-cache.sh
      before_down:                 # runs before this service stops
        - ./scripts/api-flush.sh
```

Per-service hooks run in the context of one service. Use them for service-specific setup / teardown that doesn't belong at the stack boundary.

## Phase ordering

For a typical `lich up`:

1. `lifecycle.before_up` (top-level)
2. Compose services start
3. Per-service `lifecycle.before_start` for owned services
4. Owned services start (in `depends_on` order)
5. Per-service `lifecycle.after_ready` as each service becomes ready
6. `lifecycle.after_up` (top-level) — runs once every service is ready

For `lich down`:

1. `lifecycle.before_down` (top-level) — services still alive
2. Per-service `lifecycle.before_down`
3. Services stop
4. `lifecycle.after_down` (top-level) — services fully torn down

## Choosing `after_up` vs `after_down` vs `oneshot`

| Use case | Right tool |
|----------|------------|
| Migration / seed (no teardown needed) | `lifecycle.after_up` |
| Dump live-service state for debugging | `lifecycle.before_down` |
| Clean up external resources (scratch dirs, sockets) | `lifecycle.after_down` |
| External CLI that spawns side-effects you must tear down later | `owned: { oneshot: true, stop_cmd: ... }` — see [Oneshot services](/concepts/oneshot-services) |

The big trap: don't use `lifecycle.before_up` for `supabase start` or any other launcher that spawns long-lived side-effects. The spawned containers stay running after `lich down`, the second `lich up` collides on container names, and you end up with a graveyard of orphan stacks. Use `oneshot:` + `stop_cmd:` instead.

## Hook logs

Hook stderr is captured to `<LICH_HOME>/stacks/<id>/hooks/<phase>-<idx>.log` and surfaced inline on completion. Useful for debugging hooks that swallow errors with `|| true` — the inline tail prints regardless of exit code, and the full combined stdout+stderr lives in the per-hook log file (rolling ~1 MB cap).

Path shape: `before_up-0.log`, `after_down-2.log`, etc. (phase + 0-based index within the composed entries array).

## Profile lifecycle merge

When a profile declares its own `lifecycle:` block, it **merges** with the top-level — it does NOT replace. See [Profiles → Profile lifecycle merge](/concepts/profiles#profile-lifecycle-merge) for the merge order and a worked example.

See the [full `lifecycle:` section in the lich.yaml reference](/reference/lich-yaml#lifecycle) for the schema and edge cases.
