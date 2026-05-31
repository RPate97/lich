# Framework-to-lich patterns

Per-framework cookbook for translating a dev workflow into an `owned:` block. Each section: how to spot it, the dev command, port behavior, the `owned:` shape to propose.

When surveying, identify each app's framework and pull the matching pattern. Adjust based on what the survey reveals (e.g., custom port via `package.json` `dev` script).

---

## Next.js

**Spot it:**
- `next` in `package.json` `dependencies` or `devDependencies`
- `next.config.{js,mjs,ts}` at the app root
- `app/` or `pages/` directory

**Dev command:** `next dev` (usually via `package.json` `scripts.dev`)

**Port behavior:** Default 3000. Honors `PORT` env var when set. Some teams set it via `next dev --port $PORT` in the script — check `package.json`.

**Shape:**
```yaml
owned:
  web:
    cmd: bun run dev          # or `npm run dev` / `pnpm dev` / `yarn dev` — match repo
    cwd: apps/web             # adjust to the actual path
    port: { published_env: PORT }
    ready_when:
      http_get: /             # Next dev returns 200 on / once compilation finishes
      timeout: 60s            # cold-cache compile is slow; 30s often too tight
```

**Gotchas:**
- If the app uses `next.config.js` with `output: 'standalone'`, dev still uses next-dev — no change.
- Next 15 + Turbopack: `next dev --turbo`. Same shape, just slightly faster.
- App Router with server actions: no special handling needed.

---

## Express / Fastify / Bun.serve / Hono / Koa

**Spot it:**
- Any of `express`, `fastify`, `hono`, `koa` in deps
- An HTTP server listener somewhere in `src/`: `app.listen(PORT)` / `Bun.serve({ port })` / `fastify.listen()`

**Dev command:** Usually `node src/index.ts`, `bun run dev`, `nodemon`, or similar — check `scripts.dev`.

**Port behavior:** Reads `process.env.PORT` in 95% of cases. Default fallback is often 3000 or 4000.

**Shape:**
```yaml
owned:
  api:
    cmd: bun run dev          # match the repo's dev script
    cwd: apps/api
    port: { published_env: PORT }
    ready_when:
      http_get: /health       # most teams expose /health; if not, ask the user
      timeout: 30s
    fail_when:
      log_match: "EADDRINUSE|Cannot find module"   # known doomed-startup signals
```

**Gotchas:**
- If there's no `/health` route, ask the user what to probe. `/` works for many APIs but returns 404 if the root isn't a defined route.
- If the dev command is `nodemon` or `tsx --watch`: same shape; lich's `kill -TERM` works fine with watchers.

---

## Django

**Spot it:**
- `manage.py` at the repo root or app root
- `settings.py` somewhere

**Dev command:** `python manage.py runserver` (sometimes wrapped: `make dev`, `just dev`)

**Port behavior:** `runserver` defaults to 8000. Accepts a positional port arg: `runserver $PORT` — most teams write the script that way for lich/Docker compatibility.

**Shape:**
```yaml
owned:
  api:
    cmd: python manage.py runserver $PORT
    cwd: apps/api               # or wherever manage.py lives
    port: { published_env: PORT }
    ready_when:
      http_get: /
      timeout: 30s
```

**Gotchas:**
- If the project uses `gunicorn` for dev (rare), the command is `gunicorn project.wsgi:application --bind 0.0.0.0:$PORT`.
- For Django Channels (websockets): `daphne project.asgi:application --bind 0.0.0.0 --port $PORT`.

---

## Rails

**Spot it:**
- `Gemfile` + `bin/rails` (usually + `config.ru` and `config/application.rb`)

**Dev command:** `bin/rails server` (often aliased to `bin/dev` for Procfile-style multi-process setups)

**Port behavior:** Default 3000. Reads `-p $PORT` flag.

**Shape:**
```yaml
owned:
  api:
    cmd: bin/rails server -p $PORT
    cwd: .                       # or apps/web in a monorepo
    port: { published_env: PORT }
    ready_when:
      http_get: /                # or /health if the app defines it
      timeout: 30s
```

**Gotchas:**
- Rails 7+ with Hotwire / Turbo: still HTTP, same shape.
- If `bin/dev` is present (Procfile-style), check what processes it starts — you may want each as its own `owned:` entry instead.

---

## FastAPI / Uvicorn

**Spot it:**
- `fastapi` in `pyproject.toml` or `requirements.txt`
- `app = FastAPI()` somewhere in the source
- Usually run via `uvicorn` or `gunicorn`

**Dev command:** `uvicorn main:app --reload --port $PORT` (the `main:app` part varies by repo)

**Port behavior:** uvicorn defaults to 8000; respects `--port` and `PORT` env var.

**Shape:**
```yaml
owned:
  api:
    cmd: uvicorn main:app --reload --port $PORT
    cwd: apps/api
    port: { published_env: PORT }
    ready_when:
      http_get: /docs           # FastAPI's OpenAPI docs page; always available in dev
      timeout: 30s
```

