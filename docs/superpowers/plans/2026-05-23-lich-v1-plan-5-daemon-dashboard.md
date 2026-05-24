# Lich v1 — Plan 5: Daemon, Dashboard, and Friendly URLs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 6 dashboard + daemon, 5 friendly URLs in `lich urls`, 9 daemon project structure, 3 per-machine vs per-worktree state)

**Required reading (every subagent on every task):** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md` — both tiers (unit + e2e) for every feature; e2e tests spawn the real binary against `examples/dogfood-stack/`.

**Goal:** Stand up the supervisory surface for parallel-stack work. A single per-machine daemon process hosts the dashboard, the reverse proxy for friendly URLs, and a state watcher. Friendly URLs (`<service>.<worktree>.lich.localhost:<proxy-port>`) work without any system setup. Dashboard auto-starts on first `lich up` and auto-stops when no stacks remain. The dashboard UI is ported from `packages/dashboard/` and adapted to the new state model.

**Builds on:** All previous plans. Daemon needs Plan 3's `state.json` (which carries `active_profile`) and Plan 4's failure metadata (`failure_reason` + `failure_log_tail`) to render correctly. Live-tail subscribes to the `LogTail` primitive at `packages/lich/src/logs/tail.ts`.

**Architecture:** The daemon is a single Bun process started by `lich up` (when not already running) that lives until the last stack stops. It hosts: (1) the dashboard HTTP server on an allocated port (recorded in `~/.lich/daemon.url`), (2) the reverse proxy on the configured `runtime.proxy_port` (default 3300), (3) a `chokidar` filesystem watcher on the state root. Discovery is on-disk — `lich up` writes routing entries to `state.json`; the daemon picks them up automatically without IPC. The UI is a static React SPA the dashboard server serves; it fetches state via REST endpoints and live-tails logs via SSE. The proxy routes by `Host` header (`*.lich.localhost` resolves to `127.0.0.1` automatically on modern browsers/OSes — no `/etc/hosts` edits needed).

**Tech stack:** TypeScript on Bun. `Bun.serve` for the HTTP server and proxy (Bun has a native reverse-proxy mode via `fetch` returning a `Response` from `fetch(req.url)` to the upstream). React + Vite + `@vitejs/plugin-react` for the dashboard UI (matches v0). `chokidar` for the filesystem watcher (the v0 dashboard subprocesses `fs.watch` and it has cross-platform quirks; chokidar smooths them).

---

## What this plan implements

From the spec section 6:

- **Daemon process** with three responsibilities: dashboard server, proxy server, state watcher
- PID file at `~/.lich/daemon.pid`; URL file at `~/.lich/daemon.url`; stale PID detection via `process.kill(pid, 0)`; auto-start on first `lich up`
- Auto-shutdown: every 10s, check the state root for stacks with `status` in `up`/`starting`/`partial`/`stopping`. If none for 3 consecutive checks (~30s), exit cleanly. Stacks with `status: stopped` or `status: failed` don't count toward "alive" — they're history.
- Dashboard fails gracefully if it can't bind (port conflict, etc.) — does NOT fail the user's `lich up`; warning printed; CLI continues.
- Dashboard auto-open in default browser on first daemon start; `--no-browser` flag on `lich up` opts out. Subsequent starts don't reopen.

Dashboard pages and endpoints:

- `GET /api/stacks` — list of every stack on the machine (one entry per `~/.lich/stacks/<id>/state.json`)
- `GET /api/stacks/:id` — stack detail (services, allocated ports, active profile, captured values, friendly URLs)
- `GET /api/stacks/:id/logs?service=<name>` — SSE stream of live log lines, tail-from-now for one service via `LogTail`
- `GET /api/stacks/:id/logs` — SSE merged stream across all services for the stack
- `POST /api/stacks/:id/stop` — shell out to `lich down` in the stack's worktree
- `POST /api/stacks/:id/restart` — shell out to `lich restart` in the stack's worktree (when Plan 1's restart lands; v1 ships with at least `stop`)
- Static SPA for `/` and any non-`/api/*` path; SPA fallback to `index.html`

Friendly URLs:

- Reverse proxy on `runtime.proxy_port` (default 3300)
- URL shape: `http://<service>.<worktree>.lich.localhost:3300/`
- Routing entries written by each stack into a `routing` block in `state.json` (so the proxy reads the same `state.json` the dashboard reads — no second on-disk surface)
- Proxy reloads routing on `chokidar` change events
- `lich urls` prints friendly URLs by default; `lich urls --raw` switches to raw `localhost:<port>` (Plan 1 default kept under `--raw`)

Out of scope (deferred to later or non-goals):

- Switching profiles via dashboard (would require teardown + restart confirmation; v1.x at earliest)
- Real-time metrics charts (CPU/RAM) — v0 had this; v1 design defers it; per-stack metrics removed from `StackView`
- Binding proxy to `:80` — requires sudo/setcap; out of scope
- Restart for individual services via dashboard (v1.x)
- Authentication on the dashboard — local-only, 127.0.0.1-bound, no auth needed

---

## Subsystems introduced

### `daemon/`

NEW internal package — runs as its own process spawned by `lich up`.

- `daemon.ts` — main entry; starts dashboard + proxy + watcher; handles auto-shutdown; SIGTERM cleanup
- `pid-file.ts` — PID file + URL file management with stale detection
- `watcher.ts` — `chokidar` on the state root; debounced refresh callback fed to dashboard + proxy
- `auto-start.ts` — called from `lich up`; detects running daemon, spawns the daemon binary if not running, waits for the URL file to appear, returns the URL

### `daemon/dashboard/`

HTTP server + static SPA.

- `server.ts` — `Bun.serve` router, REST + SSE endpoints
- `stacks-view.ts` — converts `StackSnapshot` to `StackView` JSON (dashboard's wire format)
- `actions.ts` — handles POST `/stop` and `/restart` by spawning `lich down`/`restart` in the stack's worktree
- `ui/` — Vite + React SPA, ported from `packages/dashboard/src/web/`

### `daemon/proxy/`

HTTP reverse proxy with Host-header routing.

- `proxy.ts` — `Bun.serve` with reverse-proxy mode; reads in-memory routing table
- `routing.ts` — turns `state.json` routing entries into a `Map<hostname, upstreamUrl>`; refreshed on watcher events

### `commands/urls.ts` (extended)

- Default: print friendly URLs by reading the local stack's `state.json` and synthesizing `<service>.<worktree>.lich.localhost:<proxy_port>/`
- `--raw` flag: print raw `localhost:<allocated_port>` (Plan 1 default semantics)

### `commands/up.ts` (extended)

- After successful stack startup: ensure daemon is running (idempotent)
- Write `routing` block into `state.json`
- Open browser if first daemon start AND not `--no-browser`

### `commands/down.ts` (extended)

- Clear the stack's `routing` block on teardown (so the proxy stops serving the stale entries within one watcher tick)

### `commands/nuke.ts` (extended)

- After per-stack teardown: kill the daemon process via its PID file (best-effort)

### `commands/restart.ts` (NEW — Plan 1 listed it as a stub; this plan promotes it to a real command)

- Whole-stack restart: down + up
- Used by the dashboard's "Restart" button via the action endpoint
- Honors `depends_on` ordering through reuse of the existing graph code

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
      stacks-view.ts
      actions.ts
      ui/                        # Vite + React app (ported from packages/dashboard/src/web/)
        index.html
        main.tsx
        App.tsx
        api.ts
        styles.css
        components/
          Sidebar.tsx
          Main.tsx
          Logs.tsx
        hooks/
          usePolledStacks.ts
        lib/
          format.ts
        vite.config.ts
    proxy/
      proxy.ts
      routing.ts
  commands/
    urls.ts                      # EXTEND: friendly URLs default, --raw flag
    up.ts                        # EXTEND: trigger daemon auto-start, write routing, browser open
    down.ts                      # EXTEND: clear routing block
    nuke.ts                      # EXTEND: kill daemon
    restart.ts                   # NEW
  bin/
    lich-daemon.ts               # daemon entry point binary (spawned by lich up)
  state/
    snapshot.ts                  # EXTEND: add `routing` block + active_profile is already in v3

packages/lich/tests/unit/
  daemon/
    pid-file.test.ts
    watcher.test.ts
    auto-start.test.ts
    dashboard/
      server.test.ts
      stacks-view.test.ts
      actions.test.ts
    proxy/
      routing.test.ts
  commands/
    urls-friendly.test.ts
    restart.test.ts

tests/e2e/
  helpers/
    daemon.ts                    # NEW helper: wait for daemon pid file + URL file
    dashboard-fetch.ts           # NEW helper: GET against the daemon URL
  daemon-auto-start.test.ts
  daemon-auto-shutdown.test.ts
  friendly-urls.test.ts
  dashboard-stack-list.test.ts
  dashboard-stack-detail.test.ts
  dashboard-failed-service.test.ts
  dashboard-stop-action.test.ts
  basic-up.test.ts               # TURNS GREEN — the gated todo flips to a real test
```

**Files NOT touched in this plan:**
- `packages/dashboard/` itself — we COPY components from it; deletion happens in Plan 6
- Everything under `packages/plugin-*/`, `packages/core/`, `packages/template-v0-stack/`, `packages/create-stack-v0/`

---

## Cross-plan dependencies

- **Plan 1** — `state.json` schema, `lich up`/`down`/`nuke`/`urls` commands, `worktree/detect.ts`, `state/directory.ts`, `state/snapshot.ts`
- **Plan 3** — `state.json` carries `active_profile`; dashboard surfaces it
- **Plan 4** — `state.json` per-service snapshot carries `failure_reason` + `failure_log_tail` for failed services; `LogTail` primitive at `packages/lich/src/logs/tail.ts` is the file-watching primitive that dashboard live-tail subscribes to
- **v0's `packages/dashboard/`** — source for the UI port (components, styles, hooks). Plan 6 deletes it after this plan ports what's needed.

---

## Testing requirements

E2e coverage floor (per testing standards):

- **Daemon auto-starts** on first `lich up` (PID + URL files appear)
- **Daemon auto-stops** within ~30s after the last stack stops
- **PID/URL file cleanup** on clean shutdown (and stale PID detection works)
- **Daemon survives across `lich up`/`down` cycles** when another stack is still alive
- **Friendly URL resolution** — `curl http://api.<worktree>.lich.localhost:3300/health` returns the same body as `curl http://localhost:<allocated-port>/health` (proves the routing convention + proxy)
- **Friendly URLs in `lich urls`** — output contains the friendly URL strings by default; `--raw` switches back to raw localhost
- **Dashboard `GET /api/stacks`** returns the running stacks with the right shape
- **Dashboard `GET /api/stacks/:id`** returns per-service status (including ports, captured values, active profile)
- **Dashboard renders failed service correctly** — start a stack with a deliberately failing owned service (using the Plan 4 fail_when machinery); `GET /api/stacks/:id` includes `failure_reason` + `failure_log_tail`; the UI shows red badge + reason
- **Stop button via dashboard** — POST `/api/stacks/:id/stop`; the stack actually tears down (state.json → `stopped`)
- **Two stacks visible simultaneously** — both appear in the list; both have distinct friendly URLs that resolve to distinct upstreams
- **Plan 0's `basic-up.test.ts` "brings the stack up and serves the web app" test PASSES** — this is the gated `it.todo` that hits `http://web.<worktree>.lich.localhost:3300/`; this plan's friendly URLs make it green

