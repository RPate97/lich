> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../../specs/2026-05-23-lich-v1-design.md` for the current spec and `../../plans/2026-05-23-lich-v1-plan-0-foundation.md` for the current plan. See `./README.md` in this directory for context.

---

# Dashboard Design Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `@lich/dashboard` SPA with the `sample-dashboard/` visual design, wired to the real backend.

**Architecture:** Tear out the shadcn/Tailwind layer; the package becomes a plain-CSS React app. Port the prototype's six `window`-global JSX files into typed ESM modules under `src/web/`, reusing the design's `styles.css` verbatim and wiring components to the real `/api/stacks` poll + SSE log stream. Frontend-only — `src/server/` is untouched.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, plain CSS. Removes Tailwind v4 + shadcn.

Spec: `docs/superpowers/specs/2026-05-22-dashboard-design-port.md`
Design source (committed in-repo): `sample-dashboard/` — `sidebar.jsx`, `main.jsx`, `logs.jsx`, `data.jsx`, `app.jsx`, `styles.css`.

---

## File Structure

```
packages/dashboard/
  package.json          MODIFY — drop shadcn/tailwind deps, add jetbrains-mono font
  vite.config.ts        MODIFY — drop the @tailwindcss/vite plugin
  src/types.ts          MODIFY — add LogLine view type (id-tagged LogEvent)
  src/web/
    main.tsx            MODIFY — import styles.css + fonts
    App.tsx             REWRITE — poll + selection + arrival, renders Sidebar + Main
    styles.css          CREATE — copied from sample-dashboard/styles.css (~verbatim)
    api.ts              KEEP — fetchStacks + openLogStream
    hooks/usePolledStacks.ts   KEEP
    lib/format.ts       CREATE — fmtRelative, fmtClock, summarizeHealth, serviceColor
    components/
      Sidebar.tsx       CREATE — ported from sample-dashboard/sidebar.jsx
      Main.tsx          CREATE — ported from sample-dashboard/main.jsx
      Logs.tsx          CREATE — ported from sample-dashboard/logs.jsx, SSE-wired
  tests/
    format.test.ts      CREATE — replaces summary.test.ts
```

**Deleted:** `src/web/index.css`, `src/web/lib/utils.ts`, `src/web/hooks/use-mobile.ts`, all of `src/web/components/` (`LogViewer`, `ServiceRow`, `StackDrawer`, `StackTable`, `SummaryCards`, `app-sidebar`, `site-header`, `summary.ts`, and the whole `ui/` directory), `tests/summary.test.ts`.

---

## Task 1: Teardown — plain-CSS base, deps, buildable stub

**Files:**
- Delete: `src/web/index.css`, `src/web/lib/utils.ts`, `src/web/hooks/use-mobile.ts`, `src/web/components/` (entire directory)
- Delete: `tests/summary.test.ts`
- Create: `src/web/styles.css`
- Modify: `packages/dashboard/package.json`, `packages/dashboard/vite.config.ts`, `src/web/main.tsx`, `src/web/App.tsx`

- [ ] **Step 1: Delete the shadcn layer**

```bash
cd packages/dashboard
rm -rf src/web/components
rm src/web/index.css src/web/lib/utils.ts src/web/hooks/use-mobile.ts tests/summary.test.ts
```

(`src/web/lib/` is now empty — leave it; `lib/format.ts` lands there in Task 2.)

- [ ] **Step 2: Copy the design's stylesheet**

```bash
cp ../../sample-dashboard/styles.css src/web/styles.css
```

Then edit `src/web/styles.css` and delete these four tweak-only rule blocks (their controls don't exist in the port):
- the `[data-density="compact"] { … }` block
- the `[data-density="comfy"] { … }` block
- the `[data-sidebar-style="cards"] …` rules (three consecutive rules)
- the `[data-sidebar-style="minimal"] …` rules (three consecutive rules)

Leave everything else — including the `:root` density variables (those are the defaults) — exactly as-is.

- [ ] **Step 3: Rewrite `packages/dashboard/package.json` dependencies**

Set the `dependencies` and `devDependencies` blocks to exactly this (removes Tailwind + all shadcn-block deps; adds the mono font):

```json
  "dependencies": {
    "@fontsource-variable/geist": "^5.2.9",
    "@fontsource-variable/jetbrains-mono": "^5.2.5",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "bun-types": "^1.2.0",
    "typescript": "^5.4.0",
    "vite": "^5.4.0",
    "vitest": "^1.6.0"
  }
