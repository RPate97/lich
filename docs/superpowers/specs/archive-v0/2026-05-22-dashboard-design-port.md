> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../../specs/2026-05-23-lich-v1-design.md` for the current spec and `../../plans/2026-05-23-lich-v1-plan-0-foundation.md` for the current plan. See `./README.md` in this directory for context.

---

# Dashboard design port — design

Linear: LEV-247
Date: 2026-05-22
Status: approved (brainstorm), pending implementation plan

## Problem

A polished visual design for the lich dashboard exists as a standalone prototype
in `sample-dashboard/` (CDN React + Babel, plain CSS, mock data). The shipped
`@lich/dashboard` package is a functional but plain shadcn/Tailwind app that
does not match the design. Bring the design into the real package.

## Goal

Replace the `@lich/dashboard` SPA with the `sample-dashboard/` design, wired
to the real backend, so the dashboard looks exactly like the design. Reuse the
design's CSS rather than rebuilding it in shadcn/Tailwind.

This is a **frontend-only** port. The server (`src/server/`) is untouched.

## Decisions (from brainstorm)

- **Tear out the shadcn layer.** The package stops being a shadcn/Tailwind app
  and becomes the design's plain-CSS app.
- **Reuse the design's CSS** (`sample-dashboard/styles.css`) ~verbatim.
- **Dark mode only** — the design is dark-native; there is no light theme.
- **Log view: `stream` layout only.** The prototype's `table`/`grouped` variants
  were tweak-panel options; dropped (YAGNI).
- **Degrade strategy: full visual fidelity, controls disabled.** Every design
  element renders. Data the backend can't supply yet shows a neutral placeholder;
  interactive controls with no backend render visibly disabled.

## Teardown

### Removed from `src/web/`

- All current components: `SummaryCards`, `StackTable`, `StackDrawer`,
  `ServiceRow`, `LogViewer`, `app-sidebar`, `site-header`.
- The entire `components/ui/` shadcn primitive set.
- `lib/utils.ts`.

### Removed dependencies

- Tailwind v4 + `@tailwindcss/vite`.
- shadcn-block deps: `@dnd-kit/core`, `@dnd-kit/modifiers`, `@dnd-kit/sortable`,
  `@dnd-kit/utilities`, `recharts`, `vaul`, `sonner`, `next-themes`, `radix-ui`,
  `@tanstack/react-table`, `class-variance-authority`, `clsx`, `tailwind-merge`,
  `tw-animate-css`, `lucide-react`.

### Kept

- `main.tsx` (React root), `api.ts` (`fetchStacks` + `openLogStream`),
  `hooks/usePolledStacks.ts` (2s poll), `src/types.ts`.
- The entire `src/server/` — unchanged.

### Result

Runtime deps collapse to `react`, `react-dom`, `@fontsource-variable/geist`,
`@fontsource-variable/jetbrains-mono`. Styling is one plain `styles.css`.
`vite.config.ts` drops the `@tailwindcss/vite` plugin.

## File / component structure

The prototype's six `window`-global JSX files become TS/ESM modules:

```
src/web/
  main.tsx            React root (kept)
  App.tsx             root: poll + selection state, renders Sidebar + Main
  styles.css          the design's stylesheet, brought over ~verbatim
  api.ts              fetchStacks + openLogStream (kept)
  hooks/
    usePolledStacks.ts   2s /api/stacks poll (kept)
  lib/
    format.ts         pure helpers ported from data.jsx:
                      fmtRelative, fmtClock, summarizeHealth, service-color palette
  components/
    Sidebar.tsx       brand + stack list; StackCard sub-component
    Main.tsx          MainHeader + Metrics; embeds Logs
    Logs.tsx          LogsHeader (search / filter chips / tail toggle) + LogStream
