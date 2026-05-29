---
layout: home

hero:
  name: Lich
  text: One YAML. N worktrees. N dev stacks.
  tagline: Lich runs your dev stack with per-worktree isolation, so you can have as many stacks alive as you have worktrees.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started/
    - theme: alt
      text: lich.yaml reference
      link: /reference/lich-yaml
    - theme: alt
      text: GitHub
      link: https://github.com/RPate97/lich

features:
  - title: Per-worktree isolation
    details: '`lich up` allocates ports dynamically, namespaces the compose project, gets its own state directory, gets its own log sink. Two worktrees → two stacks running side by side. Ten worktrees → ten stacks.'
  - title: Friendly URLs out of the box
    details: 'A single shared daemon exposes `http://<service>.<worktree>.lich.localhost:3300/` for every service in every stack. No DNS setup, no port management, consistent across worktrees.'
  - title: Containers + host processes, one config
    details: '`services:` for anything `docker compose` runs, `owned:` for host processes lich starts directly. Port allocation is automatic; interpolation wires everything together at startup.'
  - title: A dashboard for every running stack
    details: 'One stack and you remember where everything is. Four stacks started in parallel by four agents and you don''t. The dashboard at `http://lich.localhost:3300/` lists every running stack on the machine.'
---

## Why lich

If you run a single dev stack at a time and you're happy with that, then you don't need lich. If you want to run 10 coding agents in parallel with their own isolated stacks, you need lich.

```bash
lich up        # start the stack
lich down      # tear it down
lich logs      # pull logs from any service
lich urls      # show reachable URLs
lich exec      # run a command with the stack's env loaded
lich dashboard # observability for every running stack on your machine
lich nuke      # tear down every stack on the machine, from anywhere
```

## What's in a `lich.yaml`

```yaml
version: "1"

# docker-compose services
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - { container: 5432, env: POSTGRES_PORT }

# processes lich runs directly
owned:
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

See the full [`lich.yaml` reference](/reference/lich-yaml) for every option, and the [recipes](/recipes/) for patterns past the basics (monorepo task runners, install caching, external CLIs like supabase).
