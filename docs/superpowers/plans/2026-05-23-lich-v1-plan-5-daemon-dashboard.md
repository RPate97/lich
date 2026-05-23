# Lich v1 — Plan 5: Daemon, Dashboard, and Friendly URLs

> **Status:** HIGH-LEVEL SHELL — task structure captured; per-task code/steps to be refined when this plan is ready to execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 6 dashboard + daemon, 5 friendly URLs in `lich urls`, 9 daemon project structure)

**Required reading:** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`

**Goal:** Stand up the supervisory surface for parallel-stack work. A single per-machine daemon process hosts the dashboard, the reverse proxy for friendly URLs, and a state watcher. Friendly URLs (`<service>.<worktree>.lich.localhost:<proxy-port>`) work without any system setup. Dashboard auto-starts on first `lich up` and auto-stops when no stacks remain. The dashboard UI is ported from `packages/dashboard/` and adapted to the new state model.

**Builds on:** All previous plans. Daemon needs Plan 3's state directory (with active profile) and Plan 4's failure metadata to render correctly.

**Architecture:** The daemon is a single Bun process started by `lich up` (if not already running) that lives until the last stack stops. It hosts: (1) the dashboard HTTP server on an allocated port (recorded in `~/.lich/daemon.url`), (2) the reverse proxy on the configured `runtime.proxy_port` (default 3300), (3) a filesystem watcher on `~/.lich/stacks/`. Discovery is on-disk (no IPC required from `lich up` invocations). The UI is a static SPA the dashboard server serves; it fetches state via an HTTP API. The proxy routes by `Host` header (`*.lich.localhost` resolves to `127.0.0.1` automatically on modern browsers/OSes — no `/etc/hosts` edits needed).

---

## What this plan implements

From the spec section 6:

- **Daemon process** with three responsibilities: dashboard server, proxy server, state watcher
- PID file at `~/.lich/daemon.pid`; stale PID detection; auto-start on first `lich up`
- Auto-shutdown: every 10s, check `~/.lich/stacks/`; if no stacks for 3 consecutive checks (≈30s), exit cleanly
- Dashboard fails gracefully if it can't bind (port conflict) — does NOT fail the user's `lich up`
- Dashboard auto-open in default browser on first daemon start; `--no-browser` flag opts out

Dashboard pages:

- `/` — list of every stack on the machine (worktree name, service count, status, failed count, uptime, friendly URLs)
- `/stacks/<id>` — service list with per-service status (starting / healthy / initializing / ready / stopping / failed); live log tail; captured values (e.g., tunnel URLs); stop/restart buttons; failed services rendered in red with reason inline
- `/stacks/<id>/services/<name>` — per-service detail with logs, env (secrets masked), failure context highlighted

Friendly URLs:

- Reverse proxy on `runtime.proxy_port` (default 3300)
- URL shape: `http://<service>.<worktree>.lich.localhost:3300/`
- Routing entries written by each stack to `~/.lich/stacks/<id>/state.json`; proxy watches state directory and reloads routing on change
- `lich urls` prints friendly URLs by default; `lich urls --raw` also prints raw `localhost:<port>`

---

## Subsystems introduced

### `daemon/`

NEW package internal — runs as its own process spawned by `lich up`.

- `daemon.ts` — main entry; starts dashboard + proxy + watcher; handles auto-shutdown
- `pid-file.ts` — PID file management with stale detection
- `watcher.ts` — `chokidar` on `~/.lich/stacks/`; on changes, refresh in-memory state
- `auto-start.ts` — called from `lich up`; detects whether daemon is running, starts it if not

### `daemon/dashboard/`

HTTP server + static SPA.

- `server.ts` — Bun.serve with REST endpoints (`/api/stacks`, `/api/stacks/<id>`, `/api/stacks/<id>/logs?service=X`)
- `ui/` — ported from `packages/dashboard/` static assets (or adapted: same React/SolidJS/whatever it uses)
- `actions.ts` — handle stop/restart actions (exec the relevant lich command in the right cwd)

### `daemon/proxy/`

HTTP reverse proxy with Host-header routing.

- `proxy.ts` — Bun.serve with reverse-proxy mode; routes by `Host` to allocated ports
- `routing.ts` — read routes from state directory; refresh on watcher events
- `*.lich.localhost` resolution — no special handling needed; OS/browser does it; document this

### `commands/urls.ts` (extended)

- Default: print friendly URLs from state directory
- `--raw` flag: also print `localhost:<allocated_port>`

### `commands/up.ts` (extended)

- After successful stack startup: ensure daemon is running (idempotent)
- Open browser if first daemon start AND not `--no-browser`

### `commands/down.ts` (extended)

- After stack teardown: state watcher will pick up the removal; daemon's auto-shutdown logic handles process exit if last stack

### `commands/nuke.ts` (extended)