Unit coverage floor:
- PID file write/read/stale-detect; URL file write/read
- Watcher debouncing
- Routing-table construction from `state.json`
- Stacks-view conversion (StackSnapshot → StackView)
- Action endpoints (mock spawn, assert correct argv)

---

## Acceptance criteria

Plan 5 is done when:

- `lich up` on the dogfood-stack auto-starts the daemon and opens the dashboard in the browser (unless `--no-browser` was passed)
- Dashboard shows the stack with all services healthy and friendly URLs reachable
- `http://web.<worktree>.lich.localhost:3300/` works in a browser (renders the same HTML as `http://localhost:<allocated-port>/`)
- Two parallel `lich up` invocations from different tmpdirs both show in the dashboard with distinct friendly URLs
- `lich down` for one stack leaves the other visible and reachable
- `lich nuke` kills the daemon process + all stacks; PID and URL files cleaned up
- Plan 0's "brings the stack up and serves the web app" test (`tests/e2e/basic-up.test.ts`) now passes (the `it.todo` becomes a real `it`)
- All Plan 5 e2e tests pass
- `cd packages/lich && bun test` passes; `cd tests/e2e && bun test` passes

---

## Task list

Tasks are sized for one commit each (~30-90 min of subagent execution) and follow TDD: write tests first, then implementation, then commit. Many tasks have explicit dependencies on earlier tasks; later tasks are ready to dispatch as soon as their inputs land.

---

### Task 1: Extend `state.json` snapshot to carry a `routing` block

**Dependencies:** none

**Files:**
- Modify: `packages/lich/src/state/snapshot.ts`
- Create: `packages/lich/tests/unit/state/snapshot-routing.test.ts`

**Acceptance criteria:**
- `StackSnapshot` carries an optional `routing?: RoutingEntry[]` field where `RoutingEntry = { hostname: string; upstream_url: string; service: string }`
- `sanitizeForWrite` preserves `routing` verbatim (no stripping logic)
- `readSnapshot` returns the routing entries when present, `undefined` when absent (older snapshots written before this task)
- Unit tests cover: write+read round-trip with routing; round-trip without routing (back-compat); routing survives the `failed` service sanitize pass

**Tests to write:**
- `packages/lich/tests/unit/state/snapshot-routing.test.ts` — round-trip + back-compat tests

**Implementation notes:**

The routing block lives in `state.json` because the daemon's proxy and dashboard both read state.json already — no second on-disk surface to keep in sync. Each entry records the friendly hostname (`api.feature-x`) and the upstream URL (`http://127.0.0.1:9123`). The proxy joins all stacks' routing tables into one routing map.

We deliberately don't embed the proxy port in each entry — the proxy reads the runtime config and knows its own port. Each entry is just a `<friendly-hostname> → <upstream URL>` pair. The "service" field is informational (used by the dashboard to label which service owns this route).

The routing entries are computed by `lich up` (Task 8) AND `lich down` (Task 10 clears them on teardown). The proxy reads them via the watcher.

---

### Task 2: PID file management — write, read, stale detection

**Dependencies:** none

**Files:**
- Create: `packages/lich/src/daemon/pid-file.ts`
- Create: `packages/lich/tests/unit/daemon/pid-file.test.ts`

