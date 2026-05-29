# Recipes — patterns past the basics

The framework cookbook (`framework-patterns.md`) and the dogfood example (`dogfood-example.md`) cover the happy path. This file catches the wrinkles that show up once a real stack lands on lich: monorepo task runners, install caching, dev-mode test keys, and external CLIs that spawn their own daemons.

Each recipe is short on purpose: when to use it, the yaml shape, the common mistake people make when they first reach for it.

---

## Recipe 1: External CLI services (supabase / dbmate / prisma migrate / firebase emulators / localstack)

**When to use this:** the stack depends on a CLI that spawns its own side-effects — `supabase start` brings up ~10 containers, `dbmate up` runs migrations, `prisma migrate dev` runs migrations and (sometimes) starts a shadow DB. Modeling the launcher as a regular long-lived owned service fails (lich sees the exit and reports a crash); modeling it as `lifecycle.before_up` leaks the spawned side-effects on `lich down`.

This is its own pattern (`oneshot: true` + `stop_cmd:` + `${worktree.id}` for namespacing) and gets full treatment in **`external-cli-services.md`** — read that file when the survey turns up `supabase start` or any similar external-CLI launcher. The short version: oneshot owned service, declare ports up front so they're allocated before the launcher runs, use `${worktree.id}` in the project-id env so parallel worktrees don't collide.

**Common mistake:** wrapping the launcher in `lifecycle.before_up` so it runs once on `lich up` — the spawned containers stay running after `lich down`, and the second `lich up` collides on container names.

---

## Recipe 2: Monorepo workspace tooling (turbo / nx / lage / wireit)

**When to use this:** the repo uses pnpm/yarn workspaces with an internal package graph — `apps/server` depends on `packages/db` and `packages/shared`, all built from source. The naive `pnpm run dev` inside `apps/server/` runs only that package's `dev` script and skips the dep graph; you'll get stale builds or missing-export errors at runtime.

The fix is to run the workspace task runner (turbo / nx / lage / wireit) from the repo root with a filter, so it knows to build dependencies first.

```yaml
owned:
  server:
    # WRONG: builds only apps/server's TS, not the @packages/* it depends on.
    # cmd: pnpm run dev
    # cwd: apps/server

    # RIGHT: turbo orchestrates the build graph across workspace deps,
    # then runs the `dev` script in apps/server with everything pre-built.
    cmd: pnpm exec turbo run dev --filter=server --env-mode=loose
    cwd: .
    port: { env: PORT }
    ready_when:
      http_get: /health
```

The `pnpm exec` prefix is also load-bearing: `cmd:` invocations don't necessarily have `node_modules/.bin` on `PATH`, so a bare `turbo run dev` may not resolve to the workspace-local `turbo` binary. Use `pnpm exec` (or `yarn run` / `npm exec`) to route through the package manager, which sets up `PATH` correctly. (LEV-498 is in flight to auto-prepend `node_modules/.bin` for `cmd:` invocations; until that ships, the `pnpm exec` workaround is the recipe.)

Equivalent shapes for the other workspace runners:

- **nx:** `cmd: pnpm exec nx run server:dev`
- **lage:** `cmd: pnpm exec lage dev --scope server`
- **wireit:** `cmd: pnpm exec wireit` (in the app's `cwd:`, with wireit deps wired in `package.json`)

**Common mistake:** setting `cwd: apps/server` + `cmd: pnpm run dev` because that's what the README says — locally a developer runs it from the app dir after a manual `pnpm -w build` to seed `dist/`. Lich doesn't know about that prior build; cold starts hit "Cannot find module '@packages/db'" because nothing built it.

---

## Recipe 3: pnpm install preflight (skip cold-cache reinstalls)

**When to use this:** every `lich up` spends 30-60 seconds running `pnpm install` even though the lockfile hasn't changed. A `before_up` hook that always runs `pnpm install` is the obvious first attempt; the problem is it always runs.

The fix is to check whether `node_modules` is stale relative to the lockfile and only reinstall if so. The pattern compares `pnpm-lock.yaml`'s mtime to `node_modules/.modules.yaml`'s mtime (pnpm writes the latter on every install), plus a sanity check that `node_modules/.pnpm` exists at all.

```yaml
lifecycle:
  before_up:
    - cmd: |
        set -euo pipefail
        if [ ! -d node_modules/.pnpm ] \
           || [ ! -f node_modules/.modules.yaml ] \
           || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
          echo "[preinstall] lockfile changed or node_modules missing — installing"
          pnpm install --frozen-lockfile
        else
          echo "[preinstall] node_modules up to date — skipping install"
        fi
```

Equivalent shapes for the other package managers:

- **yarn (berry):** check `pnpm-lock.yaml` → `yarn.lock`; check `node_modules/.modules.yaml` → `.yarn/install-state.gz`.
- **npm:** check `pnpm-lock.yaml` → `package-lock.json`; check `node_modules/.modules.yaml` → `node_modules/.package-lock.json`.

This pattern may eventually become a built-in (something like `runtime.preinstall: pnpm`) — until then, the manual `before_up` hook is the recipe.

**Common mistake:** running `pnpm install` unconditionally on every `lich up`. It wastes 30-60s per startup and slows down agent-driven workflows where `lich up`/`lich down` happen frequently.

---

## Recipe 4: Local-dev test-key overrides

**When to use this:** the app integrates with a service that has "always-pass" test keys for localhost development — Cloudflare Turnstile, Stripe, GitHub OAuth, reCAPTCHA, Auth0, etc. Production keys come from a secret manager (`env_from`); locally you want to override them with the public test keys so the dev flow works without real credentials.

The pattern relies on lich's env precedence: **top-level `env:` literals win over top-level `env_from:`** (and top-level `env_from`'s output gets overwritten by the `env:` literal of the same key). So you can leave the `env_from:` secret-manager pull in place and explicitly override the keys you want test versions of.

