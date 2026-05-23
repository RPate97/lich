# Plan 10 — UI commands + shadcn + browser adapter

**Goal:** Define `UIAdapter` (shadcn impl) and `BrowserAdapter` (Playwright impl). Ship `lich ui add / ui list / screenshot / visual diff`.

**Architecture:**
- `UIAdapter`: shell-out to `npx shadcn` CLI in the apps/web subdir. v0 = thin wrapper; no shadcn-specific logic in the orchestrator.
- `BrowserAdapter`: thin wrapper over Playwright's `chromium.launch()` + page.screenshot. v0 = take a screenshot of a route, save to disk. Visual diff is a pixel-level subtraction with a simple threshold.
- All commands resolve the stack context; UI commands operate against `apps/web` (errors clearly if missing — plan 11 creates it).
- Screenshot tests spin up a tiny `http.createServer` returning known HTML to avoid depending on a real web service.

**Files:**
```
tools/cli/src/
  adapters/
    ui/
      types.ts                  # UIAdapter
      shadcn.ts                 # shadcn impl (shell-out)
    browser/
      types.ts                  # BrowserAdapter
      playwright.ts             # Playwright impl
  commands/
    ui/
      add.ts
      list.ts
    screenshot.ts
    visual.ts                   # `visual diff` subcommand
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 10.1 | UIAdapter interface + shadcn adapter | 1 | `adapters/ui/{types,shadcn}.ts` |
| 10.2 | BrowserAdapter interface + Playwright adapter | 1 | `adapters/browser/{types,playwright}.ts` |
| 10.3 | `ui add` + `ui list` commands | 2 | `commands/ui/{add,list}.ts` |
| 10.4 | `screenshot <route>` command | 2 | `commands/screenshot.ts` |
| 10.5 | `visual diff` command (pixel diff) | 3 | `commands/visual.ts` |
| 10.6 | Wire `ui.*`/`screenshot`/`visual.*` into bin + e2e | 4 | `bin.ts` + tests |

Wave 1 + 2 are parallel pairs. Wave 3 + 4 are sequential single.

## New deps

- `playwright` (browser automation)
- `pixelmatch` (image diff for `visual diff`)
- `pngjs` (transitive — image parsing for pixelmatch)

## Out of scope

- Visual regression baselines management — discovery follow-on.
- Headless headed-mode toggle — Playwright default suffices.
- Multi-browser (firefox/webkit) — Chromium only in v0.

## Verification

- `lich ui add button` shells out to shadcn against `apps/web/` (or fails clearly if absent — plan 11 produces apps/web).
- `lich ui list` reads installed components from components.json.
- `lich screenshot http://localhost:<test-port>` produces a PNG.
- `lich visual diff <baseline.png> <current.png>` returns a diff count and an optional --threshold gate.
- Full suite green; tsc clean.
