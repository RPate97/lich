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
      - { container: 5432, env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp

owned:                                   # host processes lich runs directly
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { env: PORT }
    ready_when:
      http_get: /health

  web:
    cmd: bun run dev
    cwd: apps/web
    port: { env: PORT }
    depends_on: [api]
    ready_when:
      http_get: /

env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
  API_URL: "http://localhost:${owned.api.port}"
```

Then ask: **"Look right? Anything to swap out?"** Wait for the OK before writing. If they want changes, revise the yaml and re-present.

If the survey turned up anything beyond a vanilla single-app shape — a workspace task runner (turbo/nx/lage/wireit), a slow `pnpm install` step the user wants cached, integrations with test-key-friendly services (Turnstile/Stripe/OAuth), or an external CLI launcher (supabase/dbmate/firebase emulators) — consult **`references/recipes.md`** for the canonical shape before drafting. It covers the patterns past the basics: monorepo tooling, lockfile preflight, test-key overrides, external CLIs.

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

## Feedback hooks

While you're running this skill, you're in the best position anywhere to notice when lich (or this skill) is wrong about something. Don't swallow that signal — surface it. There are two patterns: auto-submit obvious problems, and suggest the dedicated `lich-feedback` skill when you've hit repeated friction the user is clearly feeling.

Both patterns are **user-confirmed, never silent.** You always show one sentence describing what you spotted, then a `[Y/n]` confirm (default Y). The point is to make reporting the easy path, not to spam the lich team.

### Auto-submit obvious problems

Watch for these during a run:

- **`lich validate` rejected a property the skill's references advertised as supported.** Signal: the references drifted from the implementation (same class of bug as the LEV-484 audit). Example: you propose `ready_when.port_open: 3000` because `framework-patterns.md` shows it, and validate rejects it because the actual property is `ready_when.tcp`.
- **Generated yaml fails validate more than twice in a row.** Signal: the skill is producing wrong output for this codebase shape. (One failure is normal — schemas have wrinkles. Three failures in a row is a pattern.)
- **A specific recipe doesn't match the codebase.** Example: "detected pnpm workspaces but `framework-patterns.md` has no section for that combo," or "found `bunx vitest` but no recipe entry covers vitest watch mode."
- **The user overrode your proposed yaml in a specific way more than once in the same session.** Example: you keep proposing `cwd: apps/api` and they keep changing it to `cwd: services/api` — the skill's monorepo-layout heuristic is wrong for this stack.

For each, do exactly this: ONE sentence to the user describing what you spotted, then a `[Y/n]` confirm with Y as the default, then call `lich feedback --file <path>` with an auto-generated payload. Make Y the easy path.

Worked example (validate rejects an advertised property):

```
I just proposed `ready_when.port_open: 3000` based on framework-patterns.md,
but `lich validate` rejected it — the actual property is `ready_when.tcp`.
That looks like the skill's references drifted from the implementation.
Want me to file this as feedback so the lich team can fix it? [Y/n]
```

If Y (or empty), write a short payload like the following to a tmp file and call `lich feedback --file <that path>`:

```markdown
## What happened

While instrumenting <repo>, the lich-instrument skill proposed `ready_when.port_open: 3000`
for an Express service, citing `references/framework-patterns.md`. `lich validate` rejected
the property; the suggested fix was `ready_when.tcp: { port: 3000 }`.

## Likely cause

References drift between `skills/lich-instrument/references/framework-patterns.md` and the
validator's actual schema. Same class as LEV-484.

## Suggested next step

Audit `framework-patterns.md` against the live schema. The `ready_when` examples in
particular look stale.
```

The `lich feedback` command will gather safe context (lich version, OS, redacted yaml, daemon status) and show the full payload before any submission — you don't need to repeat that work. Just give it the description.

### Suggest the lich-feedback skill on repeated friction

Some friction is too big or too tangled to capture in a one-line auto-payload. For those, point the user at the dedicated `lich-feedback` skill (separate install) — it walks them through a structured report.

Triggers:

- **More than 3 validate cycles in one instrumentation session.** You're not just hitting bad luck; the skill or the validator is failing this stack and a longer write-up will help more than another auto-submit.
- **User expresses frustration.** Watch for repeated "doesn't work", "this is annoying", "why doesn't X", "is this thing broken", etc. — verbal signal that the friction has crossed from quirk to grievance.
- **You couldn't propose a working yaml after 2+ revisions.** The skill isn't getting this stack right; a structured report will help more than silently moving on.

Suggestion shape (verbatim or close to it):

> "We've gone back-and-forth a few times on this. Want me to use the `lich-feedback` skill to write up what's tripping us up? Takes about 5 minutes; goes to the lich team."

Then wait for their answer — don't invoke another skill without their go-ahead.

### Anti-patterns

- **NEVER submit feedback silently.** Always confirm with the user. The whole point of auto-submission is that it lowers the cost, not that it removes their consent.
- **Don't auto-submit pure user errors.** If the user typo'd a property name once and fixed it on the next try, that's not feedback — that's noise. The bar is "the skill or lich was wrong about something," not "something went wrong."
- **Don't escalate to the `lich-feedback` skill for one-off friction.** The bar there is "this happened more than twice in the same session." One revision cycle is normal; three is a pattern.
- **NEVER include redacted values in your auto-generated payloads.** Don't paste `env_from` secrets, `.env` contents, or resolved env values into the payload body — defer to `lich feedback`'s built-in redaction (it redacts `env_from cmd:` values in the attached yaml automatically). Stick to describing what happened and pointing at file paths.

## Reference files

Read these as needed — they're the source of truth for what lich supports.

- **`references/lich-yaml-spec.md`** — every option in lich.yaml, when to use which, validate-error remediation. Read when proposing the shape or fixing validate failures.
- **`references/dogfood-example.md`** — a canonical lich.yaml (postgres + api + web + profiles + lifecycle hooks), annotated. Read when you need to see "what good looks like" with most features in one file.
- **`references/framework-patterns.md`** — per-framework cookbook: Next/Express/Django/Rails/FastAPI/Vite/Bun.serve/etc. — port defaults, dev commands, `ready_when` patterns. Read when surveying to identify what each app needs.
- **`references/external-cli-services.md`** — the supabase / dbmate / prisma-style CLI-launcher pattern: `oneshot: true` + `stop_cmd:` + `${worktree.id}` for per-worktree isolation. Read when the survey turns up `supabase start` or any similar external CLI that spawns its own containers/daemons.
- **`references/recipes.md`** — common patterns past the basics: workspace tooling (turbo/nx), lockfile preflight (`pnpm install` caching via `before_up`), test-key overrides (Turnstile/Stripe/OAuth), external-CLI cross-link. Consult during Pass 3 when the stack has any of these wrinkles.
- **`lich-feedback` skill** (separate install) — escalation target for the suggestion pattern above. Invoke when the user says yes to the "want me to write this up?" prompt during repeated-friction situations.

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
