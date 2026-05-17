# Plan 09 — Codegen (api-client) + Hono adapter

**Goal:** Define `FrontendAdapter` interface and `BackendAdapter` interface (Hono impl). Ship `levelzero gen client` to regenerate `packages/api-client` from the live Hono app's route manifest. Enable the real `route-coverage` check rule from plan 08.

**Architecture:**
- `BackendAdapter.extractRoutes(projectRoot) → RouteManifest`: Hono impl uses `hono`'s `app.routes` reflection (or a tiny runtime helper) to enumerate path + method + handler types.
- `FrontendAdapter.generateClient({ routes, outDir }) → Promise<void>`: writes a typed client (one function per route) using the route manifest. v0 emits a single `index.ts` with strict path/method/body types from the Hono schemas.
- `levelzero gen client` resolves stack context, finds the api project, calls `backendAdapter.extractRoutes`, pipes to `frontendAdapter.generateClient`, writes to `packages/api-client/src/index.ts`.
- The plan 08 `route-coverage` stub rule becomes real: it reads the manifest from `backendAdapter.extractRoutes` and verifies each route has a corresponding integration test (by grep / static analysis).

**Files:**
```
tools/cli/src/
  adapters/
    backend/
      types.ts                  # BackendAdapter, RouteManifest
      hono.ts                   # Hono route extraction
    frontend/
      types.ts                  # FrontendAdapter
      typed-client.ts           # default codegen impl
  commands/
    gen/
      client.ts                 # levelzero gen client
  check/
    rules/
      route-coverage.ts         # REPLACE plan-08 stub with real impl
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 09.1 | BackendAdapter interface + RouteManifest shape | 1 | `adapters/backend/types.ts` |
| 09.2 | FrontendAdapter interface | 1 | `adapters/frontend/types.ts` |
| 09.3 | Hono BackendAdapter impl (route reflection) | 2 | `adapters/backend/hono.ts` |
| 09.4 | typed-client FrontendAdapter impl (codegen) | 2 | `adapters/frontend/typed-client.ts` |
| 09.5 | `levelzero gen client` command | 3 | `commands/gen/client.ts` |
| 09.6 | Promote `route-coverage` stub rule to real impl | 3 | `check/rules/route-coverage.ts` |
| 09.7 | Wire `gen.client` into bin + e2e | 4 | `bin.ts`, tests |

Wave 1 + 2 are parallel pairs. Wave 3 is parallel pair.

## New deps

- `hono` (latest) — runtime dependency of the api project; the adapter imports it to extract routes.

## Out of scope

- Real-time codegen (file-watcher-driven) — manual `gen client` only in v0.
- Multi-language client codegen (TS only).
- OpenAPI spec emission (could be a future adapter slot).
- Custom path templating beyond Hono's defaults.

## Verification

- `levelzero gen client` in a project with a Hono api writes `packages/api-client/src/index.ts` exposing typed functions.
- The web frontend imports those functions; tsc resolves the types correctly.
- `levelzero check` now reports route-coverage status (not just `skip`).
- Full suite green; tsc clean.