**Gotchas:**
- The `main:app` path is the load-bearing thing — find the actual entry. Common variants: `app.main:app`, `src.main:app`, `myapp.api:app`.
- For production-flavored dev, `gunicorn -w 1 -k uvicorn.workers.UvicornWorker main:app` — same shape.

---

## Vite (Vue / React / Svelte / SolidJS)

**Spot it:**
- `vite.config.{js,ts,mjs}` at the app root
- `vite` in `devDependencies`

**Dev command:** `vite` or `vite dev` (often via `scripts.dev: "vite"`)

**Port behavior:** Default 5173. Reads `--port $PORT` or `vite --port $PORT`. The `PORT` env var works for some vite configs but not all — explicit `--port` is safer.

**Shape:**
```yaml
owned:
  web:
    cmd: bun run dev -- --port $PORT
    cwd: apps/web
    port: { published_env: PORT }
    ready_when:
      http_get: /
      timeout: 30s
```

**Gotchas:**
- `--` is needed when the dev script is `vite` and you want to pass `--port` through `npm/bun/pnpm/yarn run`.
- For SvelteKit (which uses vite under the hood): same shape, sometimes `--port` directly in `vite.config.ts` so the env approach doesn't kick in. Check the config.

---

## Bun (Bun.serve / Bun runtime in general)

**Spot it:**
- `bun-types` or `@types/bun` in deps
- `Bun.serve({ port })` somewhere in source
- `bun run dev` in scripts

**Dev command:** `bun run dev` typically; some teams use `bun --hot src/index.ts` for HMR.

**Port behavior:** Reads `process.env.PORT` if the code is set up for it (e.g., `Bun.serve({ port: Number(process.env.PORT) ?? 3000 })`).

**Shape:**
```yaml
owned:
  api:
    cmd: bun --hot src/index.ts
    cwd: apps/api
    port: { published_env: PORT }
    ready_when:
      http_get: /health
      timeout: 30s
```

---

## Go (net/http, Gin, Echo, Fiber, Chi)

**Spot it:**
- `go.mod` at the repo root
- `main.go` with an HTTP handler

**Dev command:** `go run .` (sometimes wrapped with `air` for hot reload: `air`)

**Port behavior:** Convention is to read `os.Getenv("PORT")` and fallback. Project-specific.

**Shape:**
```yaml
owned:
  api:
    cmd: air                    # or `go run .`
    cwd: apps/api
    port: { published_env: PORT }
    ready_when:
      http_get: /health
      timeout: 30s
```

---

## Workers / queues / background jobs

For services that don't expose HTTP (e.g. Celery, Sidekiq, Resque, BullMQ workers, Temporal workers):

**Shape:**
```yaml
owned:
  workers:
    cmd: bun run worker         # whatever the dev command is
    cwd: apps/workers
    # No port: — workers don't bind a port
    ready_when:
      log_match: "Worker started|Listening on queue"   # match a log line the worker prints when ready
      timeout: 30s
```

`log_match` is the workhorse pattern for non-HTTP services.

---

## Compose-only services (postgres, redis, mailhog, temporal, etc.)

These go in `services:`, not `owned:`. Use existing `docker-compose.yml` entries as the starting point — most compose features pass through to lich verbatim.

### postgres

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: [{ container_port: 5432, published_env: POSTGRES_HOST_PORT }]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp
    tmpfs:
      - /var/lib/postgresql/data    # ephemeral; switch to `volumes:` if persistence wanted
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d myapp"]
      interval: 1s
      timeout: 1s
      retries: 30
```

### redis

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: [{ container_port: 6379, published_env: REDIS_HOST_PORT }]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 1s
      retries: 10
```

### mailhog (SMTP catcher for dev)

```yaml
services:
  mailhog:
    image: mailhog/mailhog
    ports:
      - { container_port: 1025, published_env: SMTP_HOST_PORT }     # SMTP
      - { container_port: 8025, published_env: MAILHOG_UI_PORT }    # web UI
```

### temporal (durable execution)

```yaml
services:
  temporal:
    image: temporalio/auto-setup:1.22
    ports: [{ container_port: 7233, published_env: TEMPORAL_HOST_PORT }]
    environment:
      DB: postgresql
      POSTGRES_USER: postgres
      POSTGRES_PWD: postgres
      POSTGRES_SEEDS: postgres
    depends_on: [postgres]
```

---

## How to pick between `services:` and `owned:`

Rule of thumb:
- **Already in docker-compose.yml** → keep it as `services:` (just port it over).
- **Has an official Docker image and you don't need to debug its internals** → `services:`.
- **It's your code** → `owned:` (you want logs in `lich logs`, you want fast restarts, you don't want compose round-trips).

You almost never want your own app as `services:` (slower iteration, harder to debug).
