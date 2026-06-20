---
name: lich-instrument
description: Instrument an arbitrary repo for lich — survey the project, interview the user about ambiguities, propose a lich.yaml shape, write it, and verify with `lich validate`. Use this skill whenever the user wants to set up lich in their project, asks to "make this work with lich", wants a lich.yaml from scratch, says "wire up lich for me", needs lich configured for an existing app/monorepo/Next.js/Express/Django/Rails/FastAPI stack, or mentions any version of "get my stack running with lich". Don't just write a lich.yaml from a generic template — always survey first and interview the user, because every stack has wrinkles (env wiring, port pinning, profile shape) that only the human knows.
---

# Lich Instrument

You are helping the user turn their existing repo into a lich stack: a single `lich.yaml` that brings up every service they need, with friendly URLs, per-worktree port allocation, and env wiring between services.

The shape of `lich.yaml` matters. Too few services and the stack isn't usable; too many and the user is annoyed maintaining lich for things they didn't want to manage there. The right answer comes from understanding the current repo + asking the user what they want.

## The flow

Four passes:

1. **Survey** — read the repo's signals (package.json files, docker-compose, Procfile, README, framework conventions) without writing anything yet.
2. **Interview** — present what you found and ask focused questions about ambiguities. Don't ask about things you already know.
3. **Propose** — draft a `lich.yaml` shape, show it to the user inline for review, take their feedback, revise.
4. **Write + verify** — write the file, then run `lich validate` against it, fix any issues, then suggest `lich up`.

Stop and ask if you genuinely don't know — never guess at port numbers, service inclusion, or env-var wiring.

## Pass 1: Survey

Read these signals in roughly this order. Be quick — you're building a mental model, not a complete map.

**Top-level structure:**
- `ls` the repo root. Monorepo (multiple apps/packages) or single app?
- Root `package.json`: scripts hint at the dev workflow. `workspaces` field confirms monorepo shape.

**Process descriptors:**
- `docker-compose.yml` / `compose.yaml`: existing containerized services. Each is a candidate for lich's `services:` block.
- `Procfile`: Heroku-style process list. Each line is a candidate for `owned:`.
- Per-app package.json (`apps/*/package.json`, `packages/*/package.json`): the `scripts.dev` value is what you'd run as a lich `owned:` entry.

**Framework signals** (per app — see `references/framework-patterns.md` for the full table):
- Next.js: `next` in deps + a `dev` script. Default port 3000.
- Express / Bun.serve / Fastify: an HTTP listener somewhere in `src/`. Port from `process.env.PORT`.
- Django: `manage.py` exists. `python manage.py runserver`. Default 8000.
- Rails: `Gemfile` + `bin/rails`. `bin/rails server`. Default 3000.
- FastAPI / Uvicorn: `pyproject.toml` + uvicorn cmd. Default 8000.
- Vite (any framework): `vite.config.ts/js`. Default 5173.

**Database / cache / queue signals:**
- postgres / mysql / redis / mongo / mailhog in `docker-compose.yml`: these are `services:` candidates.
- prisma / drizzle / sequelize / typeorm in deps: implies a DB connection. Connection string is usually `DATABASE_URL`.

