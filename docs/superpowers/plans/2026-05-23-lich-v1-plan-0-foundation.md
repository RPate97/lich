# Lich v1 — Plan 0: Foundation and Failing Test Case

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md`

**Required reading (for every subagent on every task):** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md` — defines how we test lich v1. Specifically: every feature needs BOTH unit tests AND e2e tests that spawn the real binary and assert observable behavior against the dogfood stack. The standards doc is not optional; read it before starting any task in this plan or any subsequent plan.

**Goal:** Lay the foundation for lich v1 implementation: the `packages/lich/` skeleton, the `examples/dogfood-stack/` failing test case (Next + Express + Supabase + migrations + seed), and the `tests/e2e/` infrastructure that drives lich against the stack. After this plan, every e2e test fails (lich is a stub), and subsequent plans add functionality to turn tests green tier by tier.

**Architecture:** Single TypeScript package (`packages/lich/`) compiled to a single binary via `bun build --compile`. A real full-stack example app at `examples/dogfood-stack/` works end-to-end via bash today (no lich involved). The `lich.yaml` committed alongside it describes what we want lich to handle — the failing test target. E2e tests at `tests/e2e/` copy the example to a tmpdir, build and spawn the lich binary, and assert behavior. All tests fail at end of this plan; subsequent plans turn them green.

**Tech Stack:** TypeScript on Bun, vitest for testing, mri for CLI argument parsing, yaml + ajv for config (later plans), docker compose, Supabase CLI, Next.js, Express.

**Prerequisites (verify before starting):**
- Bun ≥ 1.1 installed (`bun --version`)
- Docker running (`docker info`)
- Supabase CLI installed (`supabase --version`) — install via `brew install supabase/tap/supabase` or equivalent
- Git installed (`git --version`)

**Roadmap (subsequent plans — written when ready to execute each):**
- **Plan 1: Core engine** — config parsing + schema validation, worktree detection, port allocator, compose runner (CLI-agnostic), owned service runner with concurrently, env basics, basic `ready_when` (http_get + tcp + log_match), basic CLI surface
- **Plan 2: Extension surfaces** — `env_groups` with extends, user-defined `commands`, `lich help` / `lich exec` / `lich env`
- **Plan 3: Profiles** — profile resolution with extends, profile-scoped env, profile-scoped lifecycle
- **Plan 4: Failure surfacing + capture** — `fail_when`, `ready_when.timeout`, `ready_when.capture`, automatic exit detection, failure UX in CLI
- **Plan 5: Daemon and dashboard** — daemon process (dashboard + reverse proxy + state watcher), friendly URLs via `*.lich.localhost`, port the dashboard UI from `packages/dashboard/`, write new backend
- **Plan 6: Onramp + cleanup** — `lich:instrument` agent skill, README, delete `packages/core/`, all `plugin-*` packages, `template-v0-stack`, `create-stack-v0`, old `packages/dashboard/`

---

## File Structure (created in this plan)

```
packages/lich/                          # the new v1 codebase
├── package.json                        # bun + deps
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── src/
│   ├── bin/
│   │   └── lich.ts                     # CLI entry; routes to subcommand stubs
│   └── version.ts                      # exports VERSION constant
└── tests/
    └── unit/
        └── smoke.test.ts               # imports the CLI, asserts basic shape

examples/dogfood-stack/                 # the failing test case (real app)
├── package.json                        # workspace root for the example
├── .gitignore
├── README.md                           # how to run by hand (pre-lich)
├── lich.yaml                           # target config — what lich must handle
├── apps/
│   ├── web/                            # Next.js (created with create-next-app)
│   │   ├── package.json
│   │   ├── next.config.js
│   │   ├── tsconfig.json
│   │   └── app/
│   │       └── page.tsx                # lists "things" from API
│   └── api/                            # Express
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                # Express server + /health + /api/things
│           └── db.ts                   # Supabase client
└── supabase/                           # Supabase CLI scaffolded
    ├── config.toml                     # ports use env() refs
    ├── migrations/
    │   └── 20260523000000_create_things.sql
    └── seed.sql                        # rows for "things"

tests/                                  # top-level e2e tests
└── e2e/
    ├── vitest.config.ts                # separate config; longer timeouts
    ├── helpers/
    │   ├── tmpdir.ts                   # copy example to tmpdir
    │   ├── lich.ts                     # spawn the lich binary
    │   └── wait.ts                     # wait helpers (port open, http 200)
    └── basic-up.test.ts                # first failing test
```

**Files NOT touched in this plan (cleanup is Plan 6):**
- `packages/core/`, `packages/dashboard/`, all `packages/plugin-*`, `packages/template-v0-stack/`, `packages/create-stack-v0/`

---

## Task 1: Create `packages/lich/` skeleton

**Files:**
- Create: `packages/lich/package.json`
- Create: `packages/lich/tsconfig.json`
- Create: `packages/lich/.gitignore`

- [ ] **Step 1: Create the package directory structure**

```bash
mkdir -p packages/lich/src/bin packages/lich/tests/unit
```

- [ ] **Step 2: Write `packages/lich/package.json`**

