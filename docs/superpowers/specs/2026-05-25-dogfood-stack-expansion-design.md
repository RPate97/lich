# Dogfood-Stack Expansion — Design

> **Status:** Approved 2026-05-25. Implementation plan to follow in a
> separate plan file under `docs/superpowers/plans/`.

> **Spec source:** Feature inventory pulled from
> `docs/superpowers/specs/2026-05-23-lich-v1-design.md`.

## 1. Problem and goal

The current `examples/dogfood-stack/` exercises a useful slice of lich v1
(supabase as an `owned` oneshot, api + web with `depends_on`, `tunnel_demo`
with `ready_when.capture`, 2 env_groups, 2 profiles, 3 commands, one
`lifecycle.after_up` hook), but several v1 features have **zero** e2e
coverage because the dogfood-stack never exercises them:

- `services:` (docker compose) — completely absent
- `env_files:` and top-level `env_from:` — absent
- `runtime:` block — absent
- `lifecycle.before_down` (top-level) — absent
- per-service `lifecycle.after_ready` — absent
- `ready_when.cmd:` ready-check variant — absent
- env_group using `env_from:` (vs literal `env:` values) — absent
- exclude-services profile pattern (`dev:lite`-style) — absent
- user-defined `commands:` consuming compose-service env interpolations — absent
- user-defined `commands:` consuming env_from output via env_group — absent

This spec defines the expanded `examples/dogfood-stack/lich.yaml` (plus
small fixture files and one tiny api-code change) that closes every
feature gap above. The expanded stack is a **test fixture**, not a
"realistic minimum" example — synthetic services are acceptable where
they make a feature easier to assert on.

## 2. Architecture

```text
services: (NEW)              owned: (existing + 1 new)
  redis (cache)                supabase  (oneshot+stop_cmd)
  mailhog (smtp+ui)            api       (depends_on: supabase)
                               web       (depends_on: api)
                               tunnel_demo (capture demo)
                               health_probe (NEW: ready_when.cmd demo)

env_files: (NEW)             env_groups:
  .env  →  small fixture       stack-plus-test  (existing)
  .env.local  →  override      isolated-tools   (existing)
                               from-cmd-secrets (NEW: uses env_from)

env_from: (NEW)              profiles:
  cmd: scripts/fake-secrets.sh  dev               (existing default)
                                dev:env-override  (existing)
                                dev:lite          (NEW: exclude-services pattern)

runtime: (NEW)               lifecycle:
  compose_cli: auto            top-level before_up   (existing)
  proxy_port: 3300             top-level after_up    (existing, env_group)
                               top-level before_down (NEW)
commands:
  test:e2e        (existing)
  db:psql         (existing)
  tools:env-check (existing)
  show:version    (NEW: env_from-via-env_group)
  cache:flush     (NEW: consumes ${services.redis.host_port})
```

## 3. Compose services (`services:` block)

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - { container: 6379, env: REDIS_HOST_PORT }
    environment: {}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 1s
      retries: 30

  mailhog:
    image: mailhog/mailhog:latest
    ports:
      - { container: 1025, env: SMTP_HOST_PORT }
      - { container: 8025, env: MAILHOG_UI_PORT }
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8025/api/v1/messages || exit 1"]
      interval: 3s
      timeout: 2s
      retries: 20
```

**Why these two:**

- **Redis** — tiny image (~10 MB), instant startup, single port,
  well-known. Exercises `image:` + `ports:` (single) + `healthcheck:`
  (CMD form).
- **Mailhog** — multi-port (1025+8025), HTTP healthcheck (CMD-SHELL with
  wget). Distinct from redis's CMD form.

**`env:` block gets new interpolations** to wire compose services into
the rest of the stack:

```yaml
env:
  # ... existing entries ...
  REDIS_URL: "redis://localhost:${services.redis.host_port}"
  SMTP_URL: "smtp://localhost:${services.mailhog.host_port_1025}"
  MAILHOG_UI: "http://localhost:${services.mailhog.host_port_8025}"
```

The multi-port interpolation pattern `services.mailhog.host_port_1025`
matches the spec's annotated example syntax. If the actual resolver in
`packages/lich/src/env/resolve.ts` uses a different shape, the
implementation plan aligns to what the resolver expects (verify
during plan execution; the resolver is the source of truth).

## 4. `runtime:` block + lifecycle additions

```yaml
runtime:
  compose_cli: auto       # auto-detect docker vs podman
  proxy_port: 3300        # daemon's reverse-proxy port (default, pinned)

lifecycle:
  # before_up: existing
  # after_up:  existing (uses env_group: stack-plus-test)
  before_down:                                              # NEW
    - cmd: ./scripts/teardown-marker.sh
      env_group: stack-plus-test
```

**Per-service `after_ready` on `api`:**

```yaml
owned:
  api:
    # ... existing fields ...
    lifecycle:
      after_ready:
        - 'echo "[api] warmed up at $(date -Iseconds)" >> ${LICH_HOME}/api-warmup.log'