```yaml
# env_from runs first and pulls real creds from your secret manager.
env_from:
  - cmd: op item get "myapp-secrets" --format json | jq -r '.fields[] | "\(.label)=\(.value)"'

# Top-level `env:` literals layer on top of env_from and win on key conflict.
env:
  # Cloudflare Turnstile always-pass test key — works for any localhost origin.
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA"
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA"

  # Stripe test-mode publishable key (real key, but explicitly the test one).
  STRIPE_PUBLISHABLE_KEY: "pk_test_..."
  STRIPE_SECRET_KEY: "sk_test_..."

  # GitHub OAuth: a localhost-bound app you registered for dev.
  GITHUB_OAUTH_CLIENT_ID: "Iv1.localhost-dev-only"
  GITHUB_OAUTH_CLIENT_SECRET: "ghp_localhost_dev_only"
```

The precedence rule is the load-bearing piece. From the resolver: top-level `env_from` (step 3) → top-level `env_files` (step 4) → top-level `env` literals (step 5). Later wins, so the `env:` literal overrides whatever value `env_from` produced for the same key. Per-service `env:` (step 11) wins over everything top-level if you want to override per service.

**Common mistake:** moving the override into the secret-manager profile / vault entry so `env_from` returns the test value. That works, but now the secret manager holds dev-only data, the override is invisible from the yaml, and a teammate without secret-manager access can't run the stack at all. Keep the test-key override in `env:` literals — it's documentation as well as configuration.

---

## Recipe 5: Monorepo worker pools (`discover:` for N near-identical services)

**When to use this:** the stack has 3+ owned services with the same shape — typically a directory of `*Worker.ts` / `*Processor.ts` / `*Handler.ts` files, each spawned as its own process with the same `ready_when` / `fail_when` / `env`. Hand-writing N owned entries that mostly repeat is the obvious first attempt; the problem is it scales with N (an 11-worker stack → 110+ lines of yaml that all look the same).

The naive workaround — one owned entry wrapping `concurrently` — loses per-worker logs / restart state / health. The fix is a `discover:` block: a single owned entry expands at parse time into N synthetic owned services, each with its own state slot.

```yaml
owned:
  cronjob-workers:
    discover:
      # Glob is relative to discover.cwd (or parent.cwd, or the config dir).
      glob: "src/temporal/workers/*TemporalWorker.ts"
      name_template: "${basename_no_ext | strip_suffix:TemporalWorker | kebab}-worker"
      cmd_template: "pnpm exec nodemon -r ./tsconfigPathsDist.js dist/temporal/workers/${basename_no_ext}.js"
      cwd: apps/cronjob
    # Every field below applies to EVERY discovered instance — write once.
    ready_when:
      log_match: "Temporal worker created successfully|state: 'RUNNING'"
    fail_when:
      log_match: "FATAL|UnhandledPromiseRejection"
    env:
      NODE_ENV: development
```

For `apps/cronjob/src/temporal/workers/{Email,Payment,Cleanup}TemporalWorker.ts`, this materializes into three synthetic owned services: `email-worker`, `payment-worker`, `cleanup-worker`. Each has its own log file, its own restart state, its own dashboard tile — identical to a hand-written owned service.

Adding `BillingTemporalWorker.ts` to the workers dir adds `billing-worker` to the stack on the next `lich up` — no yaml edit.

**Mutual exclusivity:** an entry with `discover:` MUST NOT also set `cmd:` at the entry root — the per-instance command lives on `discover.cmd_template`. `lich validate` rejects the combination.

**Template grammar:** see the [`Glob-based discovery` section in `lich-yaml-spec.md`](./lich-yaml-spec.md#glob-based-discovery-discover) for the full vars + filters reference. The short version: `${basename}`, `${basename_no_ext}`, `${dirname}`, with `| kebab | snake | strip_suffix:X | strip_prefix:X` filters chainable left to right.

**Common mistake:** reaching for `discover:` for two services. The indirection costs more than it saves; write them out. The break-even is around three near-identical services.

**Other common mistake:** writing per-worker `ready_when` / `fail_when` patterns that are subtly different (one worker watches `"Worker started"`, another `"started OK"`). `discover:` applies the parent's shared fields verbatim — if patterns diverge, the workers don't fit a discover block. Either unify the patterns or fall back to per-worker hand-written entries.

---

## See also

- `external-cli-services.md` — full walkthrough of the supabase / dbmate / prisma-style oneshot pattern.
- `framework-patterns.md` — per-framework dev commands and `ready_when` shapes.
- `lich-yaml-spec.md` — every `lich.yaml` option, env precedence rules, interpolation syntax, common validate-error fixes.
- `dogfood-example.md` — an annotated end-to-end yaml exercising most features.