**Acceptance criteria:**
- `writeDaemonPid(pid: number, opts?: { lichHome?: string }): Promise<void>` writes `<LICH_HOME>/daemon.pid` (default `~/.lich/daemon.pid`)
- `readDaemonPid(opts?): Promise<number | null>` returns the PID if the file exists and parses, else null
- `isDaemonAlive(opts?): Promise<boolean>` returns true iff the PID file exists, the PID parses, AND `process.kill(pid, 0)` does not throw ESRCH
- `clearDaemonPid(opts?): Promise<void>` removes the file (idempotent)
- `writeDaemonUrl(url: string, opts?)`, `readDaemonUrl(opts?)`, `clearDaemonUrl(opts?)` for the URL file at `<LICH_HOME>/daemon.url`
- All functions honor `LICH_HOME` environment variable for test isolation
- Unit tests cover: write+read round-trip, stale PID detection (write a PID that's not alive → `isDaemonAlive` false), missing file (read returns null, isAlive false), corrupt file (read returns null), URL file mirror of the above

**Tests to write:**
- `packages/lich/tests/unit/daemon/pid-file.test.ts`

**Implementation notes:**

The PID file is the daemon's "I'm alive" marker. Stale detection has to handle three cases: (a) file doesn't exist → no daemon; (b) file exists, PID is alive → daemon running; (c) file exists, PID is dead → stale, treat as no daemon (caller's responsibility to clear and start fresh).

The URL file is separate from the PID file because the URL is only available AFTER `Bun.serve` has bound a port. Writing them as two files lets the auto-start logic (Task 5) poll for the URL file once it sees the PID file, with a short timeout.

Use atomic-write semantics (write to `<file>.<random>.tmp` then rename) — the daemon may crash mid-write, and a half-written PID would crash `parseInt` callers. Mirrors `state/snapshot.ts`'s atomic write approach.

`LICH_HOME` honored everywhere so tests can isolate to a tmpdir without touching `~/.lich`. Use `homedir()` + `.lich` as the default when `LICH_HOME` is unset, mirroring `state/directory.ts`'s `stateRoot()` resolution.

---

### Task 3: State directory watcher with debounced refresh

**Dependencies:** Task 2 (uses `LICH_HOME` resolution)

**Files:**
- Create: `packages/lich/src/daemon/watcher.ts`
- Create: `packages/lich/tests/unit/daemon/watcher.test.ts`
- Modify: `packages/lich/package.json` (add `chokidar` dep)

**Acceptance criteria:**
- `class StateWatcher { constructor(opts: { stateRoot: string; onChange: () => void; debounceMs?: number }); start(): Promise<void>; stop(): Promise<void> }`
- `start()` opens a `chokidar.watch` on the state root, watches for add/change/unlink events on `**/state.json`
- `onChange` is invoked AT MOST once per `debounceMs` window (default 100ms) regardless of how many file events fire
- `stop()` is idempotent; cleanly tears down the watcher
- Unit tests cover: initial scan fires onChange exactly once; rapid successive writes debounced to a single call; unlink fires onChange; stop+restart works; start on a missing stateRoot doesn't throw (chokidar tolerates this)

**Tests to write:**
- `packages/lich/tests/unit/daemon/watcher.test.ts` — uses a real tmpdir as `stateRoot`, writes/touches/removes a fake `state.json` to drive events

**Implementation notes:**

Why chokidar instead of `fs.watch`? Cross-platform consistency: macOS coalesces writes differently from Linux, and `fs.watch` on missing dirs throws on some platforms but not others. Chokidar smooths these out and offers `awaitWriteFinish` for atomic writes (which our snapshot writer uses).

Debouncing matters because `lich up` writes `state.json` multiple times during startup (initial → after ports → after each service → after lifecycle hooks). Without debouncing, the proxy would rebuild its routing table 5+ times per `lich up`. 100ms is enough to coalesce; sub-perceptible latency.

The watcher itself is a pure observer — it doesn't read or interpret state.json. The `onChange` callback is opaque; the daemon wires it to "ask routing.ts and stacks-view.ts to re-read everything." This keeps the watcher reusable for the dashboard server's polling-with-fresh-data and the proxy's routing rebuild.

---

### Task 4: Daemon main entry — wires watcher, dashboard, proxy stub, auto-shutdown

**Dependencies:** Tasks 2, 3

**Files:**
- Create: `packages/lich/src/daemon/daemon.ts`
- Create: `packages/lich/src/bin/lich-daemon.ts`
- Modify: `packages/lich/package.json` (add a second `build:daemon` script: `bun build --compile --outfile=dist/lich-daemon src/bin/lich-daemon.ts`)
- Create: `packages/lich/tests/unit/daemon/daemon.test.ts`

**Acceptance criteria:**
- `runDaemon(opts: { lichHome?: string; proxyPort?: number; signal?: AbortSignal }): Promise<void>` is the main loop
- On start: writes PID, starts watcher, starts a no-op dashboard stub returning 200 on `/healthz`, starts a no-op proxy stub returning 502 (placeholders for Tasks 6 and 11), writes URL file with the dashboard URL
- Auto-shutdown: every 10s, checks `listStacks()` (from `state/directory.ts`) + reads each `state.json`; if no stack has `status in {starting, up, partial, stopping}` for 3 consecutive checks, calls `process.exit(0)` after cleanup
- On SIGTERM and on `signal` abort: stops watcher, stops dashboard, stops proxy, clears PID/URL files, exits cleanly
- Stale PID detection on startup: if a PID file exists but the PID is not alive, overwrite it (we own the file)
- If a PID file exists AND that PID IS alive: refuse to start, exit 1 with "daemon already running at pid X" on stderr
- Unit tests cover: auto-shutdown after K consecutive empty checks; SIGTERM cleanup; refuse-to-start when alive daemon exists; stale-pid overwrite

**Tests to write:**
- `packages/lich/tests/unit/daemon/daemon.test.ts` — drive `runDaemon` with a tmpdir LICH_HOME, mock the dashboard/proxy modules, assert PID/URL file lifecycle and auto-shutdown timing (using fake timers if useful)

**Implementation notes:**

The daemon is split into one main loop and three subsystems (watcher, dashboard, proxy). Each subsystem has its own start/stop; the daemon orchestrates them. This task wires them all up with placeholder implementations for dashboard and proxy so the rest of the lifecycle can be tested in isolation — Tasks 6 and 11 replace the placeholders with real implementations.

Auto-shutdown's "3 consecutive checks" rule (≈30s) is what the spec calls for. The reason for K-of-N rather than a single empty check: `lich down` followed immediately by `lich up` would otherwise race the daemon shutting itself down between the two commands. K=3 at 10s intervals gives a ~30s grace window where the daemon waits to see if anything else starts up.

The compiled binary is `dist/lich-daemon`. The auto-start logic (Task 5) spawns this binary directly with `detached: true` + `unref()` so the daemon survives the parent `lich up` exiting. This is critical: `lich up` returns after the stack is ready, but the daemon must outlive it.

---

### Task 5: Daemon auto-start hook called from `lich up`

**Dependencies:** Tasks 2, 4

**Files:**
- Create: `packages/lich/src/daemon/auto-start.ts`
- Create: `packages/lich/tests/unit/daemon/auto-start.test.ts`

**Acceptance criteria:**
- `ensureDaemonRunning(opts: { lichHome?: string; proxyPort?: number; openBrowser?: boolean; out?: WritableStream }): Promise<{ url: string; alreadyRunning: boolean }>`
- If a daemon is already running (PID file alive, URL file present): return `{ url, alreadyRunning: true }` without doing anything
- If no daemon is running: spawn `dist/lich-daemon` with `detached: true`, `stdio: 'ignore'`, `unref()` so the parent can exit
- Wait up to 5s for the URL file to appear; if it doesn't, return `{ url: '', alreadyRunning: false }` and write a warning to `out` (do NOT throw — daemon failure must not fail `lich up`)
- If `openBrowser` is true AND `alreadyRunning` is false AND we have a URL: invoke `open <url>` on macOS / `xdg-open <url>` on Linux, best-effort, ignore failures
- Unit tests cover: already-running short-circuit; new-daemon spawn (mocked); spawn failure handling; URL file timeout warning; openBrowser behavior

**Tests to write:**
- `packages/lich/tests/unit/daemon/auto-start.test.ts` — mock the spawn + file system to assert ordering and behavior

**Implementation notes:**

The auto-start must be silent and idempotent: 99% of `lich up` invocations will find the daemon already running and short-circuit in <10ms. The 1% that have to spawn pay ~200-500ms (Bun startup + Bun.serve bind), which is fine for a first-of-the-day `lich up`.

The `--no-browser` flag from `lich up` flows in as `openBrowser: false`. Browser is opened ONLY the first time the daemon starts in a session, never on subsequent `lich up`s that hit an already-alive daemon. Subsequent invocations would be annoying ("why is this opening Chrome again?").

The spawn uses `detached: true` + `unref()` so when `lich up` finishes and the user's shell returns to the prompt, the daemon stays running. Without `unref()`, Node would refuse to exit while the child handle is still attached.

Browser-open is best-effort: `spawn('open', [url], { stdio: 'ignore', detached: true }).unref()` on macOS, `xdg-open` on Linux. Failures are silent — if `open` isn't available, the user reads the URL from the CLI summary and pastes it manually.

---

### Task 6: Dashboard HTTP server — `Bun.serve` with REST endpoints

**Dependencies:** Tasks 3 (watcher pipes refresh signal), 4 (daemon owns the server)

**Files:**
- Create: `packages/lich/src/daemon/dashboard/server.ts`
- Create: `packages/lich/src/daemon/dashboard/stacks-view.ts`
- Create: `packages/lich/tests/unit/daemon/dashboard/server.test.ts`
- Create: `packages/lich/tests/unit/daemon/dashboard/stacks-view.test.ts`

**Acceptance criteria:**
- `startDashboardServer(opts: { stateRoot: string; uiDir: string; port?: number }): Promise<{ url: string; stop(): Promise<void>; refresh(): void }>`
- `GET /api/stacks` returns `{ stacks: StackView[] }` where `StackView` is defined in `stacks-view.ts`
- `GET /api/stacks/:id` returns one `StackView` with full per-service detail or 404
- `GET /healthz` returns 200 `ok` (used by the daemon's own watchdog if needed)
- Static fallback: any non-`/api/*` path serves from `uiDir` with SPA fallback to `index.html`
- `refresh()` is a hook the watcher calls to invalidate any in-memory cache (Task 8 might add caching; for now it's a no-op pass-through that re-reads on every request)
- Server binds 127.0.0.1 only (no remote surface — local-only tool)
- Unit tests cover: shape of `/api/stacks` response; 404 on unknown stack id; static file serving; SPA fallback; path traversal protection (`../` rejected)
- `stacks-view.test.ts` covers the snapshot → StackView conversion with fixtures including failed services, active_profile, captured values, routing entries

**Tests to write:**
- `packages/lich/tests/unit/daemon/dashboard/server.test.ts` — uses `routeRequest`-style direct exports (no socket bind needed for unit tests)
- `packages/lich/tests/unit/daemon/dashboard/stacks-view.test.ts` — pure conversion tests with snapshot fixtures

**Implementation notes:**

This is a port of v0's `packages/dashboard/src/server/server.ts` and `index.ts`, adapted to lich v1's state model:

- v0 read from a registry file with per-stack `containers` arrays; v1 reads `~/.lich/stacks/<id>/state.json` per stack via the existing `listStacks()` + `readSnapshot()` helpers from `state/directory.ts`
- v0 had a `ServiceView.status` of `'healthy' | 'unhealthy' | 'starting' | 'down'`; v1 uses the richer `ServiceState` from `state/snapshot.ts` (`starting | healthy | initializing | ready | stopping | stopped | failed`) — surface these directly in `StackView.services[].state`
- `StackView` needs the new fields the spec calls out: `active_profile?: string` (from Plan 3), `failed_count: number` (computed), per-service `failure_reason?: string` + `failure_log_tail?: string[]` (from Plan 4), `routing: RoutingEntry[]` (from Task 1)
- The v0 dashboard had `StackMetrics` (CPU/RAM). v1 deliberately omits these per the design's non-goals — do NOT port the metrics endpoint

Caching strategy: read `state.json` per-request initially. If we observe latency problems in e2e tests (dashboard polls every 2s × N stacks × O(file IO)), Task 8 can add a 250ms cache invalidated by the watcher. Start simple; optimize if measurement says we need it.

---

### Task 7: SSE log-tail endpoints using the `LogTail` primitive

**Dependencies:** Task 6

**Files:**
- Modify: `packages/lich/src/daemon/dashboard/server.ts` (add `/api/stacks/:id/logs` routes)
- Create: `packages/lich/tests/unit/daemon/dashboard/log-stream.test.ts`

**Acceptance criteria:**
- `GET /api/stacks/:id/logs?service=<name>` opens an SSE stream; pushes one `data: <JSON line>\n\n` per log line as `LogTail` emits them
- `GET /api/stacks/:id/logs` (no service) opens a merged stream across all services for the stack; each event carries a `service: <name>` field
- On client disconnect (the `ReadableStream`'s `cancel`): all `LogTail` instances for that stream are stopped (no leaked file watchers)
- 404 if the stack id doesn't exist; 404 if `?service=X` references a service not in the stack
- Unit tests cover: subscribing to a fake LogTail that emits 3 lines → 3 SSE frames received; cancel triggers LogTail stop; merged endpoint covers multiple services

**Tests to write:**
- `packages/lich/tests/unit/daemon/dashboard/log-stream.test.ts` — uses a fake `LogTail` implementation that emits lines on demand

**Implementation notes:**

This task wires the dashboard live-tail to the `LogTail` primitive at `packages/lich/src/logs/tail.ts`. Plan 4 designed `LogTail` exactly for this use case — multiple subscribers, separate fd from the supervisor's write fd, no file rotation concerns at this layer.

For each SSE connection, instantiate a fresh `LogTail` (or, for the merged endpoint, one per service), call `onLine(cb)` where `cb` enqueues an SSE frame to the controller, then `start()`. On `cancel`, stop all the tails. This mirrors v0's `handleLogStream` in `packages/dashboard/src/server/server.ts` lines 58-97.

The log file path is `serviceLogPath(stackId, serviceName)` from `state/directory.ts`. The endpoint must NOT block on file existence — services that haven't written a log line yet may not have the file created, and `LogTail` tolerates that (it polls).

Cancellation matters: a browser tab closing must immediately stop the `LogTail`'s poll loop, otherwise we'd leak `setInterval`s for every closed tab. The `ReadableStream` cancel handler is the right hook.

---

### Task 8: `lich up` writes routing entries into `state.json`

**Dependencies:** Task 1 (snapshot supports routing field)

**Files:**
- Modify: `packages/lich/src/commands/up.ts`
- Create: `packages/lich/tests/unit/commands/up-routing.test.ts`

**Acceptance criteria:**
- After all services are ready, `up.ts` populates `state.routing` with one entry per service that has at least one allocated port
- For single-port services: one entry with hostname `<service>.<worktree>` and upstream `http://127.0.0.1:<port>`
- For multi-port services: one entry per logical port; hostname `<service>-<key>.<worktree>` (so supabase becomes `supabase-api.<worktree>`, `supabase-db.<worktree>`, etc.)
- The hostname uses `worktree.name` (already sanitized to `[a-z0-9-]+`)
- `state.routing` is written as part of the final `writeSnapshot` call before exit
- Unit tests cover: single-port service, multi-port service, no-port service (skipped), hostname sanitization

**Tests to write:**
- `packages/lich/tests/unit/commands/up-routing.test.ts` — exercise `buildRoutingEntries(state)` (a helper extracted from `up.ts`) with synthetic snapshots

**Implementation notes:**

The hostname convention matters because the proxy will look up requests by `Host` header. We need:

1. **Deterministic** — same yaml + same worktree → same hostnames every run
2. **Worktree-scoped** — two worktrees of the same project produce different hostnames (no collision)
3. **Service-scoped** — different services in the same worktree produce different hostnames
4. **DNS-safe** — only `[a-z0-9-]` characters

`<service>.<worktree>.lich.localhost` satisfies all four. The worktree.name is already sanitized; service names from YAML are validated by the schema to be lower-snake-or-kebab.

For multi-port services: the spec doesn't specify the exact format. The natural extension is `<service>-<key>.<worktree>` (using `-` because `.` would make Kong/proxy/DNS-style nested subdomains, which `*.lich.localhost` doesn't bind). So supabase with `ports.api` + `ports.db` becomes `supabase-api.feature-x.lich.localhost` and `supabase-db.feature-x.lich.localhost`.

Extract `buildRoutingEntries(state: UpState): RoutingEntry[]` as a pure function so the unit test doesn't need the orchestrator's full plumbing.

---

### Task 9: Daemon auto-start triggered after `lich up` success

**Dependencies:** Task 5 (auto-start helper), Task 8 (routing entries written)

**Files:**
- Modify: `packages/lich/src/commands/up.ts`
- Modify: `packages/lich/src/commands/dispatch.ts` (parse `--no-browser` flag)
- Modify: `packages/lich/src/bin/lich.ts` (declare `--no-browser` as a boolean flag)
- Create: `packages/lich/tests/unit/commands/up-daemon-trigger.test.ts`

**Acceptance criteria:**
- After `state.status = "up"` is written, `up.ts` calls `ensureDaemonRunning({ lichHome: ..., proxyPort: ..., openBrowser: !argv['no-browser'] })`
- The proxy port is read from `config.runtime?.proxy_port` if present, else default 3300
- The summary block in `lich up` output includes the dashboard URL (when daemon started successfully) and the friendly URL for each service (when they exist)
- `--no-browser` suppresses browser-open; the dashboard URL is still printed
- Daemon-start failures do NOT fail `lich up` — a warning is written to stdout and the up returns successful
- Unit tests cover: daemon trigger is called with right args; --no-browser propagates; daemon failure becomes a warning, not an error

**Tests to write:**
- `packages/lich/tests/unit/commands/up-daemon-trigger.test.ts` — mock `ensureDaemonRunning`

**Implementation notes:**

The trigger sits in `up.ts` AFTER the success path's `state.status = "up"` write but BEFORE the final summary output. This ordering matters: we want the daemon URL to appear in the summary block, but we don't want a daemon failure to retroactively fail the stack-up that already succeeded.

The summary's "next steps" hints should now include the dashboard URL and the friendly URL for the primary web service (when present). Use the same `SummaryBlock` / `SummaryHint` types from `output/index.ts`.

`--no-browser` is wired via the `bin/lich.ts` argv parser (add `'no-browser'` to the `boolean` list) and threaded through `dispatch.ts`'s `upHandler` as a top-level flag on the input. The dispatch layer then passes it down into `runUp`.

---

### Task 10: `lich down` clears the stack's routing entries

**Dependencies:** Task 1, Task 8

**Files:**
- Modify: `packages/lich/src/commands/down.ts`
- Modify: `packages/lich/tests/unit/commands/down*.test.ts` (extend existing or add new test file)

**Acceptance criteria:**
- After the stack is marked `status: stopped`, `down.ts` writes `state.routing = []` (or `undefined`) so the proxy stops serving stale upstream URLs
- The proxy watcher will pick up the change within ~100ms and remove the routes
- Unit test verifies the routing block is cleared on a stopped stack snapshot

**Tests to write:**
- `packages/lich/tests/unit/commands/down-routing.test.ts` — assert state.json post-down has empty/no routing

**Implementation notes:**

This is a 2-line change: in `down.ts`'s final `writeSnapshot(snap)` block, set `snap.routing = []`. The proxy treats both "empty array" and "absent field" the same (no routes for this stack).

We don't delete the stack directory on `lich down` (per Plan 1's design — the entry stays until `lich nuke`). The proxy must filter out routing entries for stacks whose `status` is `stopped`, `failed`, or `stopping` — the user shouldn't get a 502 trying to reach a stack that's torn down. The routing module (Task 12) handles this filter.

---

### Task 11: Reverse proxy server — `Bun.serve` with Host-header routing

**Dependencies:** Task 3 (watcher fires refresh)

**Files:**
- Create: `packages/lich/src/daemon/proxy/proxy.ts`
- Create: `packages/lich/src/daemon/proxy/routing.ts`
- Create: `packages/lich/tests/unit/daemon/proxy/routing.test.ts`
- Create: `packages/lich/tests/unit/daemon/proxy/proxy.test.ts`

**Acceptance criteria:**
- `class RoutingTable { reload(stateRoot: string): Promise<void>; get(hostname: string): string | undefined; }` — reads all stacks' `state.json`, joins routing entries into a Map; ignores entries for stacks with status `stopped`/`failed`
- `startProxyServer(opts: { port: number; routing: RoutingTable }): Promise<{ stop(): Promise<void> }>` — `Bun.serve` that:
  - Reads `Host` header
  - Strips the `:port` suffix and the `.lich.localhost` trailing label
  - Looks up the remaining `<service>.<worktree>` (or `<service>-<key>.<worktree>`) in the routing table
  - On hit: proxies the request to the upstream URL (same path, headers, method, body)
  - On miss: returns 502 with a plain-text body listing the known friendly hosts
- Binds 127.0.0.1 only (local-only)
- WebSocket support: not required for v1; HTTP only (document this limitation in routing.ts JSDoc)
- Unit tests cover: routing table construction from synthetic state.json fixtures; routes from stopped stacks are excluded; proxy.test.ts unit-tests the request-handling function with a mock upstream

**Tests to write:**
- `packages/lich/tests/unit/daemon/proxy/routing.test.ts`
- `packages/lich/tests/unit/daemon/proxy/proxy.test.ts`

**Implementation notes:**

Bun's reverse-proxy is straightforward: `Bun.serve({ fetch(req) { const upstream = lookup(req); return fetch(new URL(req.url.replace(/^[^/]+\/\/[^/]+/, upstream), { method, headers, body }); } })`. The trick is preserving headers (drop hop-by-hop ones — `Connection`, `Keep-Alive`, etc.) and the body for non-GET methods.

The hostname parsing must handle:
- `api.feature-x.lich.localhost:3300` → service `api`, worktree `feature-x`
- `supabase-db.feature-x.lich.localhost:3300` → service `supabase-db`, worktree `feature-x`
- `api.feature-x.lich.localhost` (no port) → same as above
- Anything not matching `*.lich.localhost` → 502 (not a lich-style hostname)

The routing table is rebuilt from scratch on every `reload()` call — small enough at our scale that incremental updates aren't worth the complexity. The daemon hooks `reload()` to the watcher's `onChange` callback.

WebSocket support is NOT required for v1 per the spec (the `--raw` flag is the documented escape hatch for ws-heavy services). Document the limitation prominently in proxy.ts so future maintainers don't waste time wondering why WebSocket upgrades 502.

---

### Task 12: Wire proxy + dashboard + watcher together in the daemon

**Dependencies:** Tasks 4, 6, 7, 11

**Files:**
- Modify: `packages/lich/src/daemon/daemon.ts` (replace the stubs from Task 4)
- Modify: `packages/lich/tests/unit/daemon/daemon.test.ts`

**Acceptance criteria:**
- `runDaemon` now starts the REAL dashboard server (Task 6) and REAL proxy server (Task 11), not stubs
- The watcher's `onChange` callback calls both `dashboardServer.refresh()` AND `routingTable.reload()`
- Both servers' `stop()` are awaited during cleanup
- The dashboard URL written to `daemon.url` is the dashboard server URL (e.g., `http://127.0.0.1:<allocated-port>`), NOT the proxy URL
- Auto-shutdown's stack-count check excludes stacks with status `stopped` / `failed` (mirroring the proxy's filter)
- Updated unit tests cover the integration

**Tests to write:**
- Extend `packages/lich/tests/unit/daemon/daemon.test.ts` to verify both servers are stopped on shutdown

**Implementation notes:**

This is the "wire everything together" task. The previous tasks built the pieces in isolation; here they snap into the daemon's main loop. After this task, `runDaemon` is a real daemon, not a scaffold.

The dashboard URL ≠ proxy URL — they're two separate `Bun.serve` instances. Both get allocated ports (the dashboard from `Bun.serve({ port: 0 })`, the proxy from the config or default 3300). The URL file records ONLY the dashboard URL because that's what the user clicks; the proxy URL is implicit in the friendly URLs (`http://api.feature-x.lich.localhost:3300/`).

---

### Task 13: Port the dashboard UI scaffolding from `packages/dashboard/`

**Dependencies:** Task 6

**Files:**
- Create: `packages/lich/src/daemon/dashboard/ui/package.json` (vite + react deps)
- Create: `packages/lich/src/daemon/dashboard/ui/vite.config.ts`
- Create: `packages/lich/src/daemon/dashboard/ui/tsconfig.json`
- Create: `packages/lich/src/daemon/dashboard/ui/index.html`
- Create: `packages/lich/src/daemon/dashboard/ui/main.tsx`
- Create: `packages/lich/src/daemon/dashboard/ui/styles.css` (copied from `packages/dashboard/src/web/styles.css`)
- Modify: `packages/lich/package.json` (add `build:ui` script: `cd src/daemon/dashboard/ui && vite build --outDir ../dist-ui`)

**Acceptance criteria:**
- `bun run build:ui` produces `packages/lich/src/daemon/dashboard/dist-ui/` with `index.html` + asset bundles
- The compiled lich-daemon binary serves these assets from the relative dist path
- `index.html` renders an empty page on initial load (no components yet — Task 14 adds them)
- The build is reproducible; tsc passes

**Tests to write:**
- None for this task — purely scaffolding; the e2e tests in Task 22+ verify end-to-end

**Implementation notes:**

Copy `packages/dashboard/vite.config.ts`, `index.html`, `main.tsx`, and `styles.css` verbatim, adjusting paths. The package.json mirrors the v0 dashboard's deps (`react`, `react-dom`, `@vitejs/plugin-react`, `vite`, fontsources for `geist` + `jetbrains-mono`).

The build output (`dist-ui/`) needs to be referenced by the daemon's `startDashboardServer` call. Either bake the path in via `import.meta.dir` resolution (when `lich-daemon` runs from source) or hard-code the relative path the bun-compiled binary will see. Use `import.meta.dir` + a relative path — Bun's `--compile` preserves the file structure.

The `bun build --compile` for the daemon must include the `dist-ui/` assets as embedded files. Bun supports this via `--asset-naming`. If not feasible, the daemon's working directory or a side-by-side asset bundle works too. Document the approach in `bin/lich-daemon.ts`'s header comment.

---

### Task 14: Port the dashboard UI components (Sidebar, Main, Logs)

**Dependencies:** Task 13

**Files:**
- Create: `packages/lich/src/daemon/dashboard/ui/App.tsx` (adapted from `packages/dashboard/src/web/App.tsx`)
- Create: `packages/lich/src/daemon/dashboard/ui/api.ts` (adapted from `packages/dashboard/src/web/api.ts`)
- Create: `packages/lich/src/daemon/dashboard/ui/components/Sidebar.tsx`
- Create: `packages/lich/src/daemon/dashboard/ui/components/Main.tsx`
- Create: `packages/lich/src/daemon/dashboard/ui/components/Logs.tsx`
- Create: `packages/lich/src/daemon/dashboard/ui/hooks/usePolledStacks.ts`
- Create: `packages/lich/src/daemon/dashboard/ui/lib/format.ts`

**Acceptance criteria:**
- Components render the stack list in the sidebar and the selected stack detail in the main pane
- The `StackView` type used by the UI matches the JSON shape `/api/stacks` returns (defined in Task 6's `stacks-view.ts`)
- Services rendered with the new `ServiceState` enum (`starting | healthy | initializing | ready | stopping | stopped | failed`), not the v0 4-value enum
- Service rows show: name, kind (compose|owned), state, allocated ports
- Active profile name shown in the stack header (when present)
- The "Restart" + "Stop" buttons call the action endpoints from Task 16
- `bun run build:ui` produces a working SPA that loads against a real `/api/stacks` response
- No CPU/RAM metrics widget (removed per design's non-goals)

**Tests to write:**
- None for this task — the v0 UI was not unit-tested either; e2e tests in later tasks verify the end-to-end render

**Implementation notes:**

This is the bulk of the UI port. Start from v0's components and trim aggressively:
- Delete the `Metrics` widget from `Main.tsx` (CPU/RAM removed)
- Replace `summarizeHealth` (which uses the v0 status enum) with logic over the v1 `ServiceState`
- Replace `HealthPill` count with the new "ready/total + N failed" shape from `commands/stacks.ts`
- Keep the brand mark, sidebar layout, and the logs viewer roughly as-is
- The `usePolledMetrics` hook is deleted entirely

The `api.ts` wire-format types need to match what `/api/stacks` returns (Task 6). Import the types from a shared module if convenient — or duplicate them locally and keep them in sync (the wire format is small; duplication is fine).

The Logs component continues to use `EventSource` for SSE. Keep the search/filter/tail features; they're useful and the v0 implementation is clean.

---

### Task 15: Render failed services in the dashboard with red badge + reason

**Dependencies:** Task 14

**Files:**
- Modify: `packages/lich/src/daemon/dashboard/ui/components/Main.tsx` (add a `ServiceList` with failed-state rendering)
- Modify: `packages/lich/src/daemon/dashboard/ui/styles.css` (add a `.failed` style)
- Create: `packages/lich/tests/unit/daemon/dashboard/stacks-view-failure.test.ts`

**Acceptance criteria:**
- A service with `state: "failed"` renders with a red badge in the service list
- The `failure_reason` from Plan 4 is shown inline next to the service name (truncated to ~80 chars with a tooltip for full text)
- The `failure_log_tail` is shown in an expandable section (collapsed by default)
- The stack header shows "N/M services failed" when `failed_count > 0`, in red
- Unit tests in `stacks-view-failure.test.ts` verify the conversion from `ServiceSnapshot` (with `failure_reason` + `failure_log_tail`) to `StackView` preserves those fields

**Tests to write:**
- `packages/lich/tests/unit/daemon/dashboard/stacks-view-failure.test.ts`

**Implementation notes:**

Plan 4 already populated `failure_reason` + `failure_log_tail` on the snapshot; this task just makes the UI render them. The conversion code in `stacks-view.ts` (Task 6) needs to be extended to pass these fields through to `StackView` — the unit test in this task verifies that.

The UI surfaces should match what an operator wants to see when triaging a failure: the service that failed, why (one-line summary), and the last 20 log lines (for context). Keep the log-tail collapsed by default to avoid overwhelming the layout — most stacks won't have failures.

CSS: a `.service-row[data-state="failed"]` selector with `color: red` + `border-left: 3px solid red` is enough for the badge effect. Match the typography of the rest of the UI.

---

### Task 16: Action endpoints — stop and restart via dashboard

**Dependencies:** Task 6, Task 19 (restart command)

**Files:**
- Create: `packages/lich/src/daemon/dashboard/actions.ts`
- Modify: `packages/lich/src/daemon/dashboard/server.ts` (route `POST /api/stacks/:id/stop` and `/restart`)
- Create: `packages/lich/tests/unit/daemon/dashboard/actions.test.ts`

**Acceptance criteria:**
- `runLichAction(worktreePath: string, action: 'down' | 'restart'): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }>`
- Spawns the `lich` binary in the worktree's cwd; passes the same `LICH_HOME` the daemon was started with
- Captures stdout/stderr (capped at ~16KB each); returns the result as JSON
- `POST /api/stacks/:id/stop` looks up the stack's `worktree_path` from its snapshot, calls `runLichAction(path, 'down')`, returns the JSON result
- `POST /api/stacks/:id/restart` same but with `'restart'`
- 404 if the stack id is unknown
- Returns 200 with the ActionResult JSON even when the underlying CLI exited non-zero (the UI uses `ok` to display the outcome)
- Unit tests cover: 404 on unknown stack; correct argv to spawn; output truncation; LICH_HOME propagation

**Tests to write:**
- `packages/lich/tests/unit/daemon/dashboard/actions.test.ts`

**Implementation notes:**

This mirrors v0's `packages/dashboard/src/server/actions.ts`. The trick is `LICH_HOME`: the daemon may have been started with a custom `LICH_HOME` (the e2e tests do this), and the spawned `lich` subprocess must inherit it. Otherwise the subprocess would look at `~/.lich` and find nothing.

Output truncation matters because a chatty `lich down` (think Plan 1's compose-down with stderr warnings) could dump megabytes through a JSON response. 16KB per stream is enough to debug a failure without choking the UI.

The CLI subprocess must finish on its own — don't pipe its stdin or attach a stdio TTY. The dashboard is invoking it programmatically; the user is reading the result in the UI.

---

### Task 17: Friendly URLs in `lich urls` (default) + `--raw` flag

**Dependencies:** Task 8 (routing entries exist in state.json), Task 1

**Files:**
- Modify: `packages/lich/src/commands/urls.ts`
- Modify: `packages/lich/src/commands/dispatch.ts` (parse `--raw` flag)
- Modify: `packages/lich/src/bin/lich.ts` (declare `--raw` as boolean)
- Create: `packages/lich/tests/unit/commands/urls-friendly.test.ts`

**Acceptance criteria:**
- Default `lich urls` output: one line per routing entry in `state.json`, formatted as `<service>[.<key>]: http://<friendly-hostname>:<proxy-port>/`
- The `<proxy-port>` is read from `config.runtime?.proxy_port` (default 3300)
- `--raw` flag: prints the previous Plan 1 output (raw `localhost:<port>` URLs)
- Both default and `--raw` paths return exit 0
- "no stack found for this worktree" / "(no ports allocated)" messages preserved from Plan 1
- Unit tests cover: friendly format for single-port and multi-port services; --raw fallback; custom proxy_port from config

**Tests to write:**
- `packages/lich/tests/unit/commands/urls-friendly.test.ts`

**Implementation notes:**

The `state.json` routing entries (Task 8) already contain `<hostname>` and `<upstream_url>`. For the friendly output, we want `<hostname>.lich.localhost:<proxy-port>` — so the URL is `http://<hostname>.lich.localhost:<proxy-port>/`. Read the proxy port from the config; default 3300.

If the stack has routing entries but the config can't be re-parsed for some reason (yaml gone, parsing failed), fall back to 3300 silently rather than failing — `lich urls` should be robust. Use the same parseConfig fallback pattern as `down.ts`.

The Plan 1 output for `lich urls` lives under `--raw` from this point forward. Keep the previous formatting helper (`appendServiceLines`) — just gate it behind the flag.

---

### Task 18: `lich nuke` also kills the daemon process

**Dependencies:** Task 2 (PID file)

**Files:**
- Modify: `packages/lich/src/commands/nuke.ts`
- Modify: `packages/lich/tests/unit/commands/nuke*.test.ts` (extend or add new test)

**Acceptance criteria:**
- After all per-stack teardown completes, `nuke.ts` reads `~/.lich/daemon.pid` and SIGTERM the daemon process
- If the daemon is not alive (no PID file or stale): no-op
- After SIGTERM, give the daemon up to 5s to exit cleanly; SIGKILL if still alive
- Clear `daemon.pid` and `daemon.url` after the daemon exits
- Surface daemon-teardown failures in the nuke summary (as a warning, not a failure)
- Unit test covers: daemon-alive path SIGTERMs and clears files; daemon-dead path is a no-op; SIGKILL escalation path

**Tests to write:**
- `packages/lich/tests/unit/commands/nuke-daemon.test.ts`

**Implementation notes:**

The daemon already auto-shuts down when no stacks remain (Task 4's auto-shutdown), so `lich nuke` would eventually trigger an auto-shutdown anyway. But the user's expectation of `lich nuke` is "stop everything NOW" — we should not make them wait 30s for the daemon to notice.

Use the same SIGTERM → grace → SIGKILL pattern from `nuke.ts`'s existing `killOwned` helper. 5s grace is generous for a daemon that's basically just stopping two `Bun.serve` instances and a watcher.

`daemon.url` clears via the same idempotent `clearDaemonUrl` from Task 2. Both files should be gone after `lich nuke` so the next `lich up` has a clean slate.

---

### Task 19: `lich restart` command — whole-stack restart

**Dependencies:** none (uses existing `up`/`down`)

**Files:**
- Create: `packages/lich/src/commands/restart.ts`
- Modify: `packages/lich/src/commands/dispatch.ts` (replace the `stub("restart")` with a real handler)
- Create: `packages/lich/tests/unit/commands/restart.test.ts`
- Create: `tests/e2e/restart-basic.test.ts`

**Acceptance criteria:**
- `runRestart(opts: { cwd?, signal? })` invokes `runDown` then `runUp` in sequence
- If `runDown` returns non-zero, abort and return that exit code (don't try to `up` a broken state)
- Otherwise, return `runUp`'s exit code
- Unit test covers: down-then-up ordering; abort on down-failure; signal propagates to both
- E2e test (`restart-basic.test.ts`) covers: `lich up` → `lich restart` → `lich urls` still shows the same stack with new PIDs

**Tests to write:**
- `packages/lich/tests/unit/commands/restart.test.ts`
- `tests/e2e/restart-basic.test.ts`

**Implementation notes:**

The spec defines `lich restart [services...]` with `--owned` / `--compose` flags. v1's MVP is whole-stack restart only; per-service restart is a nice-to-have but not blocking. Implement the simple case here; the dashboard's "Restart" button will use this.

Per-service restart can ship in v1.x. Note this in the JSDoc so the next reader doesn't think the simpler implementation is a bug.

The signal needs to thread through to both `runDown` and `runUp` so Ctrl-C during a restart cleanly stops whichever is in flight. Reuse the existing patterns.

---

### Task 20: E2e helper — wait for daemon PID + URL files

**Dependencies:** Task 2

**Files:**
- Create: `tests/e2e/helpers/daemon.ts`
- Create: `tests/e2e/helpers/daemon.test.ts`

**Acceptance criteria:**
- `waitForDaemonRunning(lichHome: string, opts?: { timeoutMs?: number }): Promise<{ pid: number; url: string }>` polls for both files; throws on timeout
- `waitForDaemonStopped(lichHome: string, opts?: { timeoutMs?: number }): Promise<void>` polls until the PID file is gone OR points at a dead PID
- `readDaemonUrl(lichHome: string): string | null` synchronous helper
- Unit-style test in `daemon.test.ts` covers the helpers with manually-written files

**Tests to write:**
- `tests/e2e/helpers/daemon.test.ts`

**Implementation notes:**

These helpers are tiny but every Plan 5 e2e test needs them. Mirroring the pattern of `tests/e2e/helpers/state.ts` (which already has `waitForStackStatus`), this is the daemon-lifecycle equivalent.

Use a 30s default timeout for `waitForDaemonRunning` — the first daemon spawn can be slow (~500ms cold start), but in CI it should be well under 5s. The auto-shutdown is ~30s by design, so the stopped poll timeout should be 60s.

---

### Task 21: E2e test — daemon auto-start on first `lich up`

**Dependencies:** Tasks 5, 9, 20

**Files:**
- Create: `tests/e2e/daemon-auto-start.test.ts`

**Acceptance criteria:**
- Test runs `lich up --no-browser` against a dogfood-stack tmpdir with isolated LICH_HOME
- After up returns, asserts `<LICH_HOME>/daemon.pid` and `<LICH_HOME>/daemon.url` exist
- Fetches the dashboard URL `/healthz` and asserts 200
- Cleanup: `lich down` + wait for daemon to auto-stop (or `lich nuke` to force)

**Tests to write:**
- `tests/e2e/daemon-auto-start.test.ts`

**Implementation notes:**

This is the "does the daemon actually appear?" sentinel. Use the same Fixture pattern as `basic-up.test.ts`. The `--no-browser` flag is critical so CI doesn't try to spawn Chrome.

The `/healthz` endpoint exists from Task 4 — it's the minimum-viable readiness probe.

---

### Task 22: E2e test — daemon auto-stops after last stack stops

**Dependencies:** Task 4 (auto-shutdown), Tasks 5, 20

**Files:**
- Create: `tests/e2e/daemon-auto-shutdown.test.ts`

**Acceptance criteria:**
- Test starts a stack, verifies daemon is alive, runs `lich down`, then polls for daemon to exit
- Asserts daemon exits within ~45s (30s grace + buffer)
- Asserts PID and URL files are cleared after exit

**Tests to write:**
- `tests/e2e/daemon-auto-shutdown.test.ts`

**Implementation notes:**

This test is slow (~45s) by design — that's the auto-shutdown timing. Wrap in a generous test timeout (60s).

To keep CI cost down: it's tempting to expose a `--shutdown-timeout-ms` flag on `lich-daemon` for tests to use shorter intervals. RESIST — tests should exercise the real timing. If the test takes too long for routine runs, mark it with a tag (`@slow`) and gate it behind a CI-only env var. Default: run it always; correctness over speed.

---

### Task 23: E2e test — friendly URL resolves to the right upstream

**Dependencies:** Tasks 8 (routing), 11 (proxy), 12 (daemon wires proxy)

**Files:**
- Create: `tests/e2e/friendly-urls.test.ts`

**Acceptance criteria:**
- Test starts the dogfood-stack with `--no-browser`
- Fetches `http://api.<worktree-name>.lich.localhost:<proxy_port>/health` (replacing `<worktree-name>` with the actual worktree name discovered from state.json, and `<proxy_port>` with whatever the config says — default 3300)
- Asserts the response body matches what `http://localhost:<api-raw-port>/health` returns
- Also tests `lich urls` default output contains the friendly URL string and `lich urls --raw` contains the raw URL string

**Tests to write:**
- `tests/e2e/friendly-urls.test.ts`

**Implementation notes:**

The `<worktree-name>` is derived from the tmpdir basename. The test discovers it by reading `state.json` after `lich up` (or by computing it the same way the worktree detector does). The `urls` helper from `tests/e2e/helpers/urls.ts` is already structured for this.

There may be a `*.localhost` resolution caveat on certain CI runners (some Docker-in-Docker setups don't have proper localhost resolution). If `node:dns.lookup('api.test.lich.localhost')` doesn't return `127.0.0.1`, fall back to setting the `Host` header manually and hitting `http://127.0.0.1:<proxy_port>/` — same effect, no DNS dependency. Test code should use this fallback robustly.

---

### Task 24: E2e test — dashboard `/api/stacks` returns running stacks

**Dependencies:** Task 6

**Files:**
- Create: `tests/e2e/helpers/dashboard-fetch.ts`
- Create: `tests/e2e/dashboard-stack-list.test.ts`

**Acceptance criteria:**
- `dashboard-fetch.ts` exports `fetchDashboardJson<T>(lichHome: string, path: string): Promise<T>` — reads the daemon URL from disk, fetches the path, returns parsed JSON
- Test starts a stack, calls `fetchDashboardJson('/api/stacks')`, asserts the response contains the stack with the right worktree name + service list
- Tests the response includes `active_profile` field (when set by Plan 3)
- Tests the response includes routing entries with friendly hostnames

**Tests to write:**
- `tests/e2e/dashboard-stack-list.test.ts`

**Implementation notes:**

The dashboard URL is dynamic (allocated port), so the test reads it from `<LICH_HOME>/daemon.url`. The helper is reused by Tasks 25 + 26 + 27.

---

### Task 25: E2e test — dashboard `/api/stacks/:id` returns per-service detail

**Dependencies:** Task 6

**Files:**
- Create: `tests/e2e/dashboard-stack-detail.test.ts`

**Acceptance criteria:**
- Test starts a stack, fetches `/api/stacks/<id>`, asserts:
  - Service list with correct states (web, api, supabase all in `ready`)
  - Allocated ports per service match `state.json`
  - Routing entries listed
- 404 case: fetch `/api/stacks/nonexistent` returns 404

**Tests to write:**
- `tests/e2e/dashboard-stack-detail.test.ts`

**Implementation notes:**

Reuses the dashboard-fetch helper from Task 24. The stack id is discovered from `<LICH_HOME>/stacks/` directory listing (mirroring the helper in `basic-up.test.ts`'s `findStackId`).

---

### Task 26: E2e test — dashboard renders failed service with reason

**Dependencies:** Tasks 6, 15

**Files:**
- Create: `tests/e2e/dashboard-failed-service.test.ts`
- Create: `examples/dogfood-stack/lich-failing-variant.yaml` (a copy of `lich.yaml` with a deliberately failing owned service)

**Acceptance criteria:**
- Test copies the dogfood-stack to a tmpdir, replaces `lich.yaml` with the failing variant (an owned service with `cmd: exit 1`)
- Runs `lich up` — expects non-zero exit (Plan 4's failure path)
- Fetches `/api/stacks/<id>` — asserts the failed service has `state: "failed"` and `failure_reason` is populated
- Asserts `failure_log_tail` is a non-empty array

**Tests to write:**
- `tests/e2e/dashboard-failed-service.test.ts`

**Implementation notes:**

The deliberately-failing yaml is a small fixture — keep it inline in the test file if it's simple enough (a 3-line owned service block + minimal env). Don't pollute `examples/dogfood-stack/` with broken-by-design fixtures.

Plan 4 already wrote `failure_reason` + `failure_log_tail` to state.json for failed services. This test verifies the dashboard surfaces them through the API. It does NOT verify the UI render — that's a manual smoke test (the v0 dashboard didn't unit-test its React components either).

---

### Task 27: E2e test — dashboard stop action tears down the stack

**Dependencies:** Task 16

**Files:**
- Create: `tests/e2e/dashboard-stop-action.test.ts`

**Acceptance criteria:**
- Test starts a stack, asserts it's `up`, POSTs `/api/stacks/<id>/stop`
- Asserts the response is 200 with `ok: true` (or the CLI's exit code in `exitCode`)
- Polls `state.json` for `status: stopped` within 60s
- Asserts the allocated ports stop listening

**Tests to write:**
- `tests/e2e/dashboard-stop-action.test.ts`

**Implementation notes:**

Reuses the `waitForStackStatus` helper for the polling. The 60s timeout accommodates the dogfood-stack's supabase teardown, which can be slow.

---

### Task 28: E2e test — two stacks visible simultaneously with distinct friendly URLs

**Dependencies:** Tasks 8, 11, 23, 24

**Files:**
- Create: `tests/e2e/dashboard-parallel-stacks.test.ts`

**Acceptance criteria:**
- Test starts two stacks (two tmpdirs, two `lich up` invocations sharing the same LICH_HOME)
- Fetches `/api/stacks` — asserts both stacks present
- Asserts the two stacks have different friendly hostnames (e.g., `api.feature-x.lich.localhost` vs `api.feature-y.lich.localhost`)
- Curls both friendly URLs — asserts each returns its own stack's data (NOT mixed up)
- Asserts the dashboard URL is the SAME for both invocations (the daemon is shared)

**Tests to write:**
- `tests/e2e/dashboard-parallel-stacks.test.ts`

**Implementation notes:**

This is the cross-cutting "worktree isolation" sentinel for Plan 5 specifically. The required parallel-stacks sentinel from the testing standards is at `tests/e2e/parallel-stacks.test.ts` (Plan 1); this is the Plan-5 specific version proving the daemon + proxy correctly serve two stacks at once.

The two tmpdir names need to be distinct so the worktree names differ. Use `copyExampleToTmpdir("dogfood-stack", { prefix: "lich-e2e-plan5-a-" })` and `... { prefix: "lich-e2e-plan5-b-" }` per the helper's `prefix` option.

---

### Task 29: Unskip Plan 0's gated `basic-up.test.ts` friendly URL test

**Dependencies:** Tasks 8, 11, 12, 17 (everything that makes friendly URLs work)

**Files:**
- Modify: `tests/e2e/basic-up.test.ts`

**Acceptance criteria:**
- The `it.todo("serves the web app over http://web.<worktree>.lich.localhost:3300/ ...")` line is replaced with a real `it(...)` block
- The test asserts `waitForHttp200("http://web.<worktree>.lich.localhost:3300/")` (with the worktree name substituted) returns the same HTML body as the raw URL
- Both `it` blocks in the file pass: the original "brings the stack up + raw URLs" AND the new friendly URL one

**Tests to write:**
- Modification of `tests/e2e/basic-up.test.ts`

**Implementation notes:**

THIS is the Plan 0 gate. The test was deliberately written as `it.todo` with the comment "TODO(Plan 5): unskip and assert HTTP 200 + same HTML body as raw URL." Honoring that contract: turn the `todo` into a real test, assert the friendly URL works, and verify the body matches what the raw URL returns.

After this task lands, Plan 0's acceptance criterion ("`basic-up.test.ts` will become passing once Plan 5's friendly URL piece lands") is met.

---

### Task 30: Update the lich-daemon binary's build step in main build

**Dependencies:** Tasks 4, 13

**Files:**
- Modify: `packages/lich/package.json` (composite `build` script)
- Modify: `packages/lich/README.md`
- Verify: `tests/e2e/basic-up.test.ts`'s `beforeAll` build step still works

**Acceptance criteria:**
- `cd packages/lich && bun run build` produces BOTH `dist/lich` AND `dist/lich-daemon`
- The UI is built (`build:ui`) before the daemon binary
- The daemon binary embeds or references the UI assets correctly
- The README explains the two binaries and how the daemon is auto-started

**Tests to write:**
- None for this task — purely scripting + docs

**Implementation notes:**

The composite build is `bun run build:ui && bun run build:cli && bun run build:daemon`. Order matters: UI must be built before the daemon binary, because the daemon either embeds the UI as an asset or references the dist-ui directory at runtime.

The e2e tests build the binary in `beforeAll`. They currently check for `dist/lich`; they need to also check for `dist/lich-daemon` and trigger a build if missing. Update both `tests/e2e/basic-up.test.ts` and any new e2e tests' beforeAll patterns. Consider extracting the build-check helper to `tests/e2e/helpers/build.ts` to share across tests.

---

### Task 31: README pass — document daemon, dashboard, friendly URLs

**Dependencies:** all functional tasks

**Files:**
- Modify: `packages/lich/README.md`

**Acceptance criteria:**
- README explains: what the daemon is, when it starts and stops, how to find the dashboard URL
- README explains: friendly URL pattern (`<service>.<worktree>.lich.localhost:3300/`), `--raw` fallback, why `*.localhost` works without setup
- README explains: `--no-browser` flag, environment variables (`LICH_HOME`), known limitations (no WebSocket through proxy)
- A pointer to the dashboard's `/` endpoint as the primary supervisory UI

**Tests to write:**
- None — docs

**Implementation notes:**

Keep the README concise; deep technical detail belongs in the spec. The README should give a user enough to: start a stack, find the dashboard, click around, and know what to do if something doesn't work.

---

### Task 32: Final integration sweep + acceptance verification

**Dependencies:** all previous tasks

**Files:**
- None directly modified — this is a verification task

**Acceptance criteria:**
- `cd packages/lich && bun test` passes (all unit tests, all suites)
- `cd tests/e2e && bun test` passes (every e2e test)
- Manual verification on a Mac:
  - `lich up` against the dogfood-stack opens the dashboard in the browser
  - Dashboard shows the stack with all services healthy
  - `http://web.<worktree>.lich.localhost:3300/` loads in the browser and renders the dogfood Next.js page
  - Open a second worktree, `lich up` there too — both stacks visible in the dashboard
  - `lich down` one — the other is still in the dashboard and reachable
  - `lich nuke` — dashboard goes away, both stacks gone
- Git log shows ~30-32 small, focused commits across the plan

**Tests to write:**
- None new; this is the "verify everything works together" task

**Implementation notes:**

This final sweep catches integration issues that unit + per-task e2e tests miss. The manual verification is critical because the dashboard UI's render quality and the browser-open behavior aren't well-covered by automated tests.

If the manual sweep finds issues, file follow-up tasks (don't try to fix-and-ship in this task). The plan is "done" when both test suites are green and the manual checklist passes.

---

## What Plan 6 will tackle

For preview / continuity:

- `lich:instrument` agent skill for filling in an existing project's `lich.yaml`
- Rewrite the root README to point at lich v1 as the canonical product
- Delete `packages/core/`, `packages/dashboard/`, all `packages/plugin-*`, `packages/template-v0-stack/`, `packages/create-stack-v0/`
- v0 archive housekeeping