- Also kill the daemon process (via PID file)

---

## File structure delta

```
packages/lich/src/
  daemon/
    daemon.ts                    # main daemon entry
    pid-file.ts
    watcher.ts
    auto-start.ts
    dashboard/
      server.ts
      ui/                        # ported from packages/dashboard/
      actions.ts
    proxy/
      proxy.ts
      routing.ts
  commands/
    urls.ts                      # EXTEND: friendly URLs default, --raw flag
    up.ts                        # EXTEND: trigger daemon auto-start, browser open
    nuke.ts                      # EXTEND: kill daemon
  bin/
    lich-daemon.ts               # daemon entry point (or subcommand of lich)

packages/lich/tests/unit/
  daemon/
  commands/                       # add tests for friendly URLs

tests/e2e/
  daemon-lifecycle.test.ts       # daemon auto-start + auto-shutdown
  friendly-urls.test.ts          # *.lich.localhost routing works
  dashboard-shows-stack.test.ts  # dashboard reflects current state
  dashboard-shows-failure.test.ts # failed service rendered correctly
```

---

## Task list (high-level)

1. **Decide daemon entry point** — separate binary (`lich-daemon`) or subcommand of `lich` (`lich daemon`). Either works; lean toward subcommand for single-binary distribution.
2. **PID file management** — write/read PID, stale detection via process-exists check
3. **State directory watcher** — chokidar (or Bun's native watch) on `~/.lich/stacks/`
4. **Auto-start hook in `lich up`** — idempotent: check PID file, start daemon if not running
5. **Auto-shutdown logic** — periodic check, exit when no stacks for K consecutive checks
6. **Dashboard HTTP server** — Bun.serve; endpoints for stack list, stack detail, per-service logs
7. **Port dashboard UI from `packages/dashboard/`** — copy components/pages/styles; replace data fetching layer to hit new endpoints
8. **Adapt UI to new state model** — service states (starting/healthy/initializing/ready/stopping/failed), profile awareness, captured values
9. **Stop/restart action endpoints** — shell out to `lich down`, `lich restart` in the right worktree
10. **Reverse proxy server** — Bun.serve with Host-header routing; reads routes from state directory
11. **State entry: routing table** — each stack writes its `<service>.<worktree>` → `localhost:<port>` mappings
12. **`lich urls` friendly default + `--raw` flag**
13. **Browser auto-open on first daemon start** — `open` command (macOS) or `xdg-open` (Linux); `--no-browser` flag
14. **Failed-service rendering in dashboard** — red badge, reason inline, log window highlight
15. **E2e tests** for daemon lifecycle, friendly URLs, dashboard visibility, failure visibility

---

## Cross-plan dependencies

- Plan 1 (state directory, lich up/down)
- Plan 3 (active_profile in state — dashboard shows it)
- Plan 4 (failure metadata in state — dashboard renders it)
- v0's `packages/dashboard/` is the source for the UI port (Plan 6 deletes it after this plan ports what's needed)

---

## Testing requirements

E2e coverage floor:

- **Daemon auto-starts** on first `lich up` (PID file appears)
- **Daemon auto-stops** within ~30s after the last stack stops
- **PID file cleanup** on clean shutdown
- **Friendly URL resolution** — `curl http://api.<worktree>.lich.localhost:3300/health` returns the expected response (verifies the *.localhost routing convention + proxy works)
- **Friendly URLs in `lich urls`** — output contains the expected friendly URL strings; `--raw` adds raw localhost ones
- **Dashboard lists running stacks** — HTTP GET `/api/stacks` returns the right shape
- **Dashboard shows per-service status** — start a stack, fetch `/api/stacks/<id>`, verify service list and statuses
- **Dashboard shows failed service** — start a stack with a deliberately failing service; dashboard shows it red with reason
- **Stop button via dashboard** — POST to action endpoint; stack tears down
- **Two stacks visible simultaneously** — both appear in dashboard list with their distinct friendly URLs
- **Plan 0's `basic-up.test.ts` "brings the stack up and serves the web app" test PASSES** — this is the test that hit `http://web.dogfood-stack.lich.localhost:3300/`; it requires this plan's friendly URLs to work

---

## Acceptance criteria

Plan 5 is done when:

- `lich up` on the dogfood-stack auto-starts the daemon and opens the dashboard in the browser
- Dashboard shows the stack with all services healthy and friendly URLs
- `http://web.dogfood-stack.lich.localhost:3300/` works in a browser
- Two parallel `lich up` invocations from different tmpdirs both show in the dashboard with distinct friendly URLs
- `lich down` for one stack leaves the other visible and reachable
- `lich nuke` kills daemon + all stacks
- Plan 0's "brings the stack up and serves the web app" test (`tests/e2e/basic-up.test.ts`) now passes
- All Plan 5 e2e tests pass
