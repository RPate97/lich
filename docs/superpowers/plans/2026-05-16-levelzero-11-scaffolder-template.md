# Plan 11 — Scaffolder (`init`) + the starter template

**Goal:** Extend `lich init` (from plan 01, currently writes a stub `lich.config.ts`) into a full project generator. Output: a complete working monorepo with Hono api, Next web, Prisma schema, Better Auth wired, base e2e tests, CLAUDE.md, the full skill set. Adds `getBuiltinServices()` real definitions so `lich up` brings up `api` + `web` + `postgres`.

**Architecture:**
- Template lives in `tools/cli/templates/v0-stack/` as a tree of static files (with `__placeholder__` markers swapped at copy time).
- `init <name>` (new positional arg) creates `./<name>/`, copies the template, replaces placeholders (project name, default ports etc.), runs `bun install`, prints a "next steps" message.
- `services/builtins.ts` gains real entries for `api` (Hono) and `web` (Next), both `kind: 'owned'` with `command: 'bun run dev'`, `cwd: 'apps/api'`/`apps/web'`, `dependsOn: ['postgres']`, `envContributions`/`portNames`.
- A `lich curl --as <user>` command lands here (was deferred from plan 06) since it needs a real api.

**Files:**
```
tools/cli/
  templates/
    v0-stack/                   # full monorepo template
      package.json
      bun.lock
      turbo.json
      tsconfig.json
      lich.config.ts
      CLAUDE.md
      apps/
        api/
          package.json
          src/
            index.ts            # Hono app
            routes/
              auth.ts
              health.ts
        web/
          package.json
          next.config.js
          src/
            app/
              layout.tsx
              page.tsx
      packages/
        api-client/             # placeholder; populated by `gen client`
        ui/                     # shadcn host
      prisma/
        schema.prisma
        seed.ts
      .lich/
        skills/                 # placeholder; populated by plan 12
  src/
    commands/
      init.ts                   # MODIFY: template copy + placeholder substitution
      curl.ts                   # NEW: lich curl --as <user>
    services/
      builtins.ts               # MODIFY: real api + web service definitions
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 11.1 | Template directory tree + placeholder substitution helper | 1 | `templates/v0-stack/**`, `src/scaffolder.ts` |
| 11.2 | Extend `init` to copy template + substitute + bun install | 2 | `commands/init.ts` |
| 11.3 | Real `api` and `web` entries in `getBuiltinServices()` | 2 | `services/builtins.ts` |
| 11.4 | `lich curl --as <user>` command (uses auth/helpers from LEV-66) | 3 | `commands/curl.ts` |
| 11.5 | Wire `curl` into bin + e2e | 4 | `bin.ts`, tests |
| 11.6 | Plan-11 e2e: `init my-app && dev && curl --as alice /api/me` | 4 | tests |

Wave 2 is parallel pair. Wave 3 single. Wave 4 is parallel pair.

## New deps

- None for the CLI itself; the template's `package.json` pulls in `hono`, `next`, `react`, `react-dom`, `tailwindcss`, `prisma`, `@prisma/client`, `better-auth`, `shadcn`, etc.

## Out of scope

- Template variants (only v0 stack — Hono+Next+Prisma+BetterAuth+shadcn+Tailwind).
- Interactive prompts (`init <name>` is non-interactive).
- Post-init git init / first commit (user does that).
- Custom port overrides via flags (use lich.config.ts for that).

## Verification

- `lich init demo` produces a working `./demo/` directory.
- `cd demo && lich up` brings up postgres + api + web.
- `lich curl --as alice@example.com /api/me` returns alice's session JSON.
- `lich db migrate && lich db seed` work in the scaffolded project.
- `lich ui add button` succeeds in `apps/web`.
- Full suite green; tsc clean.