**External CLI launchers** (flag these for the interview — they shape the proposal):
- `supabase/config.toml` or `supabase` in `package.json` scripts: the supabase CLI launches ~10 containers via `supabase start`. Treat as a `oneshot: true` + `stop_cmd: supabase stop` candidate, not a compose service.
- `dbmate` / `prisma migrate dev` / `goose` / `flyway` / `liquibase` in scripts or deps: migration CLIs. Usually fit `oneshot` (if there's a teardown) or `lifecycle.after_up` (if not).
- `temporalio/cli` or `temporal server start-dev` in scripts: spawns a temporal dev cluster.
- `firebase emulators:start`, `localstack start`, `wrangler dev`: similar shape — external CLI that owns its own daemons.
- Anything in scripts that's named `*:up`, `*:start`, `*-up.sh` and shells out to a tool's CLI is worth checking.

**Heavy-cold-boot signals** (flag for the sandbox suggestion — see `references/sandbox-warm-fork.md`):
- Large lockfile or > 100 deps in `package.json` (long `bun install` / `pnpm install`).
- `supabase/config.toml` + `supabase start` (pulls and starts ~10 containers from scratch).
- Migrations directory with many files (`db/migrations/*.sql`, `prisma/migrations/`) or a heavy seed file.
- User mentions `lich up` takes "a couple minutes" or they have to wait for fresh worktrees.
- The user is on macOS with Apple Silicon (sandbox is macOS-only via Tart).

**Env signals:**
- `.env`, `.env.example`, `.env.development`: existing env vars. Note which look stack-specific (DATABASE_URL, REDIS_URL, API_URL — wire these via lich) vs secrets (API_KEY, OAUTH_SECRET — user-managed).

Don't read every file. Read enough to understand the shape.

## Pass 2: Interview

You have signals. Don't ask the user to repeat what's obvious from the repo. Ask only about real ambiguities.

Likely questions, in priority order:

1. **Service inclusion**. "I see `apps/web` (Next.js), `apps/api` (Express), and a docker-compose with postgres. Should lich manage all three?" — some users want lich to handle only host processes, leaving compose alone. That's valid; make it explicit.

2. **Env wiring**. "I see `apps/api` reads `DATABASE_URL` from env. Wire it from the postgres compose service via `${services.postgres.host_port}` interpolation?" — this is the load-bearing feature; confirm you got the env var name right.

3. **External CLI launchers**. If the survey turned up `supabase start`, `dbmate up`, `prisma migrate dev`, a `temporal server start-dev` script, or any other CLI that spawns its own side-effects (containers, daemons), ask:
   > "I see your setup uses `supabase start` / similar external CLIs. Want me to wrap them as `oneshot owned` services with a `stop_cmd`, so lich allocates the ports per-worktree and you can run multiple stacks in parallel? Or run them via `before_up` for now and migrate later?"
   
   The default proposal should be **lich-managed oneshot** (`oneshot: true` + `stop_cmd:` + `${worktree.id}` for namespacing) — that's what makes multi-worktree workflows work. `before_up` is the legacy escape hatch for cases where the user explicitly wants lich out of the loop. See `references/external-cli-services.md` for the supabase pattern.

4. **Port preferences**. Usually skip this — lich's default dynamic allocation is what users want. Only ask if you saw a hardcoded port the user might need pinned (e.g., a webhook URL in code that expects port 3000).

5. **Profiles**. Only ask if you saw signs the app handles DB-absent gracefully (e.g., `if (process.env.DATABASE_URL) ...`). "Want a `dev:fast` profile that skips postgres (api falls back to a stub), or just one default profile?" If the codebase doesn't tolerate DB-absent, don't offer profiles — one profile is fine.

6. **Lifecycle hooks**. Only if you saw migration scripts in the repo. "Should `lich up` run `prisma migrate dev` after services start?"

7. **Sandbox warm-fork** (only if heavy-cold-boot signals fired AND the user is on macOS Apple Silicon).
   > "Your cold boot is going to be expensive (heavy `bun install` / supabase / migrations). Lich supports baking the whole stack into a snapshot once and forking it for every subsequent up — typical cold drops from 1-3 min to ~14s. Worth wiring in? It does mean services run inside a Linux microVM instead of on the host. Setup is a one-time `bash packages/lich/scripts/build-sandbox-image.sh`."

   If yes: consult `references/sandbox-warm-fork.md` for the `runtime.sandbox` block shape and the `bake_inputs` selection. If they're on Linux/Windows, don't offer it — Tart is macOS-only.

Keep questions tight. One or two at a time, not a barrage.

## Pass 3: Propose

Draft the `lich.yaml` and show it to the user **inline** in chat — don't write the file yet. Annotate non-obvious choices so they can push back.

Example shape (replace with what you derived from the survey):

```yaml
version: "1"

services:                                # docker-compose services lich manages
  postgres:
    image: postgres:16-alpine
    ports:
      - { container_port: 5432, published_env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp

owned:                                   # host processes lich runs directly
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { published_env: PORT }
    ready_when:
      http_get: /health

  web:
    cmd: bun run dev
    cwd: apps/web
    port: { published_env: PORT }
    depends_on: [api]
    ready_when:
      http_get: /

env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
  API_URL: "http://localhost:${owned.api.port}"
```

Then ask: **"Look right? Anything to swap out?"** Wait for the OK before writing. If they want changes, revise the yaml and re-present.

If the survey turned up anything beyond a vanilla single-app shape, consult the relevant recipe file in `references/` before drafting:

- Workspace task runner (turbo/nx/lage/wireit): **`references/monorepo-task-runners.md`**
- Slow `pnpm install` the user wants cached: **`references/install-caching.md`**
- Integrations with test-key-friendly services (Turnstile/Stripe/OAuth): **`references/test-key-overrides.md`**
- N near-identical worker processes (`*Worker.ts` / `*Processor.ts`): **`references/worker-pools.md`**
- External CLI launcher (supabase/dbmate/firebase emulators): **`references/external-cli-services.md`**
- Heavy cold-boot the user wants amortized across worktrees (macOS only): **`references/sandbox-warm-fork.md`**

## Pass 4: Write + Verify

Once the user approves:

1. Write `lich.yaml` at the repo root.
2. Run `lich validate` from the repo root. Report the output verbatim if it fails.
3. On validate error: consult `references/lich-yaml-spec.md` (the "Common validate errors" section) for fixes. Update the yaml; re-run. Don't loop more than 3 times — escalate to the user.
4. On clean validate, tell the user:
   > "lich.yaml is in. Next: `lich up`. The dashboard auto-opens at http://lich.localhost:3300/."

If the user doesn't have `lich` installed, point them at:
```bash
curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
```

## Reference files

Read these as needed — they're the source of truth for what lich supports.

- **`references/lich-yaml-spec.md`** — every option in lich.yaml, when to use which, validate-error remediation. Read when proposing the shape or fixing validate failures.
- **`references/dogfood-example.md`** — a canonical lich.yaml (postgres + api + web + profiles + lifecycle hooks), annotated. Read when you need to see "what good looks like" with most features in one file.
- **`references/framework-patterns.md`** — per-framework cookbook: Next/Express/Django/Rails/FastAPI/Vite/Bun.serve/etc. — port defaults, dev commands, `ready_when` patterns. Read when surveying to identify what each app needs.
- **`references/external-cli-services.md`** — the supabase / dbmate / prisma-style CLI-launcher pattern: `oneshot: true` + `stop_cmd:` + `${worktree.id}` for per-worktree isolation. Read when the survey turns up `supabase start` or any similar external CLI that spawns its own containers/daemons.
- **`references/monorepo-task-runners.md`** — workspace tooling (turbo/nx/lage/wireit): when the package graph means naive `pnpm run dev` skips dependency builds. Consult during Pass 3 if the repo has internal-package deps.
- **`references/install-caching.md`** — `before_up` pattern that skips `pnpm install` when the lockfile is unchanged. Consult during Pass 3 if cold-cache reinstalls are slow.
- **`references/test-key-overrides.md`** — local-dev test-key overrides for Turnstile/Stripe/OAuth/etc. via env-precedence rules. Consult during Pass 3 if the app integrates a service with "always-pass" test keys.
- **`references/worker-pools.md`** — `discover:` block for N near-identical workers (`*Worker.ts` / `*Processor.ts`). Consult during Pass 3 if the stack has 3+ owned services with the same shape.
- **`references/sandbox-warm-fork.md`** — the `runtime.sandbox` block for macOS users with heavy cold boot. The whole stack runs inside a Tart microVM; the first `lich up` cold-boots and bakes a snapshot, every subsequent up warm-forks (~14s). Consult during Pass 2/3 if the survey flags heavy `bun install` / supabase / large migrations / seed data AND the user is on macOS Apple Silicon.
- **`references/cli.md`** — auto-generated reference for every `lich` subcommand. Consult when you need exact flag syntax or behavior for a command you'd suggest the user run (e.g., `lich validate`, `lich up`, `lich exec`).

## Skill version and refresh

This skill ships a `VERSION` file alongside `SKILL.md`. The file contains a single version string that matches the lich release it was written against.

If reference files produce incorrect yaml (validate rejects a property you proposed, or a pattern doesn't match what lich actually supports), check whether your installed copy is current:

```bash
# Compare installed version to what's in the repo
cat ~/.claude/skills/lich-instrument/VERSION
# expected: matches skills/lich-instrument/VERSION in the lich repo

# Refresh via skills CLI
npx skills update lich-instrument

# If update isn't available, remove and re-add
npx skills remove lich-instrument
npx skills add https://github.com/rpate97/lich/skills/lich-instrument
```

## What NOT to do

- **Don't write a generic template without surveying.** Every stack is different. The interview catches the wrinkles.
- **Don't ask the user to confirm things you already know from reading the repo.** That's noise.
- **Don't write `lich.yaml` before the user has approved the proposed shape.** Files on disk should match an explicit yes.
- **Don't skip `lich validate` after writing.** It's the cheapest signal that the yaml is right.
- **Don't add `profiles`, `lifecycle`, `env_groups`, or `commands` unless the user wants them.** They're powerful but optional — empty stacks are simpler to maintain.
- **Don't pin specific port numbers unless the user asks.** Lich's dynamic allocation is the point — pinning defeats per-worktree isolation.
