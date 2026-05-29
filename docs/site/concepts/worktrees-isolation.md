# Worktree isolation

This is the entire point of lich.

## What "worktree" means here

A git worktree is one of the multiple working trees attached to a single repository. You make one per branch you're actively working on:

```bash
git worktree add ../my-repo-feature-x feature-x
```

Now you have `~/repos/my-repo/` (the main checkout) and `~/repos/my-repo-feature-x/` (a sibling worktree on the `feature-x` branch). Both share the same `.git/` storage; both have their own working files; both can run independently.

The killer use case is **N parallel coding agents on the same repo, each in their own worktree, each working a different ticket**. The agents don't collide on files. But without lich, they collide on every dev resource the stack uses: ports, container names, log files, dashboard tabs, state directories, allocated cloud resources.

## What lich does about it

`lich up` from any worktree:

- **Allocates ports dynamically.** Every `port:` / `ports:` declaration in `lich.yaml` gets a real, unused host port assigned at startup. Two worktrees → two different port assignments → no conflict.
- **Namespaces the compose project.** Lich generates a per-stack `compose.override.yaml` and runs `docker compose --project-name lich-<worktree-id>-<hash>` so container names don't collide.
- **Gets its own state directory** under `~/.lich/stacks/<stack-id>/`. State, logs, hook output, capture files — all isolated per stack.
- **Gets its own dashboard entry** in `http://lich.localhost:3300/` so you can see all running stacks at a glance.
- **Per-worktree namespacing of external resources** via `${worktree.id}` — see [Oneshot services](/concepts/oneshot-services) for the supabase / dbmate / temporal pattern.

The first time you do this, you'll feel it: open one worktree, `lich up`, hit the friendly URL. Open a second worktree, `lich up`, hit a *different* friendly URL. Both stacks are running. Neither knows about the other.

## Friendly URLs are consistent across worktrees

A single shared daemon (one per machine, autostarted by any `lich` command that needs it) exposes a URL per service per stack:

```
http://<service>.<worktree>.lich.localhost:3300/
```

For two worktrees of `my-app` (named `main` and `feature-x`):

```
http://api.main.lich.localhost:3300/         -> stack 1's api
http://web.main.lich.localhost:3300/         -> stack 1's web
http://api.feature-x.lich.localhost:3300/    -> stack 2's api
http://web.feature-x.lich.localhost:3300/    -> stack 2's web
```

The URL pattern is consistent. You don't have to remember which port maps to which service in which worktree — the daemon's reverse proxy figures it out.

## CLI auto-detects the worktree

Every `lich` command run from inside a worktree targets that worktree's stack automatically:

```bash
cd ~/repos/my-repo
lich logs          # logs from stack 1

cd ~/repos/my-repo-feature-x
lich logs          # logs from stack 2
```

No `--worktree` flag, no project_name env var, no `lich set-active-stack`. The CLI walks up from `cwd` looking for `lich.yaml` and resolves the worktree from there.

## What's stable, what's dynamic

| Thing | Stable across runs? | Stable across worktrees? |
|-------|---------------------|--------------------------|
| Worktree name (`${worktree.name}`) | yes | no — derived from dir name |
| Worktree id (`${worktree.id}`) | yes | no — hash of absolute path |
| Friendly URL hostname | yes | no — includes worktree name |
| Allocated host port | no — re-allocated on each `lich up` | n/a |
| Compose project name | yes per worktree | no |
| State directory path | yes per worktree | no |

Use `${worktree.id}` for anything that needs per-worktree namespacing of external resources (supabase project_id, KV namespaces, S3 prefixes, cloud env names). Use `${worktree.name}` only when you want something human-readable (logging, dashboards). Don't rely on the host port being stable — that's the point of dynamic allocation.

## Read next

- [Daemon + proxy](/concepts/daemon-proxy) — how the friendly URLs route to the dynamically-allocated ports.
- [Oneshot services](/concepts/oneshot-services) — using `${worktree.id}` for external CLI launchers (supabase, dbmate).