```json
{
  "name": "@lich/lich",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": {
    "lich": "./dist/lich"
  },
  "scripts": {
    "build": "bun build --compile --target=bun --outfile=dist/lich src/bin/lich.ts",
    "dev": "bun run src/bin/lich.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  },
  "dependencies": {
    "mri": "^1.2.0"
  }
}
```

- [ ] **Step 3: Write `packages/lich/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowJs": false,
    "noEmit": true,
    "types": ["bun-types"],
    "lib": ["ESNext"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 4: Write `packages/lich/.gitignore`**

```
dist/
node_modules/
.lich/
*.log
```

- [ ] **Step 5: Install deps and verify tsconfig parses**

Run:
```bash
cd packages/lich && bun install && bunx tsc --noEmit
```

Expected: no errors. (Empty `src/` is fine for tsc; it'll just compile nothing.)

- [ ] **Step 6: Commit**

```bash
git add packages/lich/
git commit -m "chore(lich): scaffold packages/lich/ skeleton"
```

---

## Task 2: CLI entry point that prints version

**Files:**
- Create: `packages/lich/src/version.ts`
- Create: `packages/lich/src/bin/lich.ts`

- [ ] **Step 1: Write `packages/lich/src/version.ts`**

```typescript
export const VERSION = "0.0.1";
```

- [ ] **Step 2: Write `packages/lich/src/bin/lich.ts` with minimal version handling**

```typescript
#!/usr/bin/env bun
import { VERSION } from "../version.js";

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
  console.log(`lich ${VERSION}`);
  process.exit(0);
}

console.log(`lich ${VERSION} — not yet implemented`);
console.log(`Run 'lich --help' to see available commands.`);
process.exit(0);
```

- [ ] **Step 3: Run the CLI via Bun**

Run:
```bash
cd packages/lich && bun run src/bin/lich.ts --version
```

Expected: `lich 0.0.1`

- [ ] **Step 4: Commit**

```bash
git add packages/lich/src/
git commit -m "feat(lich): CLI entry point prints version"
```

---

## Task 3: Subcommand router with stub handlers

**Files:**
- Modify: `packages/lich/src/bin/lich.ts`
- Create: `packages/lich/src/commands/index.ts`

- [ ] **Step 1: Write `packages/lich/src/commands/index.ts` with stubs**

```typescript
type StubResult = { ok: boolean; message: string };

function stub(name: string): () => StubResult {
  return () => ({ ok: false, message: `'lich ${name}' is not yet implemented` });
}

export const COMMANDS = {
  up: stub("up"),
  down: stub("down"),
  logs: stub("logs"),
  urls: stub("urls"),
  stacks: stub("stacks"),
  restart: stub("restart"),
  nuke: stub("nuke"),
  init: stub("init"),
  validate: stub("validate"),
  help: stub("help"),
  exec: stub("exec"),
  env: stub("env"),
} as const;

export type CommandName = keyof typeof COMMANDS;

export function isCommand(name: string): name is CommandName {
  return name in COMMANDS;
}
```

- [ ] **Step 2: Rewrite `packages/lich/src/bin/lich.ts` to route via mri**

```typescript
#!/usr/bin/env bun
import mri from "mri";
import { VERSION } from "../version.js";
import { COMMANDS, isCommand } from "../commands/index.js";

const argv = mri(process.argv.slice(2), {
  alias: { v: "version", h: "help" },
  boolean: ["version", "help"],
});

if (argv.version) {
  console.log(`lich ${VERSION}`);
  process.exit(0);
}

const [commandName, ...rest] = argv._;

