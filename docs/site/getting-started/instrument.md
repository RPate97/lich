# Instrument an existing repo with an agent

Writing a `lich.yaml` from scratch is mechanical work. Survey the repo, name the services, wire the env, get the ports right, run `lich validate`. The `lich-instrument` agent skill does all of this for you.

It's the path of least resistance for getting an existing app onto lich.

## Install the skill

```bash
npx skills add https://github.com/rpate97/lich/skills/lich-instrument
```

This installs the skill into your local agent setup (Claude Code, Cursor, etc. Anywhere the [skills CLI](https://github.com/anthropics/skills) works). The skill ships with reference files for the lich.yaml schema, framework defaults, external-CLI patterns (supabase / dbmate / firebase emulators), and recipes for monorepo tooling.

## Run it

From your repo root, in your favorite agent:

```
/lich-instrument
```

The skill walks four passes:

1. **Survey.** It reads your `package.json` files, any existing `docker-compose.yml`, `Procfile`, framework signals (Next, Express, Django, Rails, FastAPI, Vite, Bun.serve), env files, and per-app dev commands. It does NOT write anything yet.
2. **Interview.** It asks focused questions about the wrinkles only you know: which services lich should manage, env wiring, whether you want profiles, etc. One or two questions at a time, not a barrage. Things it can read from the repo, it doesn't ask.
3. **Propose.** It drafts a `lich.yaml` inline in chat, annotated where the choices are non-obvious. You push back; it revises.
4. **Write + verify.** Once you approve, it writes `lich.yaml`, runs `lich validate`, and reports any issues. On clean validate it points you at `lich up`.

The whole flow usually takes 2-5 minutes for a single-app repo, 5-15 minutes for a monorepo with external CLI services.

## What you get out of it

A `lich.yaml` that:

- Matches your actual dev workflow (not a generic template).
- Uses per-worktree port allocation (the whole point).
- Wires env vars correctly between services (the load-bearing feature).
- Handles your existing `docker-compose.yml` services if you use them.
- Includes profiles only if you asked for them (no profile bloat by default).
- Models external CLI launchers (supabase, dbmate, prisma migrate, firebase emulators, localstack) as oneshot services with proper `stop_cmd:` and per-worktree namespacing via `${worktree.id}` if necessary.

## Tweaking the output

The skill stops as soon as `lich validate` passes. You'll still want to:

- Run `lich up` and confirm everything starts.
- Skim the [recipes](/recipes/) for patterns the skill might have missed (lockfile preflight, test-key overrides, etc).
- Test and debug your setup.

If something is wrong, edit `lich.yaml` directly or point it out and ask your agent to fix it. Then re-run `lich validate`. The skill is a starter, not a permanent middleman. It's not guarenteed to perfectly instrument your stack on the first try. 

> You can think of Lich as a replacement for all of the scripts you use to manage your local development stack. It's powerful, but does require thoughtful setup to perform extremely well.
