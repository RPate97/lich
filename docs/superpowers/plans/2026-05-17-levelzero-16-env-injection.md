# Plan 16 — Environment variable injection (EnvSource system)

> **Status: complete** — every Tier ticket (LEV-178 through LEV-192) has shipped to `master`. The plan below remains as the architecture record. The implementation tickets:
>
> - Tier 1 (foundations): [LEV-178](https://linear.app/levelzero/issue/LEV-178), [LEV-179](https://linear.app/levelzero/issue/LEV-179), [LEV-180](https://linear.app/levelzero/issue/LEV-180)
> - Tier 2 (resolution + injection): [LEV-181](https://linear.app/levelzero/issue/LEV-181), [LEV-182](https://linear.app/levelzero/issue/LEV-182), [LEV-183](https://linear.app/levelzero/issue/LEV-183), [LEV-184](https://linear.app/levelzero/issue/LEV-184)
> - Tier 3 (backcompat + v0 plugin migration): [LEV-185](https://linear.app/levelzero/issue/LEV-185), [LEV-186](https://linear.app/levelzero/issue/LEV-186), [LEV-187](https://linear.app/levelzero/issue/LEV-187)
> - Tier 4 (new plugins): [LEV-188](https://linear.app/levelzero/issue/LEV-188) dotenv, [LEV-189](https://linear.app/levelzero/issue/LEV-189) infisical, [LEV-190](https://linear.app/levelzero/issue/LEV-190) redis, [LEV-191](https://linear.app/levelzero/issue/LEV-191) kafka
> - Tier 5 (docs): [LEV-192](https://linear.app/levelzero/issue/LEV-192) — the EnvSource chapter in `docs/plugin-author-guide.md` and reference updates in `docs/EXTENSION.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement each Tier task-by-task. The Linear tickets (LEV-178 … LEV-192) carry the code-level detail; this doc captures architecture and decomposition.

**Goal:** Replace the ad-hoc `envContributions(ports)` system with a declarative, explicit, fully-typed `EnvSource` mechanism that injects environment variables into both compose-managed services and host-spawned owned services, while supporting bulk-loader plugins for secrets (dotenv, Infisical) and arbitrary new protocols (Kafka, Redis, MQTT, …).

**Architecture:** Plugins register either *named EnvSources* (one value addressable by name, e.g. `postgres.url`) or *bulk EnvSources* (a resolver returning many values at once, e.g. all Infisical secrets in a folder). The consumer's `levelzero.config.ts` declares an explicit `envInjection` map: `{ ENV_VAR_NAME: 'namespace.source' }` plus an `importAll: ['namespace', …]` array for bulk pass-through. TypeScript infers the available source keys from the plugin tuple, giving autocomplete and typo errors at the config level.

**Tech Stack:** TypeScript (strict generics, template-literal types, factory functions), Bun/Turborepo workspace, Docker Compose for service env injection, existing `@levelzero/core` plugin loader.

---

## Why now

Plan 14 split levelzero into core + plugin packages along slot boundaries. The current env-injection surface was inherited unchanged from the pre-plugin era and has four real holes:

1. **Compose services don't get the merged env.** Only owned services (host-spawned, e.g. `next dev`) receive it. The `api` container running inside compose doesn't get `DATABASE_URL` — pre-existing bug.
2. **Host-side URLs only.** Everything is `localhost:${port}`. Containers can't reach each other using the same env vars the host sees; they need `postgres:5432` (compose DNS) or the docker bridge IP.
3. **No naming flexibility.** Postgres hardcodes the key `DATABASE_URL`. If your consumer wants `PRIMARY_DB_URL` or `ORDERS_POSTGRES_URL`, you fork the plugin.
4. **No support for secret-source plugins.** A real project (think: any company with Infisical/Doppler/Vault) needs to load runtime secrets from an external store. The current `envContributions(ports)` shape is service-and-port-coupled — it can't model "fetch all keys from this Infisical folder."

This plan fixes all four with one unified primitive.

## Composability alignment

This plan is the second pillar (alongside Plan 15) of the broader plugin composability thesis recorded in `docs/EXTENSION.md` and the Plan 14 doc's "Composability principle" section: **plugins compose through contracts, not through each other's implementations**. EnvSource is the contract by which any plugin can publish values that any other plugin (or service) can consume, without either side knowing the other exists.

---

## Architecture

### Two contribution shapes

**Named EnvSource** — for specific known values (a service URL, a single curated secret):
```ts
api.addEnvSource('url', {
  host:      ({ ports }) => `postgres://u:p@localhost:${ports.postgres}/db`,
  container: ()          => `postgres://u:p@postgres:5432/db`,
  protocol:  'postgres',
});
```

The plugin registers under a name relative to its own namespace (`'url'`, not `'postgres.url'`). The framework composes the fully-qualified key (`postgres.url`) using the plugin's declared namespace.

**Bulk EnvSource** — for whatever-you-find collections (dotenv, Infisical, AWS Secrets Manager):
```ts
api.addBulkEnvSource({
  resolve: async () => {
    const all = await infisicalClient.getSecrets({ folder, environment });
    return Object.fromEntries(all.map(s => [s.key, s.value]));
  },
});
```

The bulk source's keys ARE the env var names. No mapping at the source level; the consumer can override individual names via explicit `envInjection` entries when needed.

### Plugin factory pattern + typing

Plugins become callable factories that return a `Plugin<NS, S>` where `NS` is the namespace string literal and `S` is the source manifest:

```ts
export default function postgres(opts?: PostgresOptions): Plugin<'postgres', {
  named: 'url' | 'host' | 'port' | 'database' | 'driver';
  bulk:  never;
}> {
  return {
    name:      '@levelzero/plugin-postgres',
    namespace: 'postgres',
    version:   '0.1.0',
    register(api) {
      api.addEnvSource('url',      { host: ..., container: ... });
      api.addEnvSource('host',     { host: ..., container: ... });
      api.addEnvSource('port',     { host: ..., container: ... });
      api.addEnvSource('database', { host: ..., container: ... });
      api.addEnvSource('driver',   { host: () => 'postgresql', container: () => 'postgresql' });
    },
  };
}
```

A `defineConfig()` helper flows the plugin tuple types through to `envInjection` for autocomplete and typo errors:

```ts
import { defineConfig } from '@levelzero/core';
import postgres from '@levelzero/plugin-postgres';
import infisical from '@levelzero/plugin-infisical';

export default defineConfig({
  plugins: [postgres(), infisical({ environment: 'test', folder: '/proj/dev', tokenFromEnv: 'INFISICAL_TOKEN' })],
  envInjection: {
    'DATABASE_URL': 'postgres.url',    // ✓ autocompleted
    'STRIPE_API_KEY': 'infisical.STRIPE_API_KEY',  // ✓ if bulk source includes it
    importAll: ['infisical'],          // ✓ everything else from infisical
  },
});
```

### Consumer config rules

1. **Explicit entries always win** over `importAll`. If both produce the same name, the explicit one is used.
2. **Empty `envInjection` = nothing injected.** No magic `auto: '*'` knob. Want everything? Write it.
3. **Bulk-source collisions** between two `importAll` entries (e.g. dotenv and infisical both define `STRIPE_API_KEY`) follow plugin-load order — last wins. The validator emits a warning.
4. **Missing references fail fast at boot.** If `envInjection` references `stripe.api_key` and no source provides it: `ENV_SOURCE_MISSING: ... did you forget to load @my-org/plugin-infisical?`

### Host vs container resolution

At injection time, the runtime knows whether the consumer is:
- A **compose-managed service** (writes to compose `environment:` block) — uses `container()` resolver
- A **host-spawned owned service** (Next dev, etc.) — uses `host()` resolver

Bulk sources have no host/container distinction by default (a secret is the same value either way); the `resolve()` return value is used verbatim. A bulk source can opt into context-aware resolution by returning a `Record<string, { host: string; container: string }>` instead of `Record<string, string>` — rare.

### Worktree safety

Secret-source plugins (dotenv, Infisical, etc.) resolve from `ctx.projectRoot`, NOT the worktree path. This is consistent with how every other plugin reads config today: a `.env.local` in the main workspace is read by every worktree's `levelzero dev`; Infisical config (machine identity token, folder path) is the same across worktrees. Plugins that need worktree-scoped state (caches, runtime tokens) use `ctx.worktreeKey` to scope under `.levelzero/state/<worktreeKey>/`.

### Generated .env files

For each running service the runtime writes a `.env.<service>` file to `.levelzero/state/<worktreeKey>/env/`. These are:
- **Inspectable** — `cat .levelzero/state/.../env/api.env` shows exactly what the api service received.
- **Debuggable** — `levelzero env resolve api` regenerates and prints the same content.
- **Portable** — same contract that CI/staging/prod env loaders use; the file can be source'd by anything that reads `.env`.

### Scoping (deferred to Plan 17 or later)

Today every service gets every env var. For 90% of projects this is fine. Microservice architectures will eventually want per-service `from:` / `exclude:` allowlists; we explicitly defer that until someone hits the pain.

---

## What lives where after the work

### `@levelzero/core` adds

- `packages/core/src/env/types.ts` — `EnvSource`, `BulkEnvSource`, `EnvSourceContext`, `EnvInjectionConfig`
- `packages/core/src/env/registry.ts` — `EnvSourceRegistry`, namespace-scoped views
- `packages/core/src/env/resolve.ts` — boot-time resolution + validation
- `packages/core/src/env/inject.ts` — per-service injection (compose + owned), file writers
- `packages/core/src/define-config.ts` — `defineConfig()` helper with type inference
- `packages/core/src/commands/env.ts` — `env list`, `env resolve <service>`
- `packages/core/src/plugins/types.ts` — `Plugin<NS, S>`, `PluginAPI<NS>` namespace scoping, `addEnvSource` / `addBulkEnvSource`

### Plugin packages (refactored)

Each v0 plugin (`postgres`, `prisma`, `hono`, `typed-client`, `better-auth`, `shadcn`, `next`, `vitest`, `playwright`, `portless`) gets converted to a factory exporting `Plugin<NS, S>` with explicit namespace and source manifest. Existing `envContributions(ports)` calls are replaced with `api.addEnvSource(...)` calls (with a backwards-compat shim during the transition).

### New plugin packages

- `@levelzero/plugin-dotenv` — bulk source from `.env.local` + optional `process.env` passthrough
- `@levelzero/plugin-infisical` — bulk source from Infisical SDK (configurable environment, folder, token source)
- `@levelzero/plugin-redis` — promoted from `examples/plugin-redis/` to a real workspace package; exercises non-HTTP/non-postgres protocol (Redis URL)
- `@levelzero/plugin-kafka` — non-HTTP, non-URL connection-string protocol (bootstrap list); proves protocol opacity

---

## Task list (5 tiers, 15 tickets)

### Tier 1 — Foundations (core types, no behavior change yet)

- **LEV-178** Task 16.1 — `EnvSource` + `BulkEnvSource` types + namespace-scoped `PluginAPI<NS>`
- **LEV-179** Task 16.2 — `Plugin<NS, S>` generic typing + factory pattern + backwards-compat loader
- **LEV-180** Task 16.3 — `defineConfig()` helper with `envInjection` type inference

### Tier 2 — Resolution + injection (wire it through to running services)

- **LEV-181** Task 16.4 — Boot-time resolution (named + bulk), validation, collision detection
- **LEV-182** Task 16.5 — Host vs container resolution + compose env injection (fixes existing bug)
- **LEV-183** Task 16.6 — Generated `.env.<service>` files under `.levelzero/state/<worktree>/env/`
- **LEV-184** Task 16.7 — `levelzero env list` + `env resolve <service>` debug commands

### Tier 3 — Backwards compat + v0 plugin migration

- **LEV-185** Task 16.8 — Backwards-compat shim: auto-promote existing `envContributions(ports)` to EnvSources
- **LEV-186** Task 16.9 — Convert all v0 plugins to factories with namespaces (postgres, prisma, hono, typed-client, better-auth, shadcn, next, vitest, playwright, portless)
- **LEV-187** Task 16.10 — Migrate each v0 plugin's `envContributions` to explicit `addEnvSource` calls; remove the shim usage

### Tier 4 — New plugins exercising the design

- **LEV-188** Task 16.11 — `@levelzero/plugin-dotenv` (bulk source from .env files + process.env)
- **LEV-189** Task 16.12 — `@levelzero/plugin-infisical` (bulk source from Infisical SDK)
- **LEV-190** Task 16.13 — `@levelzero/plugin-redis` (promote from examples/, non-postgres protocol)
- **LEV-191** Task 16.14 — `@levelzero/plugin-kafka` (non-URL connection-string protocol)

### Tier 5 — Documentation

- **LEV-192** Task 16.15 — Plugin author guide chapter on EnvSource + worktree-safe secret plugins

---

## Cross-plan dependencies

- **Blocks** Plan 15 child tickets that need to consume EnvSources:
  - LEV-171 (plugin-prisma consumes DatabaseProvider) — rewrite to consume `postgres.*` EnvSources via the Plan 16 context API
  - LEV-172 (resetDatabase inside ORM) — dispatch on `postgres.driver` EnvSource value
  - LEV-173 (plugin-better-auth consumes active ORM) — auth context gets ORM lookup AND EnvSource lookup

  LEV-170 (DatabaseProvider capability) is **superseded** by the EnvSource model — its work folds into LEV-178/186. Will close LEV-170 as duplicate of LEV-178 with a note.

- **Blocks** Plan 14 Tier 7 (LEV-165 cut-the-seam, LEV-166 final smoke test) — env injection should land before the final cutover so the smoke test can validate it end-to-end.

- **Independent of** the other Plan 14 Tier 6 work (LEV-157 template move, LEV-158 generated config, LEV-159 create-stack-v0, LEV-160 init decision). Tier 6 should reference Plan 16 plugin names in the generated config.

---

## Out of scope

- **Per-service env scoping** (`only`, `exclude` per service) — defer to Plan 17 if anyone hits the pain. Today's "every var to every service" default works for the v0 stack and any project under ~20 services.
- **Refresh / TTL on bulk sources** — first version re-resolves at every boot. Long-running `dev` sessions won't pick up new Infisical values without a restart. Acceptable for dev tool.
- **Encryption at rest** of generated `.env.<service>` files — they're in `.levelzero/state/` which we already document as gitignored. If someone needs sealed secrets in dev they have bigger problems.
- **Custom resolution context** (e.g. "this env should resolve differently in CI vs local") — the host/container distinction covers the actual dev-tool need. CI parity comes for free because the generated `.env.<service>` files are portable.

---

## Verification

Each tier ends with verification that the previous behavior still works:

- **Tier 1**: Types compile across all packages. No runtime change yet.
- **Tier 2**: `levelzero dev` brings up the v0 stack with env injection into both compose AND owned services. Manual: `cat .levelzero/state/.../env/api.env` shows expected vars.
- **Tier 3**: All existing plugin tests still pass. Backwards-compat shim emits deprecation warning on console for any plugin still using `envContributions(ports)`.
- **Tier 4**: New plugins' own tests pass. End-to-end smoke: a project with `plugin-dotenv + plugin-infisical + plugin-postgres + plugin-prisma + plugin-hono` boots, fetches Infisical secrets, makes them available to the api service.
- **Tier 5**: Docs link from the existing EXTENSION.md "Composability rule" callout to the new EnvSource chapter.

A new test (parallel to the LEV-175 cross-plugin-import lint) verifies that no plugin imports `process.env` directly from inside its source — all env access goes through the EnvSource contract.