```

- [ ] **Step 4: Drop the Tailwind plugin from `vite.config.ts`**

Remove the `import tailwindcss from '@tailwindcss/vite'` line and remove `tailwindcss()` from the `plugins` array. The result:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src/web') },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 5: Rewrite `src/web/main.tsx`**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Note: the font packages register the families **"Geist Variable"** and **"JetBrains Mono Variable"**. After Step 6's build, if text is not rendering in those fonts, adjust the `--font-sans` / `--font-mono` values in `styles.css` to lead with those exact family names.

- [ ] **Step 6: Replace `src/web/App.tsx` with a temporary stub**

```tsx
// Temporary stub — replaced in Task 6.
export function App() {
  return <div className="app">loading…</div>;
}
```

- [ ] **Step 7: Install and verify the build**

Run: `bun install` (from repo root)
Run: `bun run --cwd packages/dashboard build:web`
Expected: Vite build succeeds, emits `dist/web/index.html` + a CSS bundle.

Run: `bun run --cwd packages/dashboard typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A packages/dashboard bun.lock
git commit -m "feat(LEV-247): tear out shadcn layer, bring in design stylesheet"
```

---

## Task 2: `lib/format.ts` — pure presentation helpers

**Files:**
- Create: `packages/dashboard/src/web/lib/format.ts`
- Create: `packages/dashboard/tests/format.test.ts`

These are the pure helpers the ported components need — `fmtRelative` and `fmtClock` are copied from `sample-dashboard/data.jsx`; `summarizeHealth` and `serviceColor` are adapted for the real data model.

- [ ] **Step 1: Write the failing test**

```ts
// packages/dashboard/tests/format.test.ts
import { describe, it, expect } from 'vitest';
import { fmtRelative, fmtClock, summarizeHealth, serviceColor } from '../src/web/lib/format';
import type { ServiceView } from '../src/types';

describe('fmtRelative', () => {
  it('formats seconds, minutes, hours, days', () => {
    expect(fmtRelative(5_000)).toBe('5s');
    expect(fmtRelative(120_000)).toBe('2m');
    expect(fmtRelative(3_600_000)).toBe('1h 0m');
    expect(fmtRelative(90_000_000)).toBe('1d 1h');
  });
});

describe('fmtClock', () => {
  it('formats an epoch ms as HH:MM:SS', () => {
    const ts = new Date('2026-05-22T09:08:07').getTime();
    expect(fmtClock(ts)).toBe('09:08:07');
  });
});

describe('summarizeHealth', () => {
  it('counts up / down / total', () => {
    const services: ServiceView[] = [
      { name: 'api', kind: 'owned', status: 'up' },
      { name: 'web', kind: 'owned', status: 'up' },
      { name: 'db', kind: 'compose', status: 'down' },
    ];
    expect(summarizeHealth(services)).toEqual({ up: 2, down: 1, total: 3 });
  });

  it('handles an empty service list', () => {
    expect(summarizeHealth([])).toEqual({ up: 0, down: 0, total: 0 });
  });
});