if (!commandName || argv.help) {
  console.log(`lich ${VERSION}`);
  console.log(`Usage: lich <command> [args]`);
  console.log(`Commands: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(0);
}

if (!isCommand(commandName)) {
  console.error(`lich: unknown command '${commandName}'`);
  console.error(`Run 'lich --help' to see available commands.`);
  process.exit(2);
}

const result = COMMANDS[commandName]();
console.log(result.message);
process.exit(result.ok ? 0 : 1);
```

- [ ] **Step 3: Verify each subcommand prints its stub message**

Run each and check:
```bash
cd packages/lich
bun run src/bin/lich.ts up        # expect: "'lich up' is not yet implemented"; exit 1
bun run src/bin/lich.ts down      # expect: "'lich down' is not yet implemented"; exit 1
bun run src/bin/lich.ts unknown   # expect: "unknown command 'unknown'"; exit 2
bun run src/bin/lich.ts --help    # expect: usage + command list; exit 0
echo "exit: $?"
```

- [ ] **Step 4: Commit**

```bash
git add packages/lich/src/
git commit -m "feat(lich): subcommand router with stub handlers"
```

---

## Task 4: Build script produces a compiled binary

**Files:**
- Modify: `packages/lich/package.json` (already has build script from Task 1)

- [ ] **Step 1: Run the build**

```bash
cd packages/lich && bun run build
```

Expected: produces `packages/lich/dist/lich` binary, no errors.

- [ ] **Step 2: Run the compiled binary**

```bash
./packages/lich/dist/lich --version
```

Expected: `lich 0.0.1`

- [ ] **Step 3: Run a stub subcommand via the binary**

```bash
./packages/lich/dist/lich up
echo "exit: $?"
```

Expected: `'lich up' is not yet implemented` ; `exit: 1`

- [ ] **Step 4: Commit (no source changes; verify dist/ is gitignored)**

```bash
git status packages/lich/dist  # should show nothing — dist/ is in .gitignore
```

If `dist/` shows up, ensure it's in `packages/lich/.gitignore`. No commit needed if there are no changes to source.

---

## Task 5: Vitest setup for unit tests

**Files:**
- Create: `packages/lich/vitest.config.ts`
- Create: `packages/lich/tests/unit/smoke.test.ts`

- [ ] **Step 1: Write `packages/lich/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: Write `packages/lich/tests/unit/smoke.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { VERSION } from "../../src/version.js";
import { COMMANDS, isCommand } from "../../src/commands/index.js";

describe("smoke", () => {
  it("exports a VERSION string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("declares the expected command names", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "down",
        "env",
        "exec",
        "help",
        "init",
        "logs",
        "nuke",
        "restart",
        "stacks",
        "up",
        "urls",
        "validate",
      ].sort()
    );
  });

  it("isCommand returns true for known and false for unknown", () => {
    expect(isCommand("up")).toBe(true);
    expect(isCommand("nope")).toBe(false);
  });

  it("every command stub returns not-yet-implemented", () => {
    for (const [name, fn] of Object.entries(COMMANDS)) {
      const result = fn();
      expect(result.ok).toBe(false);
      expect(result.message).toContain(name);
    }
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
cd packages/lich && bun test
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/lich/vitest.config.ts packages/lich/tests/
git commit -m "test(lich): vitest setup + smoke tests for CLI shape"
```

---

## Task 6: Create `examples/dogfood-stack/` workspace root

**Files:**
- Create: `examples/dogfood-stack/package.json`
- Create: `examples/dogfood-stack/.gitignore`
- Create: `examples/dogfood-stack/README.md`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p examples/dogfood-stack/apps/web examples/dogfood-stack/apps/api/src
```

- [ ] **Step 2: Write `examples/dogfood-stack/package.json`**

```json
{
  "name": "lich-dogfood-stack",
  "version": "0.0.1",
  "private": true,
  "workspaces": ["apps/*"],
  "scripts": {
    "dev:web": "cd apps/web && bun run dev",
    "dev:api": "cd apps/api && bun run dev",
    "migrate": "supabase migration up",
    "seed": "psql \"$DATABASE_URL\" -f supabase/seed.sql"
  }
}
```

- [ ] **Step 3: Write `examples/dogfood-stack/.gitignore`**

```
node_modules/
.next/
dist/
.lich/
.env.local
supabase/.branches/
supabase/.temp/
*.log
```

- [ ] **Step 4: Write `examples/dogfood-stack/README.md`**

```markdown
# Lich Dogfood Stack

A real Next + Express + Supabase application used as lich's failing test case.

## Stack
- **Web (Next.js):** `apps/web/` — page that lists "things"
- **API (Express):** `apps/api/` — `/api/things` reads from Supabase
- **DB (Supabase):** `supabase/` — Postgres + auth + storage via Supabase CLI

## Running by hand (without lich)

```bash
# 1. Install deps
bun install

# 2. Start Supabase (will allocate its own ports by default)
supabase start

# 3. Run migrations + seed
bun run migrate
bun run seed

# 4. Start API and web in separate terminals
bun run dev:api
bun run dev:web

# 5. Open http://localhost:3000
```

## Running with lich

```bash
lich up
```

See `lich.yaml` for the configuration.
```

- [ ] **Step 5: Commit**

```bash
git add examples/dogfood-stack/
git commit -m "feat(dogfood): workspace skeleton for the failing-test-case stack"
```

---

## Task 7: Scaffold the Next.js web app

**Files:**
- Create: `examples/dogfood-stack/apps/web/package.json`
- Create: `examples/dogfood-stack/apps/web/tsconfig.json`
- Create: `examples/dogfood-stack/apps/web/next.config.js`
- Create: `examples/dogfood-stack/apps/web/app/layout.tsx`
- Create: `examples/dogfood-stack/apps/web/app/page.tsx`

- [ ] **Step 1: Write `apps/web/package.json`**

```json
{
  "name": "dogfood-web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev -p ${PORT:-3000}",
    "build": "next build",
    "start": "next start -p ${PORT:-3000}"
  },
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Write `apps/web/next.config.js`**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    API_URL: process.env.API_URL || "http://localhost:4000",
  },
};

module.exports = nextConfig;
```

- [ ] **Step 4: Write `apps/web/app/layout.tsx`**

```typescript
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Write `apps/web/app/page.tsx`**

```typescript
async function getThings(): Promise<{ id: number; name: string }[]> {
  const apiUrl = process.env.API_URL || "http://localhost:4000";
  const res = await fetch(`${apiUrl}/api/things`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export default async function Page() {
  const things = await getThings();
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Things from the API</h1>
      <ul>
        {things.map((t) => (
          <li key={t.id}>
            {t.id}: {t.name}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 6: Install deps and verify Next builds**

```bash
cd examples/dogfood-stack && bun install
cd apps/web && bun run build
```

Expected: Next build succeeds (it may warn about API_URL fetch failing at build time — that's expected; we'll use `dynamic` rendering).

If the build fails because of the fetch, add `export const dynamic = "force-dynamic";` to `apps/web/app/page.tsx`.

- [ ] **Step 7: Commit**

```bash
git add examples/dogfood-stack/
git commit -m "feat(dogfood): Next.js web app skeleton"
```

---

## Task 8: Build the Express API

**Files:**
- Create: `examples/dogfood-stack/apps/api/package.json`
- Create: `examples/dogfood-stack/apps/api/tsconfig.json`
- Create: `examples/dogfood-stack/apps/api/src/db.ts`
- Create: `examples/dogfood-stack/apps/api/src/index.ts`

- [ ] **Step 1: Write `apps/api/package.json`**

```json
{
  "name": "dogfood-api",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "build": "bun build --target=bun --outdir=dist src/index.ts",
    "start": "bun src/index.ts"
  },
  "dependencies": {
    "express": "^4.19.0",
    "@supabase/supabase-js": "^2.43.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/node": "^20.12.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `apps/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `apps/api/src/db.ts`**

```typescript
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost:54321";
const key = process.env.SUPABASE_ANON_KEY || "missing-key";

export const supabase = createClient(url, key);
```

- [ ] **Step 4: Write `apps/api/src/index.ts`**

```typescript
import express from "express";
import { supabase } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 4000);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/things", async (_req, res) => {
  const { data, error } = await supabase
    .from("things")
    .select("id, name")
    .order("id", { ascending: true });

  if (error) {
    console.error("[api] supabase error:", error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json(data ?? []);
});

app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
```

- [ ] **Step 5: Install deps and verify the API starts (smoke check, no DB yet)**

```bash
cd examples/dogfood-stack && bun install
cd apps/api && PORT=4000 SUPABASE_ANON_KEY=dummy NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 bun run dev &
sleep 2
curl -s http://localhost:4000/health
kill %1
```

Expected: `{"status":"ok"}`. (The `/api/things` call would fail without a DB; that's fine for now.)

- [ ] **Step 6: Commit**

```bash
git add examples/dogfood-stack/
git commit -m "feat(dogfood): Express API skeleton with /health and /api/things"
```

---

## Task 9: Initialize Supabase with env-driven port config

**Files:**
- Create (via supabase CLI): `examples/dogfood-stack/supabase/config.toml`
- Modify: `examples/dogfood-stack/supabase/config.toml` (after init)

- [ ] **Step 1: Initialize Supabase in the dogfood-stack directory**

```bash
cd examples/dogfood-stack && supabase init
```

Expected: creates `supabase/config.toml` and `supabase/seed.sql` (empty).

- [ ] **Step 2: Update `supabase/config.toml` to use env() references for ports**

Open `supabase/config.toml` and edit the port fields. The full file (after edits) should look approximately like this — keep all of Supabase's other defaults; just change the port values to env() references:

```toml
project_id = "dogfood"

[api]
enabled = true
port = "env(SUPABASE_API_PORT)"
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = "env(SUPABASE_DB_PORT)"
shadow_port = "env(SUPABASE_DB_SHADOW_PORT)"
major_version = 15

[db.pooler]
enabled = false
port = "env(SUPABASE_DB_POOLER_PORT)"
pool_mode = "transaction"
default_pool_size = 20
max_client_conn = 100

[studio]
enabled = true
port = "env(SUPABASE_STUDIO_PORT)"

[inbucket]
enabled = true
port = "env(SUPABASE_INBUCKET_PORT)"

[storage]
enabled = true
file_size_limit = "50MiB"

[auth]
enabled = true
site_url = "http://localhost:3000"
additional_redirect_urls = ["https://localhost:3000"]
jwt_expiry = 3600
enable_signup = true

[analytics]
enabled = false
```

> **Note:** Supabase's `config.toml` has many other sections (`auth.email`, `auth.sms`, etc.). Leave those at their defaults — we're only changing the ports.

- [ ] **Step 3: Verify Supabase can start with the env-driven ports**

```bash
cd examples/dogfood-stack
SUPABASE_API_PORT=54321 \
SUPABASE_DB_PORT=54322 \
SUPABASE_DB_SHADOW_PORT=54320 \
SUPABASE_DB_POOLER_PORT=54329 \
SUPABASE_STUDIO_PORT=54323 \
SUPABASE_INBUCKET_PORT=54324 \
supabase start
```

Expected: Supabase starts cleanly, prints URLs and keys for the local instance. Verify `curl http://localhost:54321/auth/v1/health` returns a response.

- [ ] **Step 4: Save the anon key for later (you'll need it in the lich.yaml)**

The `supabase start` output shows an `anon key`. Copy it — we'll inline it in `lich.yaml`.

- [ ] **Step 5: Stop Supabase**

```bash
cd examples/dogfood-stack && supabase stop
```

- [ ] **Step 6: Commit**

```bash
git add examples/dogfood-stack/supabase/
git commit -m "feat(dogfood): supabase init + env-driven port config"
```

---

## Task 10: Create initial migration and seed

**Files:**
- Create: `examples/dogfood-stack/supabase/migrations/20260523000000_create_things.sql`
- Modify: `examples/dogfood-stack/supabase/seed.sql`

- [ ] **Step 1: Write the migration**

`examples/dogfood-stack/supabase/migrations/20260523000000_create_things.sql`:

```sql
create table public.things (
  id bigserial primary key,
  name text not null,
  created_at timestamp with time zone default now()
);

alter table public.things enable row level security;

create policy "Things are publicly readable"
on public.things for select
using (true);
```

- [ ] **Step 2: Write the seed**

`examples/dogfood-stack/supabase/seed.sql`:

```sql
insert into public.things (name) values
  ('first thing'),
  ('second thing'),
  ('third thing')
on conflict do nothing;
```

- [ ] **Step 3: Verify migration + seed work end-to-end**

```bash
cd examples/dogfood-stack

# Start Supabase
SUPABASE_API_PORT=54321 \
SUPABASE_DB_PORT=54322 \
SUPABASE_DB_SHADOW_PORT=54320 \
SUPABASE_DB_POOLER_PORT=54329 \
SUPABASE_STUDIO_PORT=54323 \
SUPABASE_INBUCKET_PORT=54324 \
supabase start

# Apply migration (supabase start runs migrations automatically, but verify)
supabase migration up

# Seed (use psql against the local supabase db)
psql "postgresql://postgres:postgres@localhost:54322/postgres" -f supabase/seed.sql

# Verify rows exist
psql "postgresql://postgres:postgres@localhost:54322/postgres" -c "select * from things;"
```

Expected: three rows.

- [ ] **Step 4: Stop Supabase**

```bash
cd examples/dogfood-stack && supabase stop
```

- [ ] **Step 5: Commit**

```bash
git add examples/dogfood-stack/supabase/
git commit -m "feat(dogfood): things table migration + seed"
```

---

## Task 11: Write the target `lich.yaml`

**Files:**
- Create: `examples/dogfood-stack/lich.yaml`

- [ ] **Step 1: Write `examples/dogfood-stack/lich.yaml`**

This is the file lich must understand by end of v1. It does NOT need to work yet — that's the whole point. It's the target.

```yaml
# yaml-language-server: $schema=https://lich.dev/schema/v1.json
# Target lich.yaml for the dogfood stack.
# This file is what lich must handle by end of v1.
# Until then, lich up against this config is the failing test case.

owned:
  supabase:
    cmd: supabase start
    cwd: .
    oneshot: true
    stop_cmd: supabase stop
    ports:
      api: { env: SUPABASE_API_PORT }
      db: { env: SUPABASE_DB_PORT }
      db_shadow: { env: SUPABASE_DB_SHADOW_PORT }
      db_pooler: { env: SUPABASE_DB_POOLER_PORT }
      studio: { env: SUPABASE_STUDIO_PORT }
      inbucket: { env: SUPABASE_INBUCKET_PORT }
    ready_when:
      tcp: "localhost:${owned.supabase.ports.api}"
      timeout: 90s

  api:
    cmd: bun run dev
    cwd: apps/api
    port: { env: PORT }
    depends_on: [supabase]
    ready_when:
      http_get: /health
      timeout: 30s
    fail_when:
      log_match: "EADDRINUSE|Cannot find module"

  web:
    cmd: bun run dev
    cwd: apps/web
    port: { env: PORT }
    depends_on: [api]
    ready_when:
      log_match: "ready in"
      timeout: 60s

env:
  # Supabase wiring (used by the API to talk to Supabase)
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:${owned.supabase.ports.api}"
  # Local anon key — Supabase generates a deterministic one per project_id, so
  # pasting once from Task 9 step 4 is fine for dev.
  SUPABASE_ANON_KEY: "REPLACE_WITH_SUPABASE_ANON_KEY"

  # API wiring (used by the web app to call the API)
  API_URL: "http://localhost:${owned.api.port}"

  # Postgres connection (for migrate/seed via psql)
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${owned.supabase.ports.db}/postgres"

profiles:
  dev:
    default: true
    owned: [supabase, api, web]
    lifecycle:
      after_up:
        - supabase migration up
        - psql "$DATABASE_URL" -f supabase/seed.sql

commands:
  test:e2e:
    cmd: echo "no e2e tests in dogfood-stack yet"
    help: |
      Placeholder for the dogfood-stack's own e2e tests.
      Real tests come once the stack is working under lich.

  db:psql:
    cmd: psql "$DATABASE_URL"
    help: |
      Open a psql shell against the local Supabase Postgres.
```

> **Note on the anon key:** Replace `REPLACE_WITH_SUPABASE_ANON_KEY` with the actual local anon key from Task 9 step 4. Supabase prints a fresh one on each `supabase start`, but it's deterministic per-project, so you can paste the value from your run.

- [ ] **Step 2: Commit**

```bash
git add examples/dogfood-stack/lich.yaml
git commit -m "feat(dogfood): target lich.yaml (the failing test case)"
```

---

## Task 12: End-to-end manual verification (no lich involved)

This task verifies the dogfood-stack actually works when run by hand. Nothing to write — just a manual smoke test to prove the example is real.

- [ ] **Step 1: Start Supabase manually**

```bash
cd examples/dogfood-stack
SUPABASE_API_PORT=54321 \
SUPABASE_DB_PORT=54322 \
SUPABASE_DB_SHADOW_PORT=54320 \
SUPABASE_DB_POOLER_PORT=54329 \
SUPABASE_STUDIO_PORT=54323 \
SUPABASE_INBUCKET_PORT=54324 \
supabase start
```

Verify it starts. Note the anon key in the output.

- [ ] **Step 2: Run migrations and seed**

```bash
supabase migration up
psql "postgresql://postgres:postgres@localhost:54322/postgres" -f supabase/seed.sql
```

- [ ] **Step 3: Start the API in a new terminal**

```bash
cd examples/dogfood-stack/apps/api
PORT=4000 \
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 \
SUPABASE_ANON_KEY="<paste anon key from Step 1>" \
bun run dev
```

Verify `curl http://localhost:4000/api/things` returns the 3 seeded rows.

- [ ] **Step 4: Start the web app in another terminal**

```bash
cd examples/dogfood-stack/apps/web
PORT=3000 API_URL=http://localhost:4000 bun run dev
```

Open `http://localhost:3000` in a browser. Verify the page lists the 3 things.

- [ ] **Step 5: Tear it all down**

Kill the web and API processes (Ctrl-C in their terminals), then:

```bash
cd examples/dogfood-stack && supabase stop
```

- [ ] **Step 6: No commit (verification only)**

If the manual run worked, the dogfood-stack is real. If not, debug before proceeding. This is the foundation — everything else depends on it.

---

## Task 13: Set up `tests/e2e/` infrastructure

**Files:**
- Create: `tests/e2e/vitest.config.ts`
- Create: `tests/e2e/package.json`
- Create: `tests/e2e/.gitignore`

- [ ] **Step 1: Create the e2e directory**

```bash
mkdir -p tests/e2e/helpers
```

- [ ] **Step 2: Write `tests/e2e/package.json`**

```json
{
  "name": "lich-e2e-tests",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "vitest": "^1.6.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Write `tests/e2e/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "helpers/**"],
    testTimeout: 120_000, // e2e is slow; 2 minutes per test
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true, // serialize e2e tests; they share docker
      },
    },
  },
});
```

- [ ] **Step 4: Write `tests/e2e/.gitignore`**

```
node_modules/
.tmp/
```

- [ ] **Step 5: Install deps**

```bash
cd tests/e2e && bun install
```

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/
git commit -m "test(e2e): vitest config + package skeleton"
```

---

## Task 14: Write the `tmpdir` helper (copy example to scratch)

**Files:**
- Create: `tests/e2e/helpers/tmpdir.ts`
- Create: `tests/e2e/helpers/tmpdir.test.ts`

- [ ] **Step 1: Write the failing test first**

`tests/e2e/helpers/tmpdir.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { copyExampleToTmpdir } from "./tmpdir.js";

let cleanup: (() => void) | null = null;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

describe("copyExampleToTmpdir", () => {
  it("copies the dogfood-stack example to a fresh tmpdir", () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    cleanup = cleanupFn;

    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, "lich.yaml"))).toBe(true);
    expect(existsSync(join(path, "apps/api/src/index.ts"))).toBe(true);
    expect(existsSync(join(path, "supabase/config.toml"))).toBe(true);

    const yaml = readFileSync(join(path, "lich.yaml"), "utf8");
    expect(yaml).toContain("owned:");
    expect(yaml).toContain("supabase:");
  });

  it("cleanup removes the tmpdir", () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    expect(existsSync(path)).toBe(true);
    cleanupFn();
    expect(existsSync(path)).toBe(false);
    cleanup = null;
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd tests/e2e && bun test helpers/tmpdir.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`tests/e2e/helpers/tmpdir.ts`:

```typescript
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Copy an example app to a fresh tmpdir so e2e tests can mutate it
 * without affecting the repo's source.
 *
 * Resolves the example path relative to the repo root (REPO_ROOT/examples/<name>).
 * Returns the tmpdir path and a cleanup function.
 */
export function copyExampleToTmpdir(exampleName: string): {
  path: string;
  cleanup: () => void;
} {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const sourcePath = join(repoRoot, "examples", exampleName);

  const tmp = mkdtempSync(join(tmpdir(), `lich-e2e-${exampleName}-`));
  cpSync(sourcePath, tmp, {
    recursive: true,
    filter: (src) => {
      // Skip node_modules, .next, etc. — they're not needed and slow to copy
      return !/\/(node_modules|\.next|dist|\.lich|\.tmp)(\/|$)/.test(src);
    },
  });

  const cleanup = () => {
    rmSync(tmp, { recursive: true, force: true });
  };

  return { path: tmp, cleanup };
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd tests/e2e && bun test helpers/tmpdir.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers/
git commit -m "test(e2e): tmpdir helper copies example to scratch"
```

---

## Task 15: Write the `lich` spawn helper

**Files:**
- Create: `tests/e2e/helpers/lich.ts`
- Create: `tests/e2e/helpers/lich.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/e2e/helpers/lich.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { runLich } from "./lich.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
  // Ensure the lich binary is built before running these tests.
  if (!existsSync(lichBinary)) {
    const build = spawnSync("bun", ["run", "build"], {
      cwd: resolve(repoRoot, "packages/lich"),
      stdio: "inherit",
    });
    if (build.status !== 0) {
      throw new Error("Failed to build lich binary");
    }
  }
});

describe("runLich", () => {
  it("returns version when called with --version", () => {
    const result = runLich(["--version"], { cwd: repoRoot });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^lich \d/);
  });

  it("returns non-zero exit code for unknown command", () => {
    const result = runLich(["definitely-not-a-command"], { cwd: repoRoot });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });

  it("returns 'not yet implemented' for up command (current stub state)", () => {
    const result = runLich(["up"], { cwd: repoRoot });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not yet implemented");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd tests/e2e && bun test helpers/lich.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`tests/e2e/helpers/lich.ts`:

```typescript
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const LICH_BINARY = resolve(repoRoot, "packages/lich/dist/lich");

export interface RunLichResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunLichOptions {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Run the lich binary synchronously and capture output.
 * Used for short-lived commands like --version, validate, init.
 */
export function runLich(args: string[], opts: RunLichOptions): RunLichResult {
  const result = spawnSync(LICH_BINARY, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeout: opts.timeout ?? 30_000,
    encoding: "utf8",
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Spawn the lich binary asynchronously (returns the child process).
 * Used for long-lived commands like `lich up` where the test needs to
 * monitor logs and tear down explicitly.
 */
export function spawnLich(
  args: string[],
  opts: RunLichOptions
): ChildProcess {
  return spawn(LICH_BINARY, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd tests/e2e && bun test helpers/lich.test.ts
```

Expected: 3 tests pass (the binary will be built automatically on first run).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers/
git commit -m "test(e2e): lich spawn helpers (sync + async)"
```

---

## Task 16: Write the `wait` helpers (port open, http 200)

**Files:**
- Create: `tests/e2e/helpers/wait.ts`
- Create: `tests/e2e/helpers/wait.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/e2e/helpers/wait.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { waitForHttp200, waitForTcpOpen } from "./wait.js";

describe("waitForHttp200", () => {
  it("resolves when the server returns 200", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as any).port;

    await expect(
      waitForHttp200(`http://localhost:${port}`, { timeoutMs: 5000 })
    ).resolves.toBeUndefined();

    server.close();
  });

  it("rejects on timeout", async () => {
    await expect(
      waitForHttp200("http://localhost:1", { timeoutMs: 500 })
    ).rejects.toThrow(/timeout/i);
  });
});

describe("waitForTcpOpen", () => {
  it("resolves when port is listening", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as any).port;

    await expect(
      waitForTcpOpen("localhost", port, { timeoutMs: 5000 })
    ).resolves.toBeUndefined();

    server.close();
  });

  it("rejects on timeout", async () => {
    await expect(
      waitForTcpOpen("localhost", 1, { timeoutMs: 500 })
    ).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd tests/e2e && bun test helpers/wait.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`tests/e2e/helpers/wait.ts`:

```typescript
import { createConnection } from "node:net";

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_INTERVAL = 250;

/**
 * Polls an HTTP URL until it returns a 2xx status, or times out.
 */
export async function waitForHttp200(
  url: string,
  opts: WaitOptions = {}
): Promise<void> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status >= 200 && res.status < 300) return;
    } catch {
      // ignore; will retry
    }
    await sleep(interval);
  }

  throw new Error(`timeout waiting for HTTP 200 from ${url} after ${timeout}ms`);
}

/**
 * Polls a TCP host:port until a connection succeeds, or times out.
 */
export async function waitForTcpOpen(
  host: string,
  port: number,
  opts: WaitOptions = {}
): Promise<void> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const ok = await tryConnect(host, port);
    if (ok) return;
    await sleep(interval);
  }

  throw new Error(
    `timeout waiting for TCP ${host}:${port} after ${timeout}ms`
  );
}

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd tests/e2e && bun test helpers/wait.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers/
git commit -m "test(e2e): wait helpers (http 200 + tcp open) with timeouts"
```

---

## Task 17: Write the first failing e2e test (lich up against dogfood-stack)

**Files:**
- Create: `tests/e2e/basic-up.test.ts`

- [ ] **Step 1: Write the test (it will fail because lich up is a stub)**

`tests/e2e/basic-up.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich, spawnLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";
import type { ChildProcess } from "node:child_process";

let cleanup: (() => void) | null = null;
let lichProc: ChildProcess | null = null;

afterEach(async () => {
  if (lichProc) {
    lichProc.kill("SIGINT");
    await new Promise<void>((r) => setTimeout(r, 1000));
    lichProc = null;
  }
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

describe("lich up against dogfood-stack (THE failing test case)", () => {
  it("brings the stack up and serves the web app", async () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    cleanup = cleanupFn;

    // Validate first
    const validateResult = runLich(["validate"], { cwd: path });
    expect(validateResult.exitCode).toBe(0);

    // Bring it up in the background
    lichProc = spawnLich(["up"], { cwd: path });

    // Wait for web service to respond (lich should print the URL)
    // The friendly URL pattern is http://<service>.<worktree>.lich.localhost:3300/
    // Until proxy is implemented, this test will fail. That's expected.
    await waitForHttp200("http://web.dogfood-stack.lich.localhost:3300/", {
      timeoutMs: 120_000,
    });
  });

  it("lich validate succeeds against the target yaml", () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    cleanup = cleanupFn;

    const result = runLich(["validate"], { cwd: path });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails (this is intentional)**

```bash
cd tests/e2e && bun test basic-up.test.ts
```

Expected: BOTH tests FAIL. Specifically:
- `lich validate` exits 1 because validate is a stub
- `lich up` exits 1 immediately because up is a stub (so no web app comes up; the waitForHttp200 times out)

This is the **failing test case** that drives Plans 1-6.

- [ ] **Step 3: Commit (committing failing tests is intentional — they are the spec made executable)**

```bash
git add tests/e2e/basic-up.test.ts
git commit -m "test(e2e): failing test case — lich up against dogfood-stack

These tests intentionally fail at end of Plan 0. They are the
executable target for subsequent plans. By end of v1, all e2e
tests against the dogfood-stack must pass.
"
```

---

## Task 18: Add a README to the lich package

**Files:**
- Create: `packages/lich/README.md`

- [ ] **Step 1: Write the README**

`packages/lich/README.md`:

```markdown
# lich

A worktree-scoped dev stack orchestrator. See the v1 design spec at
`docs/superpowers/specs/2026-05-23-lich-v1-design.md`.

## Status

Pre-alpha. Plan 0 (foundation + failing test case) complete; Plans 1-6
add functionality tier by tier.

## Development

```bash
# Install deps
bun install

# Run the CLI from source
bun run dev --version

# Build the binary
bun run build
./dist/lich --version

# Run unit tests
bun test
```

## End-to-end tests

E2e tests live at `../../tests/e2e/`. They build the binary, copy
`examples/dogfood-stack/` to a tmpdir, and exercise `lich` against it.

```bash
cd ../../tests/e2e && bun test
```

At end of Plan 0, every e2e test fails (lich is a stub). Each
subsequent plan turns tests green.
```

- [ ] **Step 2: Commit**

```bash
git add packages/lich/README.md
git commit -m "docs(lich): pre-alpha README pointing at the spec"
```

---

## Final Verification

Run through this checklist before declaring Plan 0 complete:

- [ ] `bun --version`, `docker info`, `supabase --version`, `git --version` all work
- [ ] `cd packages/lich && bun run build` produces `packages/lich/dist/lich`
- [ ] `./packages/lich/dist/lich --version` prints `lich 0.0.1`
- [ ] `cd packages/lich && bun test` passes (smoke tests)
- [ ] `cd tests/e2e && bun test helpers/` passes (helper tests)
- [ ] `cd tests/e2e && bun test basic-up.test.ts` FAILS (the failing test case is in place)
- [ ] Manual run-through of `examples/dogfood-stack/` (Task 12) worked end-to-end via bash
- [ ] Git log shows ~17-18 small, focused commits

When all green except `basic-up.test.ts`, Plan 0 is done. The system is ready for Plan 1 (Core engine).

---

## What Plan 1 will tackle

For preview / continuity:

- Config parsing: read `lich.yaml`, parse to typed structure
- Schema validation: JSON Schema for the v1 yaml shape; `lich validate` reports issues with file:line context
- Worktree detection: derive worktree name + id from git
- Port allocator: file-locked allocator under `~/.lich/`
- State directory: per-worktree state under `~/.lich/stacks/<id>/`
- Compose runner: shell out to docker/podman/nerdctl compose with the right `-p <name>` + port overrides
- Owned service runner: spawn via concurrently with env injection
- Env basics: `env:` literals, `env_files`, `env_from`, top-level only (no groups yet)
- Ready basics: `http_get` and `tcp` (`log_match` and `capture` come in Plan 4)
- Basic CLI: `lich up`, `down`, `logs`, `urls`, `stacks`, `nuke`, `validate` actually work

Goal of Plan 1: `lich up` against `examples/dogfood-stack/` brings up the stack and `lich urls` returns the raw `localhost:<allocated_port>` URLs for `api` and `web`. The "lich validate succeeds against the target yaml" test turns green; the "brings the stack up and serves the web app" test still fails because friendly URLs aren't implemented yet (Plan 5). After Plan 1 you can manually `curl` the raw URL to confirm the stack is up.
