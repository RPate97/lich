# lich

Worktree-scoped dev stack orchestrator. Run as many dev stacks as you have worktrees.

**What it is** 

A CLI that reads a `lich.yaml` file describing your stack (docker containers, host processes, env variables, lifecycle) and brings it up with per-worktree isolation. Run `lich up` in two worktrees, get two independent stacks running whatever code exists in those worktrees.

**Who it's for** 

Developers who want to run parallel development stacks from multiple worktrees. Typically this is to enable workflows that make using parallel agents.

## Why

Traditional local dev tooling is done ad hoc. It uses various tools: bash/npm scripts, procfiles, docker compose, etc. These systems generally can't run multiple copies of the same stack on one machine at the same time. Ports collide, container names conflict, memory leaks from zombie processes never cleaned up, agents get derailed running down bugs in tooling instead fixing actual problems. Lich implements a robust and observable system to manage this complexity.

## Install

```bash
curl -fsSL https://lich.sh/install.sh | bash
```

Or download a release tarball from [GitHub Releases](https://github.com/RPate97/lich/releases) and put `lich` on your PATH.

## Quickstart

The fastest way to see lich working is the [t3 starter](https://github.com/RPate97/lich-starter-t3). A [T3 Stack](https://create.t3.gg/) (Next.js + tRPC + Prisma + Postgres + Tailwind) preconfigured with a `lich.yaml`:

```bash
git clone https://github.com/RPate97/lich-starter-t3
cd lich-starter-t3
lich up
```

Postgres boots in a Docker container on a dynamically allocated port, `DATABASE_URL` is wired automatically, Prisma pushes the schema, Next.js starts. Open the URL lich prints and you have a working full-stack app.

### Run two stacks in parallel

Add a worktree and bring up a second stack from the same template:

```bash
git worktree add ../lich-starter-t3-feature -b feature
cd ../lich-starter-t3-feature
lich up
lich stacks
```

```
WORKTREE                       STATUS  UPTIME    SERVICES  URL
lich-starter-t3                up      00:02:15  2/2       http://web.lich-starter-t3.lich.localhost:3300/
lich-starter-t3-feature        up      00:00:08  2/2       http://web.lich-starter-t3-feature.lich.localhost:3300/
```

Two stacks. Two databases. Two dev servers. No port collisions. Same `lich.yaml`. Both URLs work independently in your browser.

### Use lich on your own app

To wire lich into an existing app, install the `lich-instrument` skill and run it in your coding agent:

```bash
npx skills add https://github.com/RPate97/lich/skills/lich-instrument
```

```bash
/lich-instrument
```

The skill walks an agent through writing a `lich.yaml` for your stack. You may need to iterate a few times to get the env variable mapping and loading right; if you get stuck, the [lich.yaml reference](https://lich.sh/reference/lich-yaml-spec) is the place to look. Then it's the same workflow:

```bash
lich up                 # brings the stack up
lich logs               # tail logs
lich down               # stop it
```

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

Full docs at **[lich.sh](https://lich.sh)**. Entry points:

- [Getting started](https://lich.sh/)
- [lich.yaml reference](https://lich.sh/reference/lich-yaml-spec)
- [CLI reference](https://lich.sh/reference/cli)
- [Recipes](https://lich.sh/recipes/)
- [Worktree isolation](https://lich.sh/concepts/worktrees-isolation)
- [Troubleshooting](https://lich.sh/troubleshooting)

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

## Telemetry

Lich collects anonymous CLI usage telemetry (command name, exit code, duration, version, platform). No paths, no `lich.yaml` contents, no env values, no log content. Anonymous per-installation UUID stored at `~/.lich/installation-id`.

Disable:

```bash
export LICH_TELEMETRY=0                      # per-shell
echo '{"telemetry":false}' > ~/.lich/config.json  # per-user, persistent
```

Or in `lich.yaml`:

```yaml
runtime:
  telemetry: false
```

Full disclosure of what's collected, where it goes, and how to delete the per-installation ID: [lich.sh/telemetry](https://lich.sh/telemetry).

## License

MIT.
