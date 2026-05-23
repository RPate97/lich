> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../../specs/2026-05-23-lich-v1-design.md` for the current spec and `../../plans/2026-05-23-lich-v1-plan-0-foundation.md` for the current plan. See `./README.md` in this directory for context.

---

# Plan 13 — Adapter swap CLI + extensibility surface polish

**Goal:** Add `lich adapter list` and `lich adapter swap <slot> <impl>` commands. Ensure all extension points (Service contract, adapter registration, command plugin surface, check-rule registration, skill discovery) are driveable from `lich.config.ts` and project-local plugin paths. Document the extension surface (lightly — this is v0).

**Architecture:**
- `AdapterRegistry`: a single source of truth for available implementations per slot (orm, auth, ui, browser, backend, frontend, test-runner, portless).
- `lich.config.ts` honors `adapters: { orm: 'prisma', auth: 'better-auth', ... }` to declare which impl each slot uses.
- `lich adapter list` prints the registry (slots + impls + which is active).
- `lich adapter swap orm prisma` mutates lich.config.ts (or a sibling `.lich/adapter.json`) and re-resolves.
- All commands that consume an adapter (db, auth, ui, screenshot, gen client, test, etc.) lookup via the registry rather than importing impls directly.
- Project-local plugin paths: if `lich.config.ts` exports an `adapters: { custom: { redis: './local-plugins/redis-adapter.ts' } }`, the registry loads them dynamically.

**Files:**
```
tools/cli/src/
  adapters/
    registry.ts                 # NEW: AdapterRegistry
  config.ts                     # MODIFY: parse adapters config block
  commands/
    adapter/
      list.ts
      swap.ts
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 13.1 | AdapterRegistry: register + lookup + list | 1 | `adapters/registry.ts` + tests |
| 13.2 | Wire all existing commands to look up via registry (refactor) | 2 | many files; one commit per slot |
| 13.3 | Extend `lich.config.ts` parser with `adapters` block | 2 | `config.ts` |
| 13.4 | `lich adapter list` command | 3 | `commands/adapter/list.ts` |
| 13.5 | `lich adapter swap` command (config mutation) | 3 | `commands/adapter/swap.ts` |
| 13.6 | Project-local plugin loader (`adapters.custom`) | 3 | `adapters/registry.ts` extension |
| 13.7 | Wire `adapter.*` into bin + plan-13 e2e | 4 | `bin.ts`, tests |
| 13.8 | EXTENSION.md doc (one-pager) | 4 | `docs/EXTENSION.md` |

Wave 2 is sequential (refactor by slot). Wave 3 is parallel triple.

## New deps

None.

## Out of scope

- npm-package-distributed plugins (only path-based local plugins in v0).
- A plugin scaffolder (`lich plugin new`).
- Cross-project adapter sharing (each project declares its own).
- Adapter version negotiation / capability discovery — pass through the existing interface only.

## Verification

- `lich adapter list` shows all 8 slots + active impl.
- `lich adapter swap orm <other>` would work if a second ORM impl existed; for v0 only Prisma exists, so a meaningful swap test requires either (a) shipping a stub second impl, or (b) testing via a local plugin.
- Project-local plugin: a tiny `redis-adapter.ts` loaded from `./local-plugins/` is discoverable and listable.
- Full suite green; tsc clean.
- `docs/EXTENSION.md` exists and links to the adapter slot interface files.
