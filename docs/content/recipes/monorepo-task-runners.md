# Monorepo workspace tooling (turbo / nx / lage / wireit)

**When to use this:** the repo uses pnpm/yarn workspaces with an internal package graph — `apps/server` depends on `packages/db` and `packages/shared`, all built from source. The naive `pnpm run dev` inside `apps/server/` runs only that package's `dev` script and skips the dep graph; you'll get stale builds or missing-export errors at runtime.

The fix is to run the workspace task runner (turbo / nx / lage / wireit) from the repo root with a filter, so it knows to build dependencies first.

```yaml
owned:
  server:
    # WRONG: builds only apps/server's TS, not the @packages/* it depends on.
    # cmd: pnpm run dev
    # cwd: apps/server

    # RIGHT: turbo orchestrates the build graph across workspace deps,
    # then runs the `dev` script in apps/server with everything pre-built.
    cmd: pnpm exec turbo run dev --filter=server --env-mode=loose
    cwd: .
    port: { env: PORT }
    ready_when:
      http_get: /health
```

The `pnpm exec` prefix is also load-bearing: `cmd:` invocations don't necessarily have `node_modules/.bin` on `PATH`, so a bare `turbo run dev` may not resolve to the workspace-local `turbo` binary. Use `pnpm exec` (or `yarn run` / `npm exec`) to route through the package manager, which sets up `PATH` correctly. (LEV-498 is in flight to auto-prepend `node_modules/.bin` for `cmd:` invocations; until that ships, the `pnpm exec` workaround is the recipe.)

Equivalent shapes for the other workspace runners:

- **nx:** `cmd: pnpm exec nx run server:dev`
- **lage:** `cmd: pnpm exec lage dev --scope server`
- **wireit:** `cmd: pnpm exec wireit` (in the app's `cwd:`, with wireit deps wired in `package.json`)

**Common mistake:** setting `cwd: apps/server` + `cmd: pnpm run dev` because that's what the README says — locally a developer runs it from the app dir after a manual `pnpm -w build` to seed `dist/`. Lich doesn't know about that prior build; cold starts hit "Cannot find module '@packages/db'" because nothing built it.
