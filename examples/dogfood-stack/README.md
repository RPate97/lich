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
