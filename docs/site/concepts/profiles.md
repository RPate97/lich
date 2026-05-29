# Profiles

Profiles are named subsets of the stack — services, owned processes, env, and lifecycle hooks — that you switch between with `lich up <profile-name>`.

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

  dev:test-env:
    extends: dev                   # inherits dev's services + owned + lifecycle
    env:
      DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp_test"
```

Top-level `services:` / `owned:` / `env:` / `lifecycle:` define the **superset**. Profiles pick subsets and override.

`lich up` (no arg) runs the profile marked `default: true`, or — if exactly one profile is defined — runs that one, or — if no profiles are defined — runs everything declared at top level.

## When to use profiles

- The user wants different startup modes (fast iteration vs full-stack).
- The user wants different env values (test DB vs dev DB) from the same yaml.
- The user wants to skip slow services during quick iteration loops.

## When NOT to use profiles

- One way to run the stack. Profiles add maintenance overhead — don't add them if there's no second mode.
- Per-environment configuration (e.g. production vs dev). Lich is a dev tool; production runs the same images via real orchestration, not via a `lich.yaml` profile.

## Profile lifecycle merge

Profile-scoped `lifecycle:` blocks **merge** with the top-level `lifecycle:` block. They do NOT replace. Same model as `env:` / `services:` / `owned:`: top-level defines the baseline; the active profile adds to it.

| Phase | Order |
|-------|-------|
| `before_up` | top-level entries, then profile entries |
| `after_up` | top-level entries, then profile entries |
| `before_down` | profile entries, then top-level entries (LIFO — undo specialization before tearing down base) |
| `after_down` | profile entries, then top-level entries (LIFO — same rule as `before_down`) |

There is no `!replace` marker, no `lifecycle_replace:` key. If you want a profile to skip a top-level entry, gate the entry on `$LICH_PROFILE`:

```yaml
lifecycle:
  before_up:
    - '[ "$LICH_PROFILE" = "fullstack" ] && pnpm db:reset || true'
```

## Common mistake

**Don't copy top-level entries into every profile to "be safe."** They already run — the profile's block only adds. Duplicating shared steps into every profile means they fire twice when the profile is active.

See the [profile lifecycle merge](/reference/lich-yaml#profile-lifecycle-merge) section in the lich.yaml reference for a worked example.
