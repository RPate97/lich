# Lich

lich runs your dev stack with per-worktree isolation, so you can have as many stacks alive as you have coding agents.

## Get Started

Available for macOS (arm64 / x64), Linux (arm64 / x64), and Windows via WSL.

Install the CLI:
```bash
curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
```

Install the instrumentation skill:
```bash
npx skills add https://github.com/rpate97/lich/skills/lich-instrument
```

Set lich up against your repo with your favorite agent:
```bash
/lich-instrument
```

## Run N stacks in N worktrees

This is the entire point of lich.

`lich up` spins up your stack from any worktree, allocates ports dynamically, maps environment variables, namespaces a separate compose project, sets up state tracking, and routes logs to an isolated file. Two worktrees → two stacks running side by side. Ten worktrees → ten stacks. 

The lich CLI automatically detects the worktree it's in and targets the correct stack:
```bash
lich up        -> start an isolated stack
lich logs      -> pull logs from the correct worktree services
lich exec      -> run a command with the correct env variables to target the stack
lich down      -> tear down this worktrees stack
lich urls      -> show reachable urls
lich dashboard -> pull up a dashboard with logs and status of all running stacks
lich nuke      -> tear down every stack on the machine, from anywhere
```

A single shared daemon exposes a friendly URL per service per stack:
```
http://<service>.<worktree>.lich.localhost:3300/
```

No DNS setup, `*.localhost` resolves to the loopback on every OS. No port management, the daemon's reverse proxy figures out where each service is listening. The URL pattern is consistent across worktrees.

## What's in a lich.yaml

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

Two service types: `services` for anything `docker compose` runs, `owned` for processes lich starts directly on the host. Port allocation is automatic; `host_port` / `port` interpolation wires everything together at startup. lich isn't opinionated about your framework, container runtime, or process layout. It wraps whatever you already use.

> lich.yaml has more advanced features (lifecycle hooks, profiles, env_groups, custom commands, and oneshot services for external CLIs like supabase). The full documentation site is being built under [`docs/site/`](docs/site/); until it's live, the canonical reference is in [`skills/lich-instrument/references/`](skills/lich-instrument/references/).

## License

MIT