```

The log line is easy to assert on (`api-warmup.log` exists +
contains `warmed up`). No external dependency.

**New script:** `examples/dogfood-stack/scripts/teardown-marker.sh` —
mirrors the existing `write-marker.sh` but for the `before_down` phase.
Writes a `teardown-marker.txt` for e2e verification.

**What's exercised:**

- `runtime.compose_cli` — Plan 1 wiring (file a bug if it's hardcoded
  to "docker")
- `runtime.proxy_port` — already used by `lich urls` + daemon
- `lifecycle.before_down` (top-level) — currently 0 e2e coverage
- per-service `lifecycle.after_ready` — currently 0 e2e coverage

## 5. Env layering — `env_files`, `env_from`, new env_group

```yaml
env_files:
  - .env           # baseline, checked into example
  - .env.local     # gitignored override; lich tolerates missing files

env_from:
  - cmd: "./scripts/fake-secrets.sh"
    format: dotenv
```

**Fixture files:**

```text
examples/dogfood-stack/.env
  LICH_DOGFOOD_EXAMPLE_FROM_DOTENV=hello-from-dotenv

examples/dogfood-stack/.env.local
  LICH_DOGFOOD_EXAMPLE_FROM_DOTENV_LOCAL=overrides-dotenv

examples/dogfood-stack/scripts/fake-secrets.sh
  #!/bin/sh
  # Mock secret-manager output. Real users would call
  # `infisical export --format=dotenv` or similar.
  echo "FAKE_SECRET_TOKEN=abc123"
  echo "FAKE_SECRET_REGION=us-east-1"
```

**`.gitignore`:** add `.env.local` (standard; `.env` IS checked in as
fixture).

**New env_group `from-cmd-secrets`** demonstrates env_from-inside-env_group
(distinct from top-level env_from):

```yaml
env_groups:
  # ... existing entries ...
  from-cmd-secrets:
    process_env: false     # block shell env passthrough
    env_from:
      - cmd: "./scripts/fake-secrets.sh"
        format: dotenv
    env:
      ENVIRONMENT: "ci"
```

**Resolution precedence** (highest wins, per Plan 3 spec):

1. Per-service / per-command `env:`
2. Profile-scoped `env:` (active profile)
3. Top-level `env:` (interpolations)
4. Top-level `env_from:` cmd output
5. Top-level `env_files:` (later files override earlier)
6. Process env (unless `process_env: false`)

E2e tests verify all six layers (e.g., `lich exec sh -c 'echo $LICH_DOGFOOD_EXAMPLE_FROM_DOTENV'`
returns the dotenv value under default profile; the same probe under a
profile that overrides the same key in `env:` returns the profile value).

## 6. New profile `dev:lite`

```yaml
profiles:
  # dev:              existing default
  # dev:env-override: existing (extends dev with env overrides)

  dev:lite:                                                # NEW
    # Minimal fast-iteration profile: drops the optional services
    # (redis, mailhog, tunnel_demo, health_probe) so the iteration loop
    # is just supabase + api + web. Useful when working on api code and
    # the cache / mail / tunnel surface doesn't matter.
    services: []                          # excludes redis + mailhog
    owned: [supabase, api, web]           # excludes tunnel_demo + health_probe
    lifecycle:
      after_up:
        - supabase migration up
        - psql "$DATABASE_URL" -f supabase/seed.sql
```

**Exclude-services semantics:**

- `dev:lite` explicitly lists `services: []` (empty) and a curated
  `owned:` list. NO `extends:` — profiles with explicit
  `services`/`owned` lists REPLACE the implicit "all declared" set.
- `lifecycle.after_up` is duplicated rather than inherited from `dev`,
  keeping `dev:lite` independent for fixture clarity.

**Why this works without depends_on conflicts:**

- `api`'s `depends_on: [supabase]` (just supabase — NOT redis) keeps
  dev:lite valid. Redis stays optional.
- The api's source code treats `REDIS_URL` as opt-in. The dogfood api
  doesn't do much meaningful work; adding a "if REDIS_URL: connect;
  else: skip" branch is trivial.

**api code change:** add an opt-in Redis connection that's a no-op when
`REDIS_URL` is unset. Keeps the api honest about the dependency being
optional.

## 7. Per-service `ready_when.cmd` via `health_probe`

```yaml
owned:
  # ... existing services ...

  health_probe:                                           # NEW
    cmd: 'sleep 99999'                                    # long-running placeholder
    oneshot: false
    depends_on: [api]                                     # api must be ready first
    ready_when:
      # Exercises the `cmd` ready-check variant: lich runs this shell
      # command, considers ready when exit code is 0. Distinct from
      # http_get / tcp / log_match.
      cmd: 'curl -fs http://localhost:${owned.api.port}/health > /dev/null'
      timeout: 10s
```

**Why a synthetic service:**

- Each owned service has one `ready_when` shape. Repurposing `api`'s
  `ready_when` from `http_get` → `cmd` would lose `http_get` coverage.
  Synthetic service preserves both.
- The `dev` profile includes it (so it runs in normal tests). `dev:lite`
  excludes it (fast iteration).

**`dev` profile update:**

```yaml
profiles:
  dev:
    default: true
    owned: [supabase, api, web, tunnel_demo, health_probe]   # add health_probe