describe('serviceColor', () => {
  it('is stable for the same name', () => {
    expect(serviceColor('api')).toBe(serviceColor('api'));
  });
  it('returns a hex color', () => {
    expect(serviceColor('whatever')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/dashboard test format`
Expected: FAIL — cannot find `../src/web/lib/format`.

- [ ] **Step 3: Write `src/web/lib/format.ts`**

```ts
import type { ServiceView } from '../../types';

/** Human relative duration from a millisecond span. Ported from data.jsx. */
export function fmtRelative(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Epoch-ms → HH:MM:SS clock. Ported from data.jsx. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface HealthSummary {
  up: number;
  down: number;
  total: number;
}

/** Count service liveness for a stack. */
export function summarizeHealth(services: ServiceView[]): HealthSummary {
  const up = services.filter((s) => s.status === 'up').length;
  return { up, down: services.length - up, total: services.length };
}

// Fixed palette — known service names get a stable hue; anything else falls
// back to a hash into the palette. Mirrors the prototype's SERVICE_DEFS colors.
const KNOWN: Record<string, string> = {
  postgres: '#60a5fa',
  redis: '#f87171',
  temporal: '#fbbf24',
  api: '#a78bfa',
  workers: '#4ade80',
  web: '#22d3ee',
};
const PALETTE = ['#a78bfa', '#4ade80', '#22d3ee', '#fbbf24', '#f87171', '#60a5fa'];

/** Stable display color for a service, keyed by name. */
export function serviceColor(name: string): string {
  const known = KNOWN[name];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd packages/dashboard test format`
Expected: PASS — all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/web/lib/format.ts packages/dashboard/tests/format.test.ts
git commit -m "feat(LEV-247): pure format/health/color helpers for the dashboard UI"
```

---

## Task 3: `Sidebar.tsx`

**Files:**
- Create: `packages/dashboard/src/web/components/Sidebar.tsx`

Port `sample-dashboard/sidebar.jsx` (`BrandMark`, `HealthPill`, `StackCard`, `Sidebar`) into one typed module. **Read `sample-dashboard/sidebar.jsx` first** — keep its JSX markup and `className`s exactly (the CSS depends on them).

- [ ] **Step 1: Port the file with these transformations**

Create `src/web/components/Sidebar.tsx` containing the prototype's `BrandMark`, `HealthPill`, `StackCard`, and `Sidebar` components, transformed as follows:

1. **ESM/TS:** add `import { serviceColor, summarizeHealth, fmtRelative } from '../lib/format';` and `import type { StackView } from '../types';`. Remove the trailing `Object.assign(window, …)`. `export function Sidebar(...)`.

2. **Prop types:**

```ts
interface SidebarProps {
  stacks: StackView[];
  selectedKey: string | undefined;
  onSelect: (key: string) => void;
  newestKey: string | undefined;
  arrivedKeys: Set<string>;
}
interface StackCardProps {
  stack: StackView;
  selected: boolean;
  isNew: boolean;
  justArrived: boolean;
  onSelect: (key: string) => void;
}
```

3. **Data wiring** — the prototype's mock `stack` had `{id, branch, agent, startedAt, portRange, services}`. Map to the real `StackView`:
   - `stack.id` → `stack.key` everywhere (the `key` prop, `onSelect`, `selected` comparison).
   - `stack.branch` → `stack.branch` (unchanged).
   - `stack.agent` → **always render the literal `"manual"`** (the "manual" branch of the prototype's conditional). The agent feature is LEV-241; drop the `stack.agent ? … : …` conditional and keep only the manual span.
   - `stack.portRange` → derive inline: `const ports = Object.values(stack.ports); const portRange = ports.length ? \`${Math.min(...ports)}-${Math.max(...ports)}\` : '—';`
   - uptime — the prototype used `Date.now() - stack.startedAt`; use `Date.now() - new Date(stack.createdAt).getTime()` instead.

4. **`HealthPill`** — replace the prototype's `summarizeHealth` (which returned `{healthy, unhealthy, total}`) usage with the new `summarizeHealth` from `lib/format` returning `{up, down, total}`. Render `{up}/{total}`. The `cls` is `'unhealthy'` when `down > 0`, else `'healthy'`. (Keep the `degraded` branch dead-removed — with up/down only there's no third state.)

5. **`Sidebar`** — the stack list maps `stacks` to `<StackCard>`; `key={s.key}`, `selected={s.key === selectedKey}`, `isNew={s.key === newestKey}`, `justArrived={arrivedKeys.has(s.key)}`. Keep the brand header, the `+` "New stack" button (render it but it's inert — no handler; LEV-246/T7 are out of scope), the "Stacks {count}" sub-header, and the footer ("daemon" pulse + version) exactly as the prototype has them. Hardcode the footer version string as `v0.1.0`.

- [ ] **Step 2: Verify the build**

Run: `bun run --cwd packages/dashboard typecheck`
Expected: PASS.

(`Sidebar` is not yet rendered by anyone — `App` wires it in Task 6. Typecheck is the gate here.)

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/web/components/Sidebar.tsx
git commit -m "feat(LEV-247): port sidebar + stack cards from the design"
```

---

## Task 4: `Main.tsx`

**Files:**
- Create: `packages/dashboard/src/web/components/Main.tsx`

Port `sample-dashboard/main.jsx` (`MetaItem`, `MainHeader`, `Metrics`, `Main`) into one typed module. **Read `sample-dashboard/main.jsx` first.** Discard the prototype's stub `MainContent` (it returns `null` — dead). Keep all JSX markup + `className`s exactly.

- [ ] **Step 1: Port the file with these transformations**

Create `src/web/components/Main.tsx` with `MetaItem`, `MainHeader`, `Metrics`, and `Main`, transformed:

1. **ESM/TS:** `import { fmtRelative, summarizeHealth } from '../lib/format';`, `import { Logs } from './Logs';`, `import type { StackView } from '../types';`. Remove `Object.assign(window, …)`. `export function Main(...)`.

2. **Prop types:**

```ts
interface MainProps { stack: StackView; }
```

`MainHeader` and `Metrics` each take `{ stack: StackView }`.

3. **`MainHeader` data wiring:**
   - title — `stack.branch`.
   - `agent` MetaItem — render the literal `"manual"` (LEV-241); drop the `stack.agent &&` conditional, always show the `agent` MetaItem with value `"manual"`.
   - `worktree` MetaItem — `stack.path`.
   - `ports` MetaItem — `Object.values(stack.ports)` min–max, same derivation as Task 3 (`'—'` when empty).
   - `up` MetaItem — `fmtRelative(Date.now() - new Date(stack.createdAt).getTime())`.
   - `cpu` MetaItem — value `'—'` (placeholder; LEV-242).
   - `mem` MetaItem — value `'—'` (placeholder; LEV-242).
   - **Restart / Stop buttons** — keep both buttons in the markup, but add `disabled` and `title="not yet available"` to each (LEV-246).

4. **`Metrics`** — the three cards (Services / Healthy / Unhealthy). Use `summarizeHealth(stack.services)` → `{up, down, total}`:
   - Services card — value `total`, hint `stack.services.map((s) => s.name).join(' · ')`.
   - Healthy card — value `up`, `/${total}` unit; hint `up === total ? 'all systems nominal' : \`${total - up} not yet ready\``.
   - Unhealthy card — value `down`; add the `zero` class when `down === 0`; hint `down === 0 ? 'no failing services' : \`${stack.services.filter((s) => s.status === 'down').map((s) => s.name).join(', ')} down\``.

5. **`Main`** — renders `<MainHeader stack={stack} />`, `<Metrics stack={stack} />`, `<Logs stack={stack} />`. (The prototype passed a `logVariant` prop; drop it — Task 5's `Logs` has no variants.)

- [ ] **Step 2: Verify typecheck**

Run: `bun run --cwd packages/dashboard typecheck`
Expected: FAIL — `./Logs` does not exist yet. That is expected; Task 5 creates it. Confirm the only error is the missing `./Logs` import, then proceed.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/web/components/Main.tsx
git commit -m "feat(LEV-247): port main header + metric cards from the design"
```

---

## Task 5: `Logs.tsx` — SSE-wired log panel

**Files:**
- Modify: `packages/dashboard/src/types.ts`
- Create: `packages/dashboard/src/web/components/Logs.tsx`

Port `sample-dashboard/logs.jsx` — but **replace its mock data layer** (`makeLogs`, the simulated-tick `useEffect`, `synthLine`/`__SYNTH`) with the real SSE stream. Keep `IconSearch`, `Highlighted`, `LogLevel`, `LogsHeader`, and the `LogStream` view markup + `className`s exactly. **Drop** `LogTable` and `LogGrouped` (the `table`/`grouped` variants — out of scope).

- [ ] **Step 1: Add a view type to `src/types.ts`**

Append to `packages/dashboard/src/types.ts`:

```ts
/** A log line as the Logs UI holds it — a LogEvent plus a render key + service. */
export interface LogLine {
  id: string;
  service: string;
  line: string;
  ts?: string;
  level: 'info' | 'error' | 'debug' | 'warn';
}
```

- [ ] **Step 2: Create `src/web/components/Logs.tsx`**

Structure — port from `logs.jsx`:

1. **Keep verbatim:** `IconSearch`, `Highlighted` (search-term highlighter), `LogLevel` (the `lvl` badge), and the `LogStream` component's markup. Type their props (`Highlighted`: `{ text: string; query: string }`; `LogLevel`: `{ level: string }`; `LogStream`: `{ logs: LogLine[]; query: string }`).

2. **`LogStream`** — the prototype keyed lines by `line.svc` color via a `svcMap`. Instead colorize from `serviceColor(line.service)` (import from `../lib/format`). Each row renders `fmtClock` of `line.ts` **only if `line.ts` is present** (raw `.log` lines have none — render the `ts` span empty in that case); the `svc` span shows `line.service`; the message uses `<LogLevel>` + `<Highlighted>`.

3. **`LogsHeader`** — keep the search input (with the `/` focus shortcut) and the tail toggle exactly. The **service filter chips**: render one chip per `stack.services` plus the "all" chip, but every chip gets `disabled` + `title="filtering needs the merged log stream (LEV-244)"`. They are visual-only for this port.

4. **Replace the data layer** — the `Logs` component:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { openLogStream } from '../api';
import { serviceColor, fmtClock } from '../lib/format';
import type { LogLine } from '../types';
import type { StackView } from '../types';

const MAX_LINES = 800;

export function Logs({ stack }: { stack: StackView }) {
  const [query, setQuery] = useState('');
  const [tail, setTail] = useState(true);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Stream the FIRST service of the stack. Multi-service merge is LEV-244;
  // until then the filter chips are inert and one service is shown.
  const service = stack.services[0]?.name;

  useEffect(() => {
    setLogs([]);
    if (!service) return;
    let n = 0;
    const close = openLogStream(stack.key, service, (e) => {
      setLogs((prev) => {
        const next = [
          ...prev,
          {
            id: `${stack.key}-${service}-${n++}`,
            service,
            line: e.line,
            ts: e.ts,
            level: (e.level ?? 'info') as LogLine['level'],
          },
        ];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
    return close;
  }, [stack.key, service]);

  // Search filter — substring, or /pattern/ for regex (ported from logs.jsx).
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return logs;
    if (q.length >= 2 && q.startsWith('/') && q.endsWith('/')) {
      try {
        const re = new RegExp(q.slice(1, -1), 'i');
        return logs.filter((l) => re.test(l.line) || re.test(l.service));
      } catch {
        return logs;
      }
    }
    const lq = q.toLowerCase();
    return logs.filter(
      (l) => l.line.toLowerCase().includes(lq) || l.service.toLowerCase().includes(lq),
    );
  }, [logs, query]);

  // Auto-scroll while tailing.
  useEffect(() => {
    if (tail && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [filtered.length, tail]);

  return (
    <div className="logs">
      <LogsHeader
        query={query}
        setQuery={setQuery}
        services={stack.services}
        tail={tail}
        setTail={setTail}
      />
      <div className="log-viewport" ref={viewportRef}>
        <LogStream logs={filtered} query={query} />
        {filtered.length === 0 && (
          <div className="empty">
            {query ? `No logs match "${query}"` : 'No logs to show'}
          </div>
        )}
      </div>
    </div>
  );
}
```

`LogsHeader`'s props are `{ query, setQuery, services, tail, setTail }` — note there is **no** `activeSvcs`/`toggleSvc`/`clearSvcs` (those drove the now-disabled chips) and **no** `variant`. The `tail` toggle still flips the `tail` state; when `tail` is false the auto-scroll effect is skipped (lines still append — pausing only stops the scroll, matching the prototype's intent closely enough for v1).

5. Export `Logs`.

- [ ] **Step 3: Verify the build**

Run: `bun run --cwd packages/dashboard typecheck`
Expected: PASS (`Main.tsx`'s `./Logs` import now resolves).

Run: `bun run --cwd packages/dashboard test`
Expected: PASS — server + `format` tests (no Logs test; it's presentational + SSE-bound).

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/types.ts packages/dashboard/src/web/components/Logs.tsx
git commit -m "feat(LEV-247): port log panel, wired to the real SSE stream"
```

---

## Task 6: `App.tsx` — compose, poll, selection, arrival

**Files:**
- Rewrite: `packages/dashboard/src/web/App.tsx`

- [ ] **Step 1: Write `src/web/App.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePolledStacks } from './hooks/usePolledStacks';
import { Sidebar } from './components/Sidebar';
import { Main } from './components/Main';
import type { StackView } from './types';

export function App() {
  const { stacks: raw } = usePolledStacks();

  // Newest first — the sidebar lists newest at top and the newest auto-selects.
  const stacks = useMemo(
    () =>
      [...raw].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [raw],
  );

  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);

  // Auto-select the newest stack once, on first arrival of data.
  useEffect(() => {
    if (selectedKey === undefined && stacks.length > 0) {
      setSelectedKey(stacks[0]!.key);
    }
  }, [stacks, selectedKey]);

  // Arrival animation: flag keys that appeared since the previous poll.
  const prevKeysRef = useRef<Set<string>>(new Set());
  const [arrivedKeys, setArrivedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(stacks.map((s) => s.key));
    const fresh = new Set<string>();
    for (const k of current) if (!prevKeysRef.current.has(k)) fresh.add(k);
    prevKeysRef.current = current;
    if (fresh.size > 0) {
      setArrivedKeys(fresh);
      const t = setTimeout(() => setArrivedKeys(new Set()), 900);
      return () => clearTimeout(t);
    }
  }, [stacks]);

  const selected: StackView | undefined =
    stacks.find((s) => s.key === selectedKey) ?? stacks[0];
  const newestKey = stacks[0]?.key;

  return (
    <div className="app">
      <Sidebar
        stacks={stacks}
        selectedKey={selected?.key}
        onSelect={setSelectedKey}
        newestKey={newestKey}
        arrivedKeys={arrivedKeys}
      />
      {selected ? (
        <Main stack={selected} />
      ) : (
        <main className="main">
          <div className="empty">
            No stacks running. Start one with <span className="kbd">lich up</span>.
          </div>
        </main>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the build**

Run: `bun run --cwd packages/dashboard typecheck`
Expected: PASS.

Run: `bun run --cwd packages/dashboard build:web`
Expected: Vite build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/web/App.tsx
git commit -m "feat(LEV-247): compose the ported dashboard — poll, selection, arrival"
```

---

## Task 7: Full build verification

**Files:** none (verification + commit only)

- [ ] **Step 1: Full package build**

Run: `bun run --cwd packages/dashboard build`
Expected: Vite emits `dist/web/`, tsup emits `dist/server/index.js` + `.d.ts`. No reference to Tailwind.

- [ ] **Step 2: Artifact smoke check**

```bash
cd packages/dashboard && bun -e "
  import('./dist/server/index.js').then(async (m) => {
    const h = await m.startDashboardServer({ registryPath: '/tmp/none.json', port: 0 });
    const idx = await fetch(h.url + '/');
    const api = await fetch(h.url + '/api/stacks');
    console.log('index', idx.status, '| api', api.status, await api.text());
    await h.stop();
  });
"
```

Expected: `index 200 | api 200 {"stacks":[]}` — the built SPA is served and the API responds.

- [ ] **Step 3: Tests + typecheck across the package**

Run: `bun run --cwd packages/dashboard test`
Expected: PASS — server suite (`registry-reader`, `liveness`, `stacks`, `log-tailer`, `server`) + `format`.

Run: `bun run --cwd packages/dashboard typecheck`
Expected: PASS.

- [ ] **Step 4: Repo-wide build**

Run: `bun run build` (repo root)
Expected: `@lich/dashboard` builds. (Pre-existing failures in unrelated packages — e.g. `@lich/plugin-redis` typecheck when `@lich/core` is unbuilt — are not introduced by this task; report them but do not fix them here.)

- [ ] **Step 5: Manual smoke test (human)**

This step is for the human reviewer, not the implementer: `bun run lich dashboard` with a stack up — confirm the design renders (sidebar stack cards, main header, metric cards, live logs), the newest stack is auto-selected, and dark theme + Lich brand colors are correct.

- [ ] **Step 6: Commit (if any verification touch-ups were needed)**

```bash
git add -A packages/dashboard
git commit -m "chore(LEV-247): dashboard design port — build verification"
```

(Skip this commit if Steps 1–4 passed with no changes.)

---

## Self-Review notes

- **Spec coverage:** teardown of the shadcn layer + deps (Task 1); `styles.css` verbatim minus tweak blocks (Task 1); fonts self-hosted (Task 1); `lib/format.ts` helpers (Task 2); Sidebar/StackCard port (Task 3); Main/MainHeader/Metrics port + cpu/mem placeholder + disabled Restart/Stop (Task 4); Logs port, `stream`-only, SSE-wired, search client-side, tail toggle, disabled filter chips, timestamp/level when present (Task 5); App poll + default-newest selection + arrival animation + empty state (Task 6); build/smoke verification (Task 7). All spec sections map to a task.
- **Out of scope, per spec:** no server changes, no light theme, no `table`/`grouped` log layouts, no new-stack creation — none appear as tasks. The `+` button and Restart/Stop render inert/disabled per the "full visual fidelity" decision.
- **Type consistency:** `StackView` / `ServiceView` / `LogEvent` come from `src/types.ts` (unchanged); `LogLine` is added there in Task 5 and consumed by `Logs.tsx`. `HealthSummary` (`{up, down, total}`) is defined in `lib/format.ts` (Task 2) and consumed by `Sidebar` (Task 3) and `Main` (Task 4) — both use the `up`/`down`/`total` names consistently. `serviceColor` / `fmtRelative` / `fmtClock` / `summarizeHealth` signatures are fixed in Task 2 and used unchanged in Tasks 3–5.
- **Known interim build state:** Task 4's typecheck fails on the missing `./Logs` import until Task 5 — explicitly called out in Task 4 Step 2 so the implementer doesn't treat it as a regression.
