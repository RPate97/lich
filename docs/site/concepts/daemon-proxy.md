# Daemon + proxy

The lich daemon is the one long-lived process per machine that turns dynamically-allocated ports into stable friendly URLs.

## What runs where

```
                       +-------------------------------------+
                       | lich-daemon (one per machine)       |
                       |                                     |
  http://*.lich. <---->| HTTP reverse proxy on :3300         |
  localhost:3300/      | Dashboard SPA at :3300/             |
                       | Routing table in memory             |
                       +--------------+----------------------+
                                      |
                                      |  reads ~/.lich/stacks/*/state.json
                                      v
                       +-------------------------------------+
                       | per-stack state (one dir per stack) |
                       | state.json, logs/*, hooks/*         |
                       +-------------------------------------+
                                      ^
                                      |  written by `lich up` / supervisor
                                      |
                       +-------------------------------------+
                       | lich CLI (one process per command)  |
                       | lich up, lich down, lich logs, ...  |
                       +-------------------------------------+
```

The **CLI** (`lich`) is short-lived: each invocation runs and exits. It writes to `~/.lich/stacks/<stack-id>/` for state.

The **daemon** (`lich-daemon`) is long-lived: one per machine, autostarted by any CLI command that needs it. It exposes:

- A reverse proxy on `http://lich.localhost:<proxy-port>/` (default `3300`) that routes friendly URLs to allocated host ports.
- The dashboard SPA at the same address, served as a static asset.
- An HTTP API the CLI uses to fetch routing tables, register / deregister stacks, etc.

The **per-stack state** is the source of truth: each `~/.lich/stacks/<stack-id>/state.json` describes what's running, what ports are allocated, what the service statuses are. The daemon reads this; the CLI writes it.

## How the friendly URLs work

When you `lich up` a stack with an `api` service in a worktree named `my-feature`, the daemon's routing table picks up:

```
api.my-feature.lich.localhost:3300  ->  localhost:<allocated-port>
```

Anyone hitting `http://api.my-feature.lich.localhost:3300/health` reaches the daemon, which proxies the request to whatever port was allocated for that stack's `api` service. No port memorization, no DNS setup — `*.localhost` resolves to loopback on every OS.

The pattern is `<service>.<worktree>.lich.localhost:<proxy-port>` — see [Worktree isolation](/concepts/worktrees-isolation) for why this is the right shape.

## Why `:3300` specifically

The daemon's proxy port defaults to `3300`. You can override it:

- Per stack, in `lich.yaml` under `runtime.proxy_port:`.
- Globally, via the `LICH_PROXY_PORT` env var.

Only pin a non-default port if you need stable friendly URLs across teammates (e.g. for webhook URLs hardcoded in third-party tools). For solo dev, the default is what you want.

## What the dashboard sees

The dashboard at `http://lich.localhost:3300/` reads the same `~/.lich/stacks/*/state.json` files the daemon does. Every stack on the machine shows up — even ones from worktrees you haven't `cd`'d into in days. See the [Dashboard page](/dashboard) for what the UI exposes.

## Debugging routing

If a friendly URL 404s when you expect it to work, run:

```bash
lich routing
```

This prints the daemon's in-memory routing table as JSON. Compare what the daemon has loaded against the routing entries in `~/.lich/stacks/<stack-id>/state.json`. If they don't match, the daemon hasn't picked up a recent state update — restart it (`lich nuke` or kill the daemon process; it'll respawn on the next `lich` command).

## Daemon lifecycle

- **Autostart.** Any CLI command that needs the daemon (`lich up`, `lich dashboard`, `lich urls --proxy`, etc.) spawns it if it's not already running. You almost never need to start it explicitly.
- **One per machine.** Lockfile at `~/.lich/daemon.lock`; second invocations no-op.
- **Stops with `lich nuke`.** Or kill `lich-daemon` directly. It'll respawn on the next CLI command that needs it.

See the [`runtime.proxy_port` section in the lich.yaml reference](/reference/lich-yaml#runtime) for the config options.
