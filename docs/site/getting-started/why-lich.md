# Why lich

Lich exists because **running multiple copies of one dev stack on one machine is broken by default**. Compose can't do it (port + project name collisions). Tilt and Skaffold assume Kubernetes. Shell scripts get re-invented per project and don't compose. Lich is the missing layer. 

## The problem

You're working on two branches of the same project. Branch A needs postgres + api + frontend running. Branch B needs the same. Both run on port 5432, both name their compose project `myapp`, both expect to manage their own database state. Running both at the same time requires dynamic port allocation, custom compose project names, running DB migrations and seeds against the correct DB. Without Lich, you'll likely end up writing dynamic port allocation, state management, and log plumming yourself. Managable, but hard to maintain and tangential to the work you should be focused on.

This problem is **acute** for:
- Developers using git worktrees to work on multiple branches in parallel.
- AI coding agents that need an isolated dev stack per task.

## What lich does

One yaml file (`lich.yaml`) describes the stack. Compose services, host processes, env wiring, lifecycle hooks. `lich up` from a worktree:

1. Allocates a unique port for every published service.
2. Namespaces the compose project so containers don't collide with other stacks.
3. Sets up its own state directory.
4. Runs lifecycle hooks (migrations, install caching, warmup).
5. Starts every service and waits for them to be ready.
6. Returns control with a dashboard URL and friendly per-service URLs.

Two worktrees → two stacks running side by side, unaware of each other. No collision possible.

## What it doesn't do

- Not a container runtime. Lich drives `docker` or any compose-compatible runtime (my favorite is OrbStack).
- Not a framework. It drives whatever framework you already use.
- Not a scaffolder. No `create-lich-app`; you add lich to an existing project.
- Not opinionated about your stack. It works the same for Rails, Django, Next.js, Phoenix, Go, anything.

## Next steps

- [Get started](/getting-started/) — install lich and bring up your first stack
- [Read the lich.yaml reference](/reference/lich-yaml-spec) — every key, every option
- [Browse recipes](/recipes/) — patterns for monorepos, external CLIs, custom commands