```

## 8. New `commands:` entries

```yaml
commands:
  # test:e2e, db:psql, tools:env-check  (existing)

  show:version:                                          # NEW
    cmd: 'echo "FAKE_SECRET_TOKEN=$FAKE_SECRET_TOKEN, region=$FAKE_SECRET_REGION"'
    env_group: from-cmd-secrets
    help: |
      Print values loaded via the `from-cmd-secrets` env_group's
      `env_from` shell-out. Exercises the "user-defined command pulls
      env from an env_group whose values come from an external command"
      pattern end-to-end. `scripts/fake-secrets.sh` is the mock secret
      manager.

  cache:flush:                                           # NEW
    cmd: 'redis-cli -u "$REDIS_URL" FLUSHDB && echo "flushed"'
    help: |
      Wipe the dev-stack redis cache. Demonstrates a user-defined
      command consuming a `services:` (docker compose) env var
      (`REDIS_URL` is built from `${services.redis.host_port}`).
      Fails loudly under `dev:lite` (redis isn't running) — the right
      behavior since the command obviously depends on the cache.
```

## 9. Migration impact — existing e2e tests

Adding new services/profiles/commands changes the observable shape of
the dogfood-stack. The following existing tests need expected-value
updates (no structural changes):

| Test file | Why it needs update |
|---|---|
| `tests/e2e/basic-up.test.ts` | Service-name list assertion |
| `tests/e2e/profiles-default.test.ts` (LEV-393) | `dev` service set |
| `tests/e2e/profiles-named.test.ts` (LEV-394) | profile-named services |
| `tests/e2e/parallel-stacks.test.ts` (LEV-400) | service counts |
| `tests/e2e/dashboard-stack-list.test.ts` (LEV-426) | `/api/stacks` service array |
| `tests/e2e/dashboard-stack-detail.test.ts` (LEV-427) | `/api/stacks/:id` services |

Tests unaffected (no change needed):

- `tests/e2e/profiles-env-override.test.ts` (LEV-396)
- `tests/e2e/lifecycle-env-group.test.ts` (LEV-345)
- `tests/e2e/env-groups-isolation.test.ts`

## 10. New e2e tests

| Test file | Verifies |
|---|---|
| `tests/e2e/dogfood-compose-services.test.ts` | redis + mailhog reachable on allocated ports via `lich exec` |
| `tests/e2e/dogfood-env-files.test.ts` | `.env` + `.env.local` precedence |
| `tests/e2e/dogfood-env-from.test.ts` | `env_from: cmd` output flows into stack env |
| `tests/e2e/dogfood-before-down.test.ts` | `lifecycle.before_down` runs (teardown-marker.txt) |
| `tests/e2e/dogfood-after-ready.test.ts` | per-service `after_ready` runs (api-warmup.log) |
| `tests/e2e/dogfood-ready-when-cmd.test.ts` | `ready_when.cmd` is honored (health_probe ready) |
| `tests/e2e/profiles-lite.test.ts` | `dev:lite` excludes redis/mailhog/tunnel_demo/health_probe |
| `tests/e2e/commands-env-from.test.ts` | `lich show:version` returns env_from'd values |
| `tests/e2e/commands-compose-port.test.ts` | `lich cache:flush` works under dev, fails under dev:lite |

## 11. Files changed / created (summary)

**Modified:**

- `examples/dogfood-stack/lich.yaml` (the main edit)
- `examples/dogfood-stack/.gitignore` (add `.env.local`)
- `examples/dogfood-stack/apps/api/` (opt-in REDIS_URL)
- Existing e2e tests listed in §9

**Created:**

- `examples/dogfood-stack/.env` (committed; baseline fixture)
- `examples/dogfood-stack/scripts/fake-secrets.sh`
- `examples/dogfood-stack/scripts/teardown-marker.sh`
- 9 new e2e test files listed in §10

**NOT created (deliberately):**

- `examples/dogfood-stack/.env.local` — gitignored by intent. The
  env-files-precedence e2e test (`dogfood-env-files.test.ts`) creates
  its own `.env.local` in its tmpdir during setup so the assertion has
  predictable content. Checking in an example `.env.local` would teach
  users the wrong pattern (the file is meant for local-only overrides).

**Total scope:** roughly 12-15 bite-sized implementation tasks once the
writing-plans skill breaks this down. Each task owns one feature gap
end-to-end (yaml change + fixture file(s) if any + new e2e test +
updates to affected existing tests).

## 12. Out of scope (deferred)

- Per-profile `depends_on` overrides — the test-env-without-supabase
  scenario from Plan 3's design comment. Solved here by making redis
  optional, not by adding the override feature.
- WebSocket proxy support — orthogonal to fixture coverage.
- The instrumentation skill (`lich:instrument`) — descoped from Plan 6
  per the user; out of scope here too.
