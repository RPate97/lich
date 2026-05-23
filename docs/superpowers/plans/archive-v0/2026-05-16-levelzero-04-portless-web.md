> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../../specs/2026-05-23-lich-v1-design.md` for the current spec and `../../plans/2026-05-23-lich-v1-plan-0-foundation.md` for the current plan. See `./README.md` in this directory for context.

---

# Plan 04 — portless integration for web

**Goal:** Define a `PortlessAdapter` that registers per-worktree URLs like `https://<branch>.myapp.localhost` for the web service. Ship `lich urls` and integrate URL registration into `lich up`. Gracefully degrade when portless isn't available.

**Architecture:**
- `PortlessAdapter` interface: `register({ host, target }) → Promise<void>`, `unregister(host)`, `list() → URLEntry[]`, `available() → boolean`.
- v0 implementation shells out to `portless` CLI; `available()` checks if `portless` is on PATH and responsive.
- `dev` calls `portlessAdapter.register({ host, target })` for owned services that declare a `urlName` field. Stack registry stores `urls` per service.
- `lich urls` prints the URL table for the current worktree (or all stacks with `--all`).
- If portless unavailable: log a warning, continue with plain `http://localhost:<port>` URLs.

**Files:**
```
tools/cli/src/
  adapters/
    portless/
      types.ts                  # PortlessAdapter
      portless.ts               # portless CLI shell-out impl
      noop.ts                   # fallback when portless not installed
  services/
    types.ts                    # extend OwnedService: add optional urlName
  commands/
    urls.ts                     # lich urls
    dev.ts                      # MODIFY: register URLs through adapter
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 04.1 | PortlessAdapter interface + types | 1 | `adapters/portless/types.ts` |
| 04.2 | portless CLI impl + noop fallback | 2 | `adapters/portless/{portless,noop}.ts` |
| 04.3 | Extend OwnedService.urlName + Stack URL persistence | 2 | `services/types.ts`, `registry.ts` |
| 04.4 | `lich urls` command | 3 | `commands/urls.ts` |
| 04.5 | Wire portless into `dev` + e2e | 4 | `commands/dev.ts`, tests |
| 04.6 | Wire `urls` into bin + e2e | 5 | `bin.ts`, tests |

Wave 2 is parallel pair. Waves 3, 4, 5 are sequential single.

## New deps

None — shell out to existing `portless` CLI when available; tests stub it.

## Out of scope

- portless install/bootstrap (assume user has it OR fallback to plain URLs).
- HTTPS cert provisioning (portless handles).
- Per-app custom domains beyond `<branch>.<projectName>.localhost`.

## Verification

- With portless installed: `lich up` registers URLs; `lich urls` lists them; visiting URL hits the right worktree's web service.
- Without portless: `lich up` still works, logs warning, `lich urls` falls back to plain http://localhost:port table.
- Full suite green; tsc clean.
