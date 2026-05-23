# lich monitoring dashboard — design

Linear: LEV-240
Date: 2026-05-21
Status: approved (brainstorm), pending implementation plan

## Problem

A developer (or agent) running multiple lich stacks across multiple git worktrees
has no single view of what is up. They juggle terminals: `lich stacks list` here,
`lich urls` there, `lich logs api` somewhere else. There is no live, at-a-glance
picture of the machine's stacks, their health, their UIs, or their logs.

## Goal

A local web dashboard — `lich dashboard` — that gives a live, single-pane view of
every lich stack on the machine: status, UI links, and live per-service logs.

Read-only in v1. It observes; it does not mutate.

## Decisions (from brainstorm)

- **Serving model:** on-demand command for v1. The server module is written
  lifecycle-agnostic so a daemon mode (`dashboard start/stop`) can be added later
  without rework.
- **Actions:** read-only v1. No start/stop/restart/nuke buttons.
- **Frontend:** Vite + React + shadcn/ui, pre-built to static assets and embedded
  in the package. No Node server at runtime; embeds cleanly into the LEV-239
  compiled binary.
- **UI scaffold:** the shadcn `dashboard-01` block (`npx shadcn@latest add
  dashboard-01`), adapted to lich's data.

## Architecture

### Package

New package `@lich/dashboard` at `packages/dashboard/`. Contains both the
frontend SPA and the HTTP/SSE server. Keeps the React/Vite build isolated from
`core`. `core` registers a `dashboard` command that imports the server entry
point from this package.

(Note: package naming follows the current `@lich/*` scheme. If LEV-221
renames the npm scope to `@lich/*`, this package renames with the rest.)

### Three layers

1. **Static SPA** — Vite + React + shadcn/ui, built at package-build time into
   `dist/web/`. Shipped inside the published package.
2. **HTTP/SSE server** — a small Bun HTTP server. Serves the static SPA plus a
   JSON API and an SSE endpoint. Binds to `127.0.0.1` only.
3. **Data layer** — reads existing on-disk state. Owns no new state of its own.
   Sources:
   - the global registry `~/.lich/registry.json` (via the existing
     `Registry` class)
   - owned-service liveness: `process.kill(pid, 0)` against the `<service>.pid`
     files in each stack's state dir
   - compose-service liveness: `docker inspect` against the container names in
     `StackEntry.containers`
   - per-service log files on disk

### Command

`lich dashboard`:
1. Allocates a free port (existing port-allocation helper).
2. Starts the Bun server bound to `127.0.0.1:<port>`.
3. Prints the URL and opens it in the browser.
4. Runs in the foreground until Ctrl-C, then shuts the server down cleanly
   (via the existing signal-handler cleanup registry).

### Data flow

- Browser polls `GET /api/stacks` every ~2s for the stack list and status.
- Browser opens an SSE connection to `GET /api/stacks/:key/logs/:service` when a
  log panel is expanded; closes it on collapse.
- The server is stateless between requests. Every `/api/stacks` call re-reads the
  registry and re-derives status, so a stack coming up or down in another
  terminal appears within one poll interval.

## Server API

### `GET /api/stacks`

Re-reads the registry on every call. Returns an array of stacks:

```ts
interface StackView {
  key: string;
  path: string;          // worktree path
  branch: string;
  createdAt: string;
  status: 'running' | 'partial' | 'down';   // derived, never stored
  worktreeMissing: boolean;                  // path no longer exists on disk
  services: ServiceView[];
  urls: Record<string, string>;              // clickable UI links
}

interface ServiceView {
  name: string;
  kind: 'owned' | 'compose';
  status: 'up' | 'down';
  url?: string;                              // present if the service has a UI
}
```

- **Owned services** are discovered from the `<service>.pid` files in the stack's
  state dir; status is `up` when `process.kill(pid, 0)` succeeds.
- **Compose services** are discovered from `StackEntry.containers`; status is `up`
  when `docker inspect` reports the container running.
- **Stack status:** `running` = all services up; `down` = none up; `partial` =
  some up.
- **URLs** come from `StackEntry.urls`, with the existing `localhost:<port>`
  fallback when `urls` is empty.

### `GET /api/stacks/:key/logs/:service` (SSE)

Live log stream for one service. See "Live log streaming" below.

### `GET /*`

Serves the static SPA from the embedded `dist/web/`.

## Status derivation — design principles

- **No new persisted state.** Status is always computed on read. There is nothing
  to keep in sync; the registry plus pid/docker liveness is the source of truth.
- **Stale-entry tolerance.** If a registry entry points at a worktree path that no
  longer exists, the stack still renders — marked `down` with `worktreeMissing:
  true` — rather than failing the whole `/api/stacks` response. (This is the
  LEV-220 class of mess; the dashboard surfaces it instead of choking on it.)

## Live log streaming

### Source selection

Per-service log files already on disk. Detached `dev` (the default) writes raw
`<service>.log` files; `--live` writes `<service>.jsonl`. The tailer prefers the
raw `.log` if present, else the `.jsonl` — matching the source-selection logic in
the existing `logs` command.

### Mechanism — tail by byte offset

1. On SSE connect, read the current file and send the last ~500 lines as an
   initial backlog event (bounds memory — does not replay a huge file).
2. Track the byte offset. Watch the file for growth (`fs.watch`, with a
   size-polling fallback for reliability across platforms). On growth, read
   `offset → newEnd`, split into lines, emit one SSE event per line.
3. If the file shrinks (`offset > size` — truncation/rotation), reset offset to 0
   and resync.
4. On client disconnect, tear down the watcher and any timers — no leaked FDs.

### Line shape

Each SSE event is normalized to:

