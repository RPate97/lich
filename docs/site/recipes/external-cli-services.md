# External CLI services (supabase / dbmate / prisma migrate / firebase emulators / localstack)

**When to use this:** the stack depends on a CLI that spawns its own side-effects — `supabase start` brings up ~10 containers, `dbmate up` runs migrations, `prisma migrate dev` runs migrations and (sometimes) starts a shadow DB. Modeling the launcher as a regular long-lived owned service fails (lich sees the exit and reports a crash); modeling it as `lifecycle.before_up` leaks the spawned side-effects on `lich down`.

This is its own pattern (`oneshot: true` + `stop_cmd:` + `${worktree.id}` for namespacing) and gets full treatment in **`external-cli-services.md`** — read that file when the survey turns up `supabase start` or any similar external-CLI launcher. The short version: oneshot owned service, declare ports up front so they're allocated before the launcher runs, use `${worktree.id}` in the project-id env so parallel worktrees don't collide.

**Supabase-specific caveat:** `SUPABASE_PROJECT_ID` is only honored by `supabase start` and `supabase stop`. Subcommands like `supabase db reset` and `supabase gen types` read `project_id` from `supabase/config.toml` directly, so they target the wrong containers in a multi-worktree setup. The fix is a per-worktree templated workdir passed via `--workdir`. See the "Full per-worktree isolation: templated workdir" section in `external-cli-services.md`.

**Common mistake:** wrapping the launcher in `lifecycle.before_up` so it runs once on `lich up` — the spawned containers stay running after `lich down`, and the second `lich up` collides on container names.
