# Profiles

Profiles are named subsets of the stack. Services, owned processes, env, and lifecycle hooks that you switch between with `lich up <profile-name>`.

The common case: one profile for fast iteration (skip the database, use stub data), another for full-stack testing (database + migrations + seed). Both live in one `lich.yaml`; the right one runs based on what you're doing.

## The shape

```yaml
profiles:
  dev:fast:
    default: true                  # `lich up` (no arg) picks this
    services: []                   # no compose services
    owned: [api, web]              # subset of owned

  dev:
    services: [postgres]
    owned: [api, web]
    env:
      DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
    lifecycle:
      after_up:
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql
```

Top-level `services:` / `owned:` / `env:` / `lifecycle:` define the **superset**. Profiles pick subsets and override.

`lich up` (no arg) runs the profile marked `default: true`, or if exactly one profile is defined runs that one. If no profiles are defined, then lich runs everything declared at top level.

## When to use profiles

- You want different startup modes (fast iteration vs full-stack).
- You want different env values (hosted DB vs local DB).
- You want to skip slow or memory intensive services for quick iteration loops.

## When NOT to use profiles

- Only one way to run the stack? Profiles just add maintenance overhead. Don't add them if you don't need a second mode.
- Per-environment configuration (e.g. production vs dev). Lich is a dev tool; it doesn't deploy into production.

## Profile lifecycle merge

Profile-scoped `lifecycle:` blocks **merge** with the top-level `lifecycle:` block. They do NOT replace. Same model as `env:` / `services:` / `owned:`: top-level defines the baseline; the active profile adds to it.

| Phase | Order |
|-------|-------|
| `before_up` | top-level entries, then profile entries |
| `after_up` | top-level entries, then profile entries |
| `before_down` | profile entries, then top-level entries (LIFO, undo specialization before tearing down base) |
| `after_down` | profile entries, then top-level entries (LIFO, same reason as `before_down`) |

If you want a profile to skip a top-level entry, gate the entry on `$LICH_PROFILE` or just move it to a different profile:

```yaml
lifecycle:
  before_up:
    - '[ "$LICH_PROFILE" = "fullstack" ] && pnpm db:reset || true'
```

## Common mistake

**Don't copy top-level entries into every profile.** They already run, the profile's block only adds. Duplicating shared steps into every profile means they fire twice when the profile is active.

See the [profile lifecycle merge](/reference/lich-yaml#profile-lifecycle-merge) section in the lich.yaml reference for a worked example.