```

### Dropped from the prototype

- `tweaks-panel.jsx` — design-time tool.
- `data.jsx` — mock data + generators (replaced by the real API). Its pure
  helpers (`fmtRelative`, `fmtClock`, `summarizeHealth`) move to `lib/format.ts`.
- `app.jsx`'s accent/density tweak wiring: `applyAccent`, `lighten`, `useTweaks`.

### Component responsibilities

- **`App`** — owns the `/api/stacks` poll (`usePolledStacks`) and which stack is
  selected. Renders `Sidebar` + `Main`.
- **`Sidebar`** — brand header, stack count, the stack list. `StackCard`
  sub-component renders one stack.
- **`Main`** — `MainHeader` + `Metrics`, embeds `Logs`. Receives the selected
  stack.
- **`Logs`** — owns the SSE subscription and the log-line buffer. `LogsHeader`
  (search / filter chips / tail toggle) + `LogStream` (the line list).

Everything except `App` and `Logs` is presentational.

## Data wiring

Maps the real `/api/stacks` `StackView` + the SSE log stream onto the design.
`StackView` today: `{ key, path, branch, createdAt, status, worktreeMissing,
services: [{ name, kind, status: 'up'|'down', url? }], urls }`.

### Sidebar `StackCard`

| Design element | Source |
| -- | -- |
| branch | `branch` ✅ |
| agent | `"manual"` always — placeholder until LEV-241 |
| port range | derived from `entry.ports` (min–max of the numbers) |
| health pill (`n/total`) | `services` up-count / total ✅ |
| uptime | `now − createdAt` ✅ |
| "new" badge + arrival animation | `usePolledStacks` detecting stack keys not seen on the previous poll |

### `MainHeader`

branch / worktree (`path`) / ports / uptime — real. `agent` → `"manual"`.
`cpu` / `mem` → `"—"` placeholder (LEV-242). **Restart / Stop** buttons render
**disabled** with a "not yet available" `title` tooltip (LEV-246).

### `Metrics` cards (Services / Healthy / Unhealthy)

Real, computed from `services[]`. Service status maps `up → healthy`,
`down → down`. No `starting` / `unhealthy` states until LEV-243.

### `Logs`

- Streams the **selected service** over the existing single-service SSE endpoint
  (`/api/stacks/:key/logs/:service`). Default service = the first in the stack's
  `services[]`.
- The design's per-service **filter chips + "all"** render but are **disabled**
  until the merged multi-service stream lands (LEV-244).
- **Search box** works client-side over the buffered lines — substring match,
  and `/pattern/` for regex. (Frontend-only; no backend.)
- **Tail toggle** pauses/resumes appending to the view.
- Per-line **timestamp** and **level** coloring render when the streamed
  `LogEvent` carries them (`.jsonl` source); raw detached `.log` lines render
  message-only until LEV-245.
- **Service colors** assigned client-side from a fixed palette keyed by service
  name.

### Selection + empty state

- On load, auto-select the **newest** stack (max `createdAt`).
- No stacks: render the design's empty state — "No stacks running. Start one
  with `lich up`."

### Server

Untouched. The port consumes `/api/stacks` and
`/api/stacks/:key/logs/:service` exactly as they exist today.

## CSS / assets

- `sample-dashboard/styles.css` → `src/web/styles.css`, ~verbatim. The accent is
  hardcoded to the design default (`--lich-purple` / `--lich-green`). The
  tweak-driven `[data-density]` and `[data-sidebarStyle]` variant blocks are
  removed (their controls are gone); base styles are untouched.
- **Fonts** self-hosted, not CDN: `@fontsource-variable/geist` (already a dep)
  plus a new `@fontsource-variable/jetbrains-mono`, imported in `main.tsx`.
  Self-hosting works offline and embeds into the eventual compiled binary.

## Testing

- **Server tests unchanged** — `registry-reader`, `liveness`, `stacks`,
  `log-tailer`, `server` must stay green (the server is untouched).
- `summary.test.ts` is repointed to cover `lib/format.ts`.
- **New unit tests** for the pure helpers in `lib/format.ts` — `fmtRelative`,
  `fmtClock`, `summarizeHealth` — written TDD.
- No browser e2e (consistent with the original dashboard plan). The components
  are presentational; coverage is the build succeeding plus a manual smoke test.

## Build

- `vite build` (SPA → `dist/web`) + `tsup` (server → `dist/server`) — unchanged
  commands. `vite.config.ts` drops the `@tailwindcss/vite` plugin.
- The build must still emit `dist/web` + `dist/server` and pass the artifact
  smoke check (`startDashboardServer` serves `index.html` + `/api/stacks`).

## Scope boundaries — NOT in this port

- No backend changes — agent attribution, cpu/mem, richer health, merged log
  stream, structured detached-log metadata, and Stop/Restart actions are the
  separate tickets LEV-241 through LEV-246. This port renders their UI in a
  placeholder/disabled state.
- No light theme.
- No `table` / `grouped` log layouts.
- No new-stack creation from the dashboard.
