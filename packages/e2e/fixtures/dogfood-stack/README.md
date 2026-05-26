# Lich Dogfood Stack

A real Next + Express + Postgres application used as lich's failing test case.

## Stack
- **Web (Next.js):** `apps/web/` — page that lists "things"
- **API (Express):** `apps/api/` — `/api/things` reads from Postgres via `Bun.sql`
- **DB (Postgres):** `compose.yaml` + `db/` — `postgres:16-alpine` compose service,
  with migrations + seed in `db/`

## Running by hand (without lich)

```bash
# 1. Install deps
bun install

# 2. Start Postgres (compose)
docker compose up -d

# 3. Wait for healthy, then run migrations + seed
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
