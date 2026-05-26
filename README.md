# Lich

A worktree-aware dev stack orchestrator for agents (and humans).

```bash
lich up        # start the stack
lich down      # tear it down
lich urls      # show reachable URLs
lich exec      # run a command with the stack's env loaded
lich logs      # tail logs from any service
lich dashboard # observability dashboard for humans
lich nuke      # tear down every stack on the machine from anywhere
lich help      # include in skills for discoverability
```

## Get Started

Available for macOS (arm64 / x64), Linux (arm64 / x64), and Windows via WSL.

Install the CLI:
```bash
curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
```

Install the instrumentation skill:
```bash
npx skills add https://github.com/rtpate97/lich-instrument
```

Setup lich with your favorite agent:
```bash
/lich-instrument
```

## Why lich exists

Git worktrees let you check out N branches at once. They are the natural structure for parallel work with coding agents, but most dev tooling assumes one stack at a time. The moment two agents start a dev stack in parallel, everything breaks. Default ports overlap, compose project names collide, the frontend from worktree A connects to the backend from worktree B, logs become unmanageable, etc.

Lich is built to enable N agents running N stacks on a single machine at the same time with excellent observability for humans.

## How it works

Each worktree gets its own slug, its own ephemeral port allocations, its own compose project namespace, it's own log file sink, and its own state directory. The `lich.yaml` describes the stack you want to run. `lich up` from any worktree brings up *that* worktree's stack without touching its siblings.

A single shared daemon exposes a friendly URL per service:

```
http://<service>.<worktree>.lich.localhost:3300/
```

No DNS setup, `*.localhost` resolves urls on every OS. The lich daemon's reverse proxy routes to the correct service. The same daemon serves a dashboard at `http://lich.localhost:3300/` listing every running stack on the machine for observability.

## What's in a lich.yaml

```yaml
version: "1"

services:                                # docker-compose services
  postgres:
    image: postgres:16-alpine
    ports:
      - { container: 5432, env: POSTGRES_PORT }

owned:                                   # processes lich runs directly
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { env: PORT }
    ready_when:
      http_get: /health

env:
  DATABASE_URL: "postgresql://postgres@localhost:${services.postgres.host_port}/myapp"
```

Two service types: `services` for anything `docker compose` runs, `owned` for processes lich starts directly on the host. Port allocation is automatic; `host_port` / `port` interpolation wires everything together at startup. Lich isn't opinionated about your framework, container runtime (Docker, OrbStack, Podman, nerdctl), or process layout. It wraps whatever you already use.

> lich.yaml is a powerful configuration interface with many advanced features including lifecycle hooks, profiles, environment variable loading, and arbitrary command extension. [Read the full documentation]().

## Quickstart

### TODO - lich instrument skill

### TODO - real example app

### TODO - Run two stacks in parallel

## License

MIT
