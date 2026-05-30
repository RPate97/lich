# lich

> Worktree-scoped dev stack orchestrator. Run as many dev stacks as you have worktrees.

**What it is:** A single binary that reads a `lich.yaml` file describing your stack (docker containers, host processes, env, lifecycle) and brings it up with per-worktree isolation — dynamic port allocation, isolated state, automatic routing. Run `lich up` in two worktrees, get two independent stacks, no port collisions, no compose project conflicts.

**Who it's for:**
- Developers running parallel branches via git worktrees
- Teams where multiple stacks must coexist on one machine
- Agent-driven workflows that spin up isolated dev environments

**What it isn't:** Not a container runtime (it drives one), not a framework (it drives yours), not a scaffolder, not opinionated about your stack. It's a thin wrapper that gives your existing dev stack a uniform interface.

## Why

Compose alone can't run two copies of the same stack on one machine — ports collide, container names collide, project names collide. Manual port juggling works for one stack; it falls apart at two and is unusable at four. Lich solves the multiplexing problem so you can have N stacks alive simultaneously, one per worktree.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
```

Or download a release tarball from [GitHub Releases](https://github.com/RPate97/lich/releases) and put `lich` on your PATH.

## Quickstart

```bash
cd your-project
lich init               # writes a starter lich.yaml
lich up                 # brings the stack up
lich logs               # tail logs
lich down               # stop it
```

In another worktree of the same repo, `lich up` again — both stacks run side by side.

## Minimal lich.yaml

```yaml
version: 1

services:
  postgres:
    image: postgres:16
    ports:
      - { container_port: 5432, published_env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_PASSWORD: dev

owned:
  api:
    cwd: apps/api
    cmd: pnpm dev
    port: { published_env: PORT }
    env:
      DATABASE_URL: "postgres://postgres:dev@localhost:${services.postgres.host_port}/app"
```

## Docs

The full documentation site lives under [`docs/site/`](docs/site/) (a deployed URL is coming soon). Useful entry points:

- [Getting started](docs/site/getting-started/index.md)
- [lich.yaml reference](docs/site/reference/lich-yaml-spec.md)
- [CLI reference](docs/site/reference/cli.md)
- [Recipes](docs/site/recipes/index.md)
- [Worktree isolation](docs/site/concepts/worktrees-isolation.md)
- [Troubleshooting](docs/site/troubleshooting.md)

## Agent skills

Lich ships agent skills that let Claude (or other agents) work with lich effectively:

- [`lich`](skills/lich/) — daily-driver on-ramp; understand the CLI surface and use it
- [`lich-instrument`](skills/lich-instrument/) — guides an agent through writing your first `lich.yaml`

Add a skill:

```bash
npx skills add https://github.com/RPate97/lich/skills/lich
npx skills add https://github.com/RPate97/lich/skills/lich-instrument
```

## Contributing

Setup:

```bash
git clone https://github.com/RPate97/lich
cd lich
bash scripts/install-git-hooks.sh
```

Build:

```bash
cd packages/lich && bun install && bun run build
```

Test:

```bash
cd packages/lich && bun test                                 # unit
cd packages/e2e && bun run test                              # end-to-end
```

## License

MIT.
