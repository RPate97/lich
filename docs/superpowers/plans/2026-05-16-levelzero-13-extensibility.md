# Plan 13 — Adapter swap CLI + extensibility surface polish

**Goal:** Add `levelzero adapter list` and `levelzero adapter swap <slot> <impl>` commands. Ensure all extension points (Service contract, adapter registration, command plugin surface, check-rule registration, skill discovery) are driveable from `levelzero.config.ts` and project-local plugin paths. Document the extension surface (lightly — this is v0).

**Architecture:**
- `AdapterRegistry`: a single source of truth for available implementations per slot (orm, auth, ui, browser, backend, frontend, test-runner, portless).
- `levelzero.config.ts` honors `adapters: { orm: 'prisma', auth: 'better-auth', ... }` to declare which impl each slot uses.
- `levelzero adapter list` prints the registry (slots + impls + which is active).
- `levelzero adapter swap orm prisma` mutates levelzero.config.ts (or a sibling `.levelzero/adapter.json`) and re-resolves.
- All commands that consume an adapter (db, auth, ui, screenshot, gen client, test, etc.) lookup via the registry rather than importing impls directly.
- Project-local plugin paths: if `levelzero.config.ts` exports an `adapters: { custom: { redis: './local-plugins/redis-adapter.ts' } }`, the registry loads them dynamically.

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
| 13.3 | Extend `levelzero.config.ts` parser with `adapters` block | 2 | `config.ts` |
| 13.4 | `levelzero adapter list` command | 3 | `commands/adapter/list.ts` |
| 13.5 | `levelzero adapter swap` command (config mutation) | 3 | `commands/adapter/swap.ts` |
| 13.6 | Project-local plugin loader (`adapters.custom`) | 3 | `adapters/registry.ts` extension |
| 13.7 | Wire `adapter.*` into bin + plan-13 e2e | 4 | `bin.ts`, tests |
| 13.8 | EXTENSION.md doc (one-pager) | 4 | `docs/EXTENSION.md` |

Wave 2 is sequential (refactor by slot). Wave 3 is parallel triple.

## New deps

None.

## Out of scope

- npm-package-distributed plugins (only path-based local plugins in v0).
- A plugin scaffolder (`levelzero plugin new`).
- Cross-project adapter sharing (each project declares its own).
- Adapter version negotiation / capability discovery — pass through the existing interface only.

## Verification

- `levelzero adapter list` shows all 8 slots + active impl.
- `levelzero adapter swap orm <other>` would work if a second ORM impl existed; for v0 only Prisma exists, so a meaningful swap test requires either (a) shipping a stub second impl, or (b) testing via a local plugin.
- Project-local plugin: a tiny `redis-adapter.ts` loaded from `./local-plugins/` is discoverable and listable.
- Full suite green; tsc clean.
- `docs/EXTENSION.md` exists and links to the adapter slot interface files.
