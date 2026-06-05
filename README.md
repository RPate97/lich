# lich

> Worktree-scoped dev stack orchestrator. Run as many dev stacks as you have worktrees.

**What it is:** A CLI that reads a `lich.yaml` file describing your stack (docker containers, host processes, env variables, lifecycle) and brings it up with per-worktree isolation. Ports are allocated and mapped dynamically, state is isolated, service communication is properly routed. Run `lich up` in two worktrees, get two independent stacks running whatever code exists in those worktrees.

**Who it's for:** Developers who want to run parallel development stacks from multiple worktrees. Typically this is to enable workflows that make using parallel agents.

**What it isn't:** Not a container runtime (it drives one), not a framework (it drives yours), not a scaffolder, not opinionated about your stack. It's a thin wrapper on top of your existing stack that allows it to run in parallel with a consistent interface.

## Why

Traditional local dev tooling is done ad hoc. It uses various tools: bash/npm scripts, procfiles, docker compose, etc. These systems generally can't run multiple copies of the same stack on one machine at the same time. Ports collide, container names conflict, memory leaks from zombie processes never cleaned up, agents get derailed running down bugs in tooling instead fixing actual problems. Lich implements a robust and observable system to manage this complexity.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
```

Or download a release tarball from [GitHub Releases](https://github.com/RPate97/lich/releases) and put `lich` on your PATH.

## Quickstart

Install the instrumentation skill:
```bash
npx skills add https://github.com/RPate97/lich/skills/lich-instrument
```

Open your favorite coding agent and run the skill:
```bash
/lich-instrument
```

> You may need to iterate a few times with your coding agent to get the lich.yaml setup correctly. You'll want to pay particular attention to environment variable mapping and loading. If you get stuck, take a look at the [lich.yaml reference](/reference/lich-yaml). It's recommended to start with a smaller slice of your stack such as just your UI and database to get a feel for lich before instrumenting your entire application especially if you are running a large multi-service app.

Start using Lich:
```bash
lich up                 # brings the stack up
lich logs               # tail logs
lich down               # stop it
```

In another worktree of the same repo, `lich up` again. Both stacks run side by side.

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
