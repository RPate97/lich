# Why lich

Lich exists because **running multiple copies of one dev stack on one machine is broken by default**. Compose can't do it (port + project name collisions). Tilt and Skaffold assume Kubernetes. Shell scripts get re-invented per project and don't compose. Lich is the missing layer.

## The problem

You're working on two branches of the same project. Branch A needs postgres + api + frontend running. Branch B needs the same. Both run on port 5432, both name their compose project `myapp`, both expect to manage their own database state. Running both at the same time requires manual port juggling, custom compose project names, and DB-state acrobatics — and you'll forget half of it within a week.

This problem is **acute** for:
- Developers using git worktrees to work on multiple branches in parallel.
- AI coding agents that need an isolated dev stack per task.
- CI environments running multiple ephemeral previews.

## What lich does

One yaml file (`lich.yaml`) describes the stack — compose services, host processes, env wiring, lifecycle hooks. `lich up` from a worktree:

1. Allocates a unique port for every published service.
2. Namespaces the compose project so containers don't collide with other stacks.
3. Sets up its own state directory.
4. Runs lifecycle hooks (migrations, install caching, warmup).
5. Starts every service and waits for them to be ready.
6. Returns control with a dashboard URL and friendly per-service URLs.

Two worktrees → two stacks running side by side, unaware of each other. No collision possible.

## Who benefits

- **Solo developers** maintaining multiple branches in parallel via git worktrees
- **Teams** where multiple people might run the same stack on shared dev infra
- **Agent-driven workflows** spinning up isolated environments for each task
- **CI pipelines** running parallel preview environments on a single runner

## What it doesn't do

- Not a container runtime — drives `docker` or any compose-compatible runtime
- Not a framework — drives whatever framework you already use
- Not a scaffolder — no `create-lich-app`; you add lich to an existing project
- Not opinionated about your stack — works the same for Rails, Django, Next.js, Phoenix, Go, anything

## Compared to

| | docker compose | Tilt / Skaffold | Lich |
| --- | --- | --- | --- |
| Worktree isolation | manual port + name juggling | requires K8s | built-in |
| Host process supervision | no (containers only) | partial | yes |
| Lifecycle hooks (migrations, install caching) | not first-class | yes | yes |
| Friendly URLs out of box | no | yes (K8s ingress) | yes (HTTP proxy daemon) |
| Single binary | n/a (Docker dependency) | depends | yes |
| Runtime agnostic | tied to Docker | tied to K8s | uses any compose runtime |

## Next steps

- [Get started](/getting-started/) — install lich and bring up your first stack
- [Read the lich.yaml reference](/reference/lich-yaml-spec) — every key, every option
- [Browse recipes](/recipes/) — patterns for monorepos, external CLIs, custom commands