```ts
interface LogEvent {
  line: string;
  ts?: string;     // present for .jsonl lines
  level?: 'info' | 'error';
  stream?: 'stdout' | 'stderr';
}
```

Raw `.log` lines carry only `line`. `.jsonl` lines carry the metadata. The
frontend renders timestamps and error-coloring when present, plain text
otherwise.

### Concurrency

Each expanded log panel is its own independent SSE connection with its own
watcher. No shared server-side stream state — one slow client cannot stall
another.

### v1 cut

The tailer follows the **active** log file only. The detached `.log` accumulates
across `dev` runs (separated by `--- lich up <ts> ---` markers), so history
is preserved without live-merging the `.log` and `.jsonl` sources.

## Frontend / UI

Scaffolded from the shadcn `dashboard-01` block, adapted:

- **`app-sidebar`** — minimal: lich branding + a scope filter (`All stacks` /
  `This worktree`). No deep navigation in v1.
- **`site-header`** — "lich dashboard" title + an "updated Ns ago" indicator so
  the poll is visibly live.
- **`section-cards`** — live summary KPIs: stacks **running**, **partial**,
  **down**, and **services live**. Fed by the `/api/stacks` poll.
- **`data-table`** (TanStack table) — the **stack list**. One row per stack:
  worktree/branch, status badge, service count, ports. Sorting/filtering from the
  block is kept — useful with many worktrees up.
- **`chart-area-interactive`** — **dropped for v1** (no time-series worth
  charting). The slot is left in place so per-stack uptime/metrics can be added
  later.

### Stack detail + live logs

`dashboard-01`'s data-table rows already open a drawer (`TableCellViewer`). Reuse
it: clicking a stack row opens a **drawer** showing the stack's service rows
(name, kind, status, UI-link buttons) and the `LogViewer` panels. The live-log
SSE viewer lives in the drawer, not in a table cell.

`LogViewer`: a monospace scroll area that auto-scrolls to the bottom, pausing
auto-scroll when the user scrolls up to read history. Opens an `EventSource` on
expand, closes it on collapse.

### Component breakdown

- `App` — layout + the `usePolledStacks()` hook (2s `fetch`), feeds the cards and
  the table.
- `StackTable` — table columns + row→drawer wiring.
- `StackDrawer` — per-stack service list + UI links.
- `ServiceRow` — one service line.
- `LogViewer` — SSE-backed live log panel.

No global state library — React state suffices at this size.

### Empty state

"No stacks running — run `lich up`."

## Testing

- **Server / data layer** (the bulk) — unit tests that run without Docker. Point
  the registry reader at a fixture `registry.json`; fake pid files (a live pid =
  `process.pid`, a dead one = a never-allocated pid); stub docker liveness. Assert
  `status` derivation, `worktreeMissing` handling, and the `/api/stacks` payload
  shape.
- **SSE log tailer** — unit tests against a temp file: initial backlog, append →
  event emitted, truncation → offset reset, disconnect → watcher torn down.
- **Frontend** — light component tests: `StackTable`, `StackDrawer`, `LogViewer`
  render correctly given props. No browser-automation e2e in v1.
- **One integration test** — start the real server against a fixture registry,
  `fetch /api/stacks`, assert the payload. Full dogfood e2e (real stack + real
  dashboard) is deferred — too slow for the v1 value.

## Scope boundaries — explicitly NOT in v1

- No actions (start/stop/restart/nuke). Read-only.
- No daemon. On-demand command only; server module written lifecycle-agnostic so
  `dashboard start/stop` slots in later.
- No chart / metrics / time-series.
- No auth. Server binds to `127.0.0.1` only — local-machine tool, no remote
  surface.
- No log search/filter UI. Live-tail only; `lich logs` already does
  grep/since/level.
- No live merge of `.log` and `.jsonl` sources — the tailer follows the active
  file.

## v1.1 — Stop / Restart actions (LEV-246)

The read-only invariant was intentional in v1 to ship a safe, observable-only
tool quickly. v1.1 deliberately relaxes it for exactly two mutating actions:
**Stop** and **Restart**.

### Rationale

`lich restart` (LEV-249) and `lich down` are the two most common operations a
developer wants to perform immediately after viewing the dashboard. Without
buttons, the only path is to leave the browser, find the right terminal, and
run the CLI manually — defeating the "single pane" goal.

### Safety constraint preserved

The server continues to bind to `127.0.0.1` only (no remote surface). Both
action endpoints (`POST /api/stacks/:key/restart`, `POST /api/stacks/:key/stop`)
require an explicit POST and check that the key exists in the registry before
shelling out. A non-zero CLI exit is returned as an `ActionResult` (not a 500)
so the UI can display the captured stderr to the developer.

### Implementation

- **`packages/dashboard/src/server/actions.ts`** — `runLichAction(worktreePath,
  command)` shells `bun run lich <command>` with `cwd: worktreePath` and a
  30-second timeout. Named `runLichAction` so the upcoming `lich` rename (LEV-221)
  only changes the literal string in one place.
- **`server.ts`** — two new POST routes delegating to the above; GET on those
  paths returns 405.
- **`web/api.ts`** — `restartStack(key)` and `stopStack(key)` POST to the new
  endpoints and return `ActionResult`.
- **`web/components/Main.tsx`** — Restart and Stop buttons wired with confirm
  dialogs, in-flight disabled state (`Restart…` / `Stop…`), and `alert` on
  failure. After success the existing poll picks up state changes automatically.

## Open items for the implementation plan

- Confirm the package-build wiring: Vite build of the SPA must run as part of
  `@lich/dashboard`'s build and emit `dist/web/` into the published package.
- Confirm the `dashboard` command registration path in `core`'s command registry.
- Decide the exact free-port helper reuse (`packages/core/src/ports/`).
