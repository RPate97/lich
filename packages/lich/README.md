# lich

A worktree-scoped dev stack orchestrator. See the v1 design spec at
`docs/superpowers/specs/2026-05-23-lich-v1-design.md`.

## Status

Pre-alpha. Plan 0 (foundation + failing test case) complete; Plans 1-6
add functionality tier by tier.

## Development

```bash
# Install deps
bun install

# Run the CLI from source
bun run dev --version

# Build everything (UI + CLI + daemon)
bun run build
./dist/lich --version

# Or build a single piece during inner-loop work
bun run build:ui      # vite-builds the dashboard SPA
bun run build:cli     # compiles the `lich` CLI binary
bun run build:daemon  # compiles the `lich-daemon` binary

# Run unit tests
bun test
```

`bun run build` produces two binaries:

- `dist/lich` — the user-facing CLI (`lich up`, `lich down`, etc.)
- `dist/lich-daemon` — the background daemon that hosts the dashboard
  HTTP server + reverse proxy. The CLI auto-starts this on the first
  `lich up` of a session; the user never invokes it directly.

The dashboard SPA is built first because the daemon binary references the
SPA's `dist/` directory at runtime to serve static assets.

## End-to-end tests

E2e tests live at `../../tests/e2e/`. They build the binary, copy
`examples/dogfood-stack/` to a tmpdir, and exercise `lich` against it.

```bash
cd ../../tests/e2e && bun test
```

At end of Plan 0, every e2e test fails (lich is a stub). Each
subsequent plan turns tests green.

## Daemon

The daemon is a long-lived background process that hosts the dashboard
UI and the friendly-URL reverse proxy. One per machine; never invoked
directly by users.

- **Binary:** `dist/lich-daemon` (separate from `dist/lich`).
- **Auto-starts** on the first `lich up` of a session. Records its PID
  at `~/.lich/daemon.pid` and its dashboard URL at `~/.lich/daemon.url`.
- **Auto-stops** ~30 seconds after the last stack exits (auto-shutdown
  polls every 10s; needs 3 consecutive empty checks). Stacks with
  status `stopped` or `failed` don't count as alive — they're history.
- **Force-kill** with `lich nuke`, which SIGTERMs the daemon and clears
  the PID/URL files.
- **Failure to start is non-fatal:** if the daemon can't bind (port
  conflict, etc.), `lich up` prints a warning and continues. The CLI
  still works without the daemon.

## Dashboard

The supervisory web UI. Served by the daemon at the URL recorded in
`~/.lich/daemon.url` (allocated port, bound to `127.0.0.1` only).

- **Auto-opens** in your default browser on the first daemon start of a
  session. Pass `lich up --no-browser` to suppress (the URL is still
  printed in the up summary so you can open it manually).
- **`/`** — list of every stack on the machine, with service counts,
  status, and any failed-service callouts.
- **`/stacks/<id>`** — per-stack detail: services, allocated ports,
  active profile, captured values, friendly URLs, live log tail.
- **Stop** and **Restart** buttons shell out to `lich down` /
  `lich restart` in the stack's worktree.
- Subsequent `lich up`s that hit an already-running daemon do NOT
  reopen the browser.

## Friendly URLs

The daemon hosts a reverse proxy (default port `3300`) that routes by
`Host` header. Pattern:

```
http://<service>.<worktree>.lich.localhost:3300/
```

For services with multiple ports, each logical port gets its own host:

```
http://supabase-api.feature-x.lich.localhost:3300/
http://supabase-db.feature-x.lich.localhost:3300/
```

**Why `*.localhost` works with no setup:** modern OSes (macOS, Linux,
Windows) and modern browsers resolve `*.localhost` to `127.0.0.1`
automatically per RFC 6761. No `/etc/hosts` editing or DNS config.

**`--raw` fallback:** if friendly URLs don't work in your environment
(some Docker-in-Docker setups, restrictive corporate resolvers, etc.),
`lich urls --raw` prints direct `http://127.0.0.1:<port>/` URLs that
bypass the proxy entirely. Also useful for WebSocket-heavy services
(see Known limitations).

## Environment variables

- **`LICH_HOME`** — overrides `~/.lich/` as the state root. Honored by
  every command and by the daemon; primarily for test isolation
  (each e2e test uses its own tmpdir).
- **`LICH_PROXY_PORT`** — overrides the proxy port (default `3300`).
  Read by `dist/lich-daemon` at startup; usually set indirectly via
  `runtime.proxy_port` in `lich.yaml`.

## Known limitations

- **No WebSocket proxying.** The reverse proxy is HTTP-only for v1;
  `Upgrade: websocket` requests are forwarded as plain HTTP and will
  fail to upgrade. Use `lich urls --raw` to get direct `127.0.0.1:<port>`
  URLs for WebSocket-heavy services.
- **`localhost` IPv6 resolution.** On some macOS configs `localhost`
  resolves to `::1` (IPv6) before `127.0.0.1`. The proxy binds IPv4
  only; if browsers reach for the IPv6 address first, friendly URLs
  can hang. Workaround: use `--raw` URLs or pin `127.0.0.1`. A proper
  fix is tracked separately.
- **Daemon auto-shutdown grace is ~30s.** Tests that bring stacks up
  and down in tight succession may want `lich nuke --yes` between runs
  to force-clear the daemon rather than waiting for the grace window.

## Contributing

See [`CLEANUP-HINTS.md`](./CLEANUP-HINTS.md) for small refactor
opportunities that aren't worth their own ticket but should get picked
up the next time someone is already in the neighborhood.
