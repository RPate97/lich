# Lich v1 — Design Spec

**Status:** Draft for review
**Date:** 2026-05-23
**Author:** Ryan Pate (with brainstorming partner)

## 1. Problem and positioning

### The problem

Running and managing local dev stacks is ad-hoc, fragile, and doesn't compose. Every project re-invents its own combination of `docker compose up && pnpm dev && wait-for-pg && pnpm migrate && pnpm seed && open http://...`. Every README has a different version of it. You can only run one copy of any project at a time, because ports collide, container names collide, compose project names collide, and migration state collides.

That problem already hurts solo developers. It becomes catastrophic the moment you try to run **multiple concurrent copies of the same stack** — which is what git worktrees want, what parallel coding agents demand, and what ephemeral CI environments need. The underlying problem is "dev stack orchestration is broken." The *acute* version of it, which is recent and growing fast, is "dev stack orchestration in the presence of N parallel stacks per repo."

### What lich is

**Lich is a thin wrapper that gives your existing dev stack a uniform interface and lets you run it in parallel across git worktrees without anything colliding.**

It's a single binary that reads one YAML file describing your stack, then handles port allocation, env wiring, lifecycle, isolation, and supervision. It doesn't replace docker compose — it uses it. It doesn't replace your dev server — it runs it. It doesn't know what framework you use.

The mental model: **lich is what you'd build on top of compose if you were going to keep doing this for the next five years**, plus host-process orchestration, plus worktree isolation, plus a dashboard.

### What lich is not

- Not a framework — it drives yours
- Not a container runtime — it drives one (any compose-compatible one)
- Not a build tool, bundler, linter, test runner
- Not a scaffolder — no `create-lich-app`
- Not a plugin ecosystem — extension happens via shell-out, not plugins
- Not opinionated about your stack — Rails, Django, Phoenix, Go, .NET all work the same way

### Why now

- Git worktrees went from niche to mainstream in the last 2-3 years
- AI coding agents that run in parallel are a 2024-2025 phenomenon
- The acute version of "N parallel stacks per repo" basically didn't exist before this
- Compose has had ports/naming gaps for years but nobody felt them at scale
- Tools that solve adjacent problems (Tilt) are K8s-heavy; nothing sits at the "lightweight, runtime-agnostic, host+container, parallel-aware" layer

## 2. Audience

### Primary wedge

Developers using AI coding agents who run multiple agents (or one agent with multiple worktrees) on the same project simultaneously. Today this is a small but rapidly growing population — concentrated among Cursor / Claude Code / Aider / Codex power users. Within 12-24 months it will be a meaningfully larger slice of professional developers.

### Secondary audiences

- **Solo developers using git worktrees aggressively.** Even without agents, parallel branch experiments benefit from stack isolation.
- **Teams that want consistent dev startup.** "New hire is productive in 5 minutes after `git clone`" is a real pull.
- **Ephemeral CI / test environments.** Per-test isolated stacks via the same yaml.

### Non-audience (deliberate)

- **Solo developers with a single stack and a working bash script.** Lich is marginal value for them. If `docker compose up && pnpm dev` works, they don't need lich.
- **K8s-native shops.** Tilt, Skaffold, Devspace, Garden serve them better.
- **People who want full live-reload orchestration** (Tilt-style `live_update`). Lich doesn't compete here.
- **People who deploy via tools that have their own dev story** (Vercel for pure frontend, etc.).

### Important property: value is not gated by stack complexity

Even a one-service stack (one web app + one Postgres) hits port collisions the moment you try to run two worktrees. Lich's value scales with the *number of parallel stacks*, not the *size of any one stack*. This matters because it means lich is useful for far more developers than just "people with complex microservice setups."

## 3. Core abstraction

### The five primitives

A `lich.yaml` describes a stack via five top-level sections:

1. **`services`** — containers, using compose-spec YAML; run by any compose-compatible CLI
2. **`owned`** — host processes lich starts and manages directly
3. **`env`** — environment variables: literals, runtime interpolation, dotenv files, shell-out for secrets
4. **`lifecycle`** — top-level hooks: `before_up`, `after_up`, `before_down`
5. **`runtime`** — optional config: which compose CLI to use, daemon proxy port, etc.

Implicit cross-cutting primitives:
- **Ports** — declared per-service, allocated per-worktree, injected via env vars
- **Ready conditions** — per-service `ready_when` (httpGet / tcp / log_match / cmd)
- **Dependencies** — `depends_on` works across the compose/owned boundary
- **Per-worktree isolation** — port allocation, compose project namespacing, state directories, env files

### Per-worktree everything

For each worktree where lich runs, lich maintains:

- A unique compose project name (derived from worktree path hash + worktree name)
- Allocated host ports for every container port and every owned service
- A state directory under `~/.lich/stacks/<stack-id>/` containing: PID files, log files, env files, captured values, ready state, friendly-URL routing entries
- Generated env files per service for compose injection

Two `lich up` invocations from two different worktrees of the same repo are guaranteed to not collide. This is the load-bearing property of the entire product.

### Daemon process

A single per-machine background process — the "lich daemon" — runs as long as any stack is up. It hosts:

- The web dashboard (supervisory UI)
- The friendly-URL reverse proxy
- A state watcher that discovers stacks from the on-disk state directory

The daemon auto-starts on the first `lich up` and auto-stops when the last stack exits. Discovery is on-disk (no IPC required from `lich up` invocations to the daemon).

## 4. Config schema (`lich.yaml`)

### Full annotated example

```yaml
# lich.yaml
runtime:
  compose: auto   # auto | docker | podman | nerdctl
  proxy_port: 3300

services:
  postgres:
    image: postgres:16
    ports:
      - { container: 5432, env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 30

  localstack:
    image: localstack/localstack:latest
    ports:
      - { container: 4566, env: LOCALSTACK_HOST_PORT }
    environment:
      SERVICES: "s3,sqs,dynamodb"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
    lifecycle:
      after_ready:
        - terraform -chdir=infra init -upgrade
        - terraform -chdir=infra apply -auto-approve
      before_down:
        - terraform -chdir=infra destroy -auto-approve

owned:
  api:
    cmd: pnpm dev
    cwd: apps/api
    port: { env: PORT }
    depends_on: [postgres]
    ready_when:
      http_get: /health
    lifecycle:
      after_ready:
        - pnpm warmup-cache

  web:
    cmd: pnpm dev
    cwd: apps/web
    port: { env: PORT }
    depends_on: [api]
    ready_when:
      log_match: "ready in"

  api_tunnel:
    cmd: cloudflared tunnel --url http://localhost:${owned.api.port}
    depends_on: [api]
    ready_when:
      log_match: 'https://[a-z-]+\.trycloudflare\.com'
      capture:
        public_url: 'https://[a-z-]+\.trycloudflare\.com'

env:
  NODE_ENV: development
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/app"
  API_URL: "http://localhost:${owned.api.port}"
  PUBLIC_API_URL: "${owned.api_tunnel.captured.public_url}"
  AWS_ENDPOINT_URL: "http://localhost:${services.localstack.host_port}"
  AWS_ACCESS_KEY_ID: test
  AWS_SECRET_ACCESS_KEY: test
  AWS_REGION: us-east-1
  TF_DATA_DIR: ".lich/terraform/${worktree.name}"

env_files:
  - .env
  - .env.local

env_from:
  - cmd: "infisical export --format=dotenv --env=dev"
    format: dotenv

lifecycle:
  after_up:
    - cd apps/api && pnpm prisma migrate dev
    - cd apps/api && pnpm seed
```

### Section-by-section reference

#### `runtime`

Optional. Configures the lich runtime itself.

- `compose`: which compose CLI to shell out to. `auto` (default) detects `docker compose`, `podman compose`, then `nerdctl compose` in order.
- `proxy_port`: TCP port for the friendly-URL reverse proxy. Default `3300`. The proxy is a single per-machine process (part of the daemon).

#### `services` (compose-spec containers)

Standard compose service spec, with one small extension: `ports` entries support `{ container: <port>, env: <ENV_NAME> }` to request that lich allocate a host port and expose it via the named env var inside the host context (for env interpolation).

Lich generates a compose override file per-worktree that adds:
- A unique project name (`-p <worktree-name>-<hash>`)
- Allocated host port bindings
- Env vars resolved from the `env` section

Standard compose features (`healthcheck`, `depends_on` *within* compose, `volumes`, `networks`, `profiles`) all work as documented in the compose spec.

**Per-service `lifecycle:` block** can contain:
- `before_start` (runs before the container starts)
- `after_ready` (runs after healthcheck passes; service is "initializing" until this completes; downstream `depends_on` waits for ready, not healthy)
- `before_down` (runs before teardown)

#### `owned` (host processes)

Lich starts and supervises these directly. Each owned service:

- `cmd`: the shell command to start the process
- `cwd`: working directory (relative to project root); defaults to project root
- `port` (single-port shape): `{ env: ENV_NAME }` — lich allocates a port and sets the env var on the process
- `ports` (multi-port shape): map of name → `{ env: ENV_NAME }` — for tools like Supabase that manage multiple endpoints under one CLI command
- `depends_on`: list of other service names (compose or owned); the service waits until all dependencies are `ready` (not just `healthy`)
- `ready_when`: one of:
  - `http_get: <path>` — poll path on the allocated port; ready on 2xx
  - `tcp: <host:port>` — wait for TCP listener
  - `log_match: <regex>` — wait for stdout/stderr to contain a match
  - `cmd: <shell>` — execute periodically; ready when exit 0
  - Plus optional `capture:` map of `<name>: <regex>` — when ready, run regex on accumulated log buffer and store named captures (or full match if no named groups) for reference via `${owned.<name>.captured.<key>}`
- `oneshot: true` — the cmd is expected to exit on its own once setup is complete; lich does not track the process by PID. Used for tools like Supabase whose start command spawns background processes and exits.
- `stop_cmd`: custom teardown command (default: SIGINT the tracked PID). Required when `oneshot: true`.
- `lifecycle:` block (same shape as `services.lifecycle`)
- `env`: per-service env overrides (merged on top of global `env`)
- `env_files`: per-service dotenv files (merged on top of global)
- `env_from`: per-service shell-out env sources (merged on top of global)

#### `env`

Environment variables available to owned services and (filtered) injected into compose services.

- Values are strings or YAML-typed primitives (numbers/booleans coerced to strings before injection)
- **Interpolation:** `${...}` resolves at runtime against a known context:
  - `${services.<name>.host_port}` — allocated host port for a compose service's primary port (or `${services.<name>.host_port:<container_port>}` for non-primary ports)
  - `${owned.<name>.port}` or `${owned.<name>.ports.<name>}` — owned service ports
  - `${owned.<name>.captured.<key>}` — values captured from log streams
  - `${worktree.name}` — the worktree name (derived from directory name)
  - `${worktree.path}` — absolute path to worktree
  - `${worktree.id}` — short stable identifier for the worktree
- **Precedence** (later wins): `env_files` → `env_from` → `env` literals → host `process.env` overlay

#### `env_files`

List of dotenv file paths, resolved relative to the project root (not the worktree, since `.env.local` typically lives in the parent repo). Missing files are silently skipped. Values are merged in declared order; later files override earlier ones.

#### `env_from`

List of shell-out env sources. Each entry:
- `cmd`: shell command whose stdout produces env vars
- `format`: `dotenv` (default) or `json` (a flat object of string values)
- `cwd`: optional working directory (default: project root)

Handles Infisical, 1Password, Doppler, AWS Secrets Manager, internal scripts — any tool that can emit env vars to stdout. Lich does not authenticate to the secret manager; the user's normal CLI auth context applies.

#### `lifecycle` (top-level)

Stack-wide hooks:
- `before_up`: runs before any service starts
- `after_up`: runs after all services are ready (use for stack-wide migrations, seeding, codegen)
- `before_down`: runs before any teardown starts

Each is a list of shell commands. Commands inherit the full resolved env, run with `cwd = project_root` (unless explicitly chained via `cd path && cmd`). A non-zero exit aborts the lifecycle phase and reports the failure.

## 5. CLI surface

### Commands

| Command | Purpose |
|---|---|
| `lich up` | Bring the current worktree's stack up |
| `lich down` | Tear it down |
| `lich logs [service]` | Tail aggregated logs, or per-service logs |
| `lich urls [--raw]` | Print friendly URLs (or raw `localhost:port` URLs) |
| `lich stacks` | List every stack running on this machine |
| `lich restart [services...]` | Restart everything, or specific services, or `--owned`, or `--compose` |
| `lich nuke` | Kill everything on this machine; clean state directories |
| `lich init` | Stamp out an annotated `lich.yaml` skeleton + `.gitignore` entry |
| `lich validate [path]` | Validate a `lich.yaml` against the schema and reference graph |

### Output design

CLI output is treated as a first-class feature, not polish.

- **Phased progress** for multi-step operations. `lich up` shows: allocating ports, starting compose, waiting for healthy, starting owned services, running `after_ready` hooks, running stack-wide `after_up` — each as a labeled step with status.
- **Live status updates** for in-progress phases (spinners for indeterminate, progress lines for known counts).
- **Colored status indicators** consistently: green ✓ for success, yellow ⏳ for in-progress, red ✗ for failed, gray ↓ for skipped.
- **Final summary** with the things the user wants next: stack name, friendly URLs, log command, dashboard URL.
- **Errors with actionable hints,** not stack traces. Example: "Port allocation failed: tried 54000-54100, all in use. Run `lich stacks` to see what's running, or `lich nuke` to kill everything."
- **`--quiet` flag** for CI / scripting that emits only the structured final summary.
- **`--json` flag** for programmatic consumption (used by the meta-harness e2e tests).

### Restart granularity

`lich restart` semantics:
- `lich restart` (no args) — restart the full stack (down + up)
- `lich restart api web` — restart specified services (compose and/or owned)
- `lich restart --owned` — restart all owned services, leave compose alone
- `lich restart --compose` — restart all compose services (rare; usually for env changes)

Restart honors `depends_on` ordering. Affected services and downstream services restart in dependency order.

### Validation

`lich validate [path]` is a static analysis pass over a `lich.yaml`. It:

- Validates against the JSON Schema (correct keys, correct types, required fields present)
- Resolves every `${...}` interpolation reference and flags any that target nonexistent services, ports, or captures
- Validates `depends_on` references — flags depends targets that aren't declared
- Verifies referenced files exist (`env_files` paths, `cwd` directories for owned services)
- Reports issues with `file:line:col` context for editor jumping
- Exits 0 if valid, non-zero on any error
- `--json` for structured output (used by the `lich:instrument` skill's edit/validate/fix loop)

It deliberately does NOT execute anything — no docker shell-outs, no service starts. Pure static analysis. Cheap to run, safe in pre-commit hooks and CI gates.

Editor integration is via JSON Schema (yaml-language-server picks it up from a `# yaml-language-server: $schema=` comment that `lich init` writes into the skeleton). `lich validate` is the runtime/CI equivalent of the editor's real-time checks.

## 6. Dashboard and daemon

### The daemon

A single per-machine background process. Auto-starts on first `lich up`, auto-stops when no stacks remain. Three responsibilities:

1. **Web dashboard** (HTTP server on an allocated port; URL recorded in `~/.lich/daemon.url`)
2. **Reverse proxy** for friendly URLs (HTTP server on `runtime.proxy_port`, default 3300)
3. **State watcher** that re-reads `~/.lich/stacks/` whenever it changes (filesystem watch)

PID file at `~/.lich/daemon.pid`. Stale PIDs detected via process-exists check and replaced. Failure to start the daemon (port conflict, etc.) does NOT fail the user's `lich up` — it logs a warning and continues; the user can still interact via CLI.

Auto-shutdown logic: every N seconds (default 10), the daemon checks `~/.lich/stacks/`. If no stack directories exist for K consecutive checks (default 3), it exits cleanly.

### Dashboard

Web UI served by the daemon. Routes:

- `/` — list of every stack on the machine. Each entry shows: worktree name, service count, status, uptime, friendly URLs.
- `/stacks/<id>` — stack detail. Service list with per-service status (starting / healthy / initializing / ready / stopping / failed). Live log tail. Captured values (e.g., tunnel URLs). Stop / restart buttons.
- `/stacks/<id>/services/<name>` — per-service detail. Logs for just that service, env vars (with secrets masked), recent restarts.

Open-in-browser on first daemon start. `--no-browser` flag on `lich up` opts out. Subsequent starts don't reopen the browser.

### Friendly URLs

The reverse proxy listens on `runtime.proxy_port` (default 3300) and routes by `Host` header. URL shape:

```
http://<service>.<worktree>.lich.localhost:3300/
```

`*.localhost` resolves to `127.0.0.1` on modern OSes and browsers without any `/etc/hosts` editing or DNS configuration. Examples:

```
http://api.main.lich.localhost:3300/
http://web.main.lich.localhost:3300/
http://api.feature-x.lich.localhost:3300/
http://web.feature-x.lich.localhost:3300/
```

Routing entries come from the state directory; each stack writes its `<service>.<worktree>` → `localhost:<allocated_port>` mappings, and the proxy reloads on file change.

`lich urls` prints these by default. `lich urls --raw` also prints the underlying `localhost:<port>` URLs (useful for cases where the proxy interferes — websocket-heavy services, etc.).

The `:3300` port in the URL is mildly ugly. The way to eliminate it is binding the proxy to `:80`, which requires platform-specific setup (sudo, setcap, pf, etc.). Out of scope for v1.

## 7. Onramp

### Two pieces, clean split

The onramp is deliberately split into a dumb file-writer and a smart fill-in-the-blanks agent skill. Neither tries to do the other's job.

### `lich init` — dumb skeleton writer

A small command that writes three things and exits:

1. A `lich.yaml` skeleton in the current directory
2. A `.gitignore` entry for `.lich/` (creating or appending to existing)
3. (If absent) a comment-only `lich.yaml` schema reference for editor integration

The skeleton itself is minimal-but-valid: heavily commented, with each top-level section present as a commented-out example. A user can run `lich validate` against a freshly-`init`ed skeleton and get "ok, no services defined" — not an error. A user can run `lich up` against it and get "no services to start" — not a crash.

`lich init` does NOT detect frameworks, scan for compose files, guess at services, or read `package.json`. It writes the skeleton, period. This makes it trivial to test (one input, one fixed output), trivial to maintain (no framework-version drift), and predictable for users (the same skeleton every time).

The skeleton starts with a `# yaml-language-server: $schema=https://...` comment so editors with the YAML extension immediately get autocomplete and validation against the lich schema.

### `lich:instrument` — agent skill for filling it in

A Claude Code (and equivalent) skill that ships in the lich repo as a markdown file. This is THE intended path for taking an existing project from zero to working `lich.yaml`. Brownfield users — which is most users — should be pointed at this skill.

The skill walks an agent through:

1. Run `lich init` to produce the skeleton
2. Read the project's relevant files: `package.json` / `Gemfile` / `requirements.txt` / `go.mod`, any compose files, `.env.example`, README, any existing dev scripts
3. Fill in the skeleton with appropriate `services`, `owned`, `env`, `lifecycle`, ready conditions, and dependencies
4. Run `lich validate` and iterate until clean
5. Run `lich up` and verify the stack actually comes up
6. Show the user a diff and explanation

The skill is intentionally generic — no framework dictionary, no "if Next then X" rules. It's a translation task ("here's what this project already has; express it as a lich.yaml"), not a knowledge task. Framework-specific intelligence lives in the agent's general knowledge, not in lich's code.

The validate/edit/fix loop is the inner cycle that makes this reliable. `lich validate --json` gives the agent machine-readable errors; the agent edits the yaml; the agent re-validates. The skill doesn't ship to `lich up` until validate is clean.

### Greenfield vs brownfield

Same path for both. Greenfield users clone any starter they like (`create-next-app`, a Rails generator, a Django cookiecutter, etc.), then either run `lich init` and edit by hand, or invoke the `lich:instrument` skill to do it for them. Brownfield users do the same on their existing repo. There is no `create-lich-app` scaffolder — the demo lives in `examples/` inside the lich repo itself, available for cloning or copy-pasting the yaml from.

## 8. Meta-harness (dogfooding)

Lich is a tool agents use to build/test apps against real stacks. Building lich itself with agent help requires the same loop: agents need to verify their lich changes against a real lich-managed stack.

The pattern: **use lich to test lich.**

### `examples/`

The lich repo contains `examples/node-postgres/`: a small but real app — one Node web service, one Postgres container, a couple of env vars, one lifecycle hook for migrations. A working `lich.yaml`. Real code, real database, real HTTP.

Optionally additional small examples (`examples/python-postgres/`, `examples/go-mysql/`) to demonstrate framework-agnosticism. Each is a few hundred lines at most. None are published as packages; they're test fixtures and reference material.

### `tests/e2e/`

Integration tests that:
- Spawn the actual `lich` binary as a subprocess (not in-process module imports)
- Run against a copy of an example in a tmpdir worktree
- Wait for stack ready
- Hit the API, verify expected responses
- Hit endpoints that exercise the DB (proves env wiring + migrations worked)
- Run `lich logs api`, verify output
- Visit the dashboard URL, verify the stack appears
- Run `lich down`, verify clean teardown (no orphan processes, no leftover compose resources)
- Run a second `lich up` in a different tmpdir worktree, verify both coexist

Tests assert observable behavior at the CLI boundary, not internal logic. Failures emit specific diagnostics ("postgres healthcheck timeout after 30s; logs at <path>"), not generic test framework output.

`lich validate` gets its own focused test suite separate from the e2e suite: a corpus of known-good and known-bad yaml fixtures with expected validation outputs. Fast, hermetic, no real services involved — these tests run in seconds and gate every PR.

### `bin/dev-harness`

An agent-friendly entry point that runs the full e2e suite and prints structured pass/fail with diagnostics. Agents working on lich invoke this after their changes; output tells them whether they actually broke anything user-visible.

CI runs the same harness on every PR. A PR can't merge if the harness fails.

### Design check property

If using lich to test lich feels awkward, the design has problems. If it feels natural, the design is probably right. Treating the meta-harness as a first-class concern surfaces design pain early instead of after launch.

## 9. Implementation

### Language and runtime

**TypeScript on Bun**, compiled to a single binary via `bun build --compile`. Rationale:

- Author proficiency dominates velocity for a solo project
- Existing repo is TS; subsystems can be ported with light refactor
- Shared types between binary HTTP API and dashboard frontend
- Bun's single-binary compile satisfies the distribution constraint
- Bun's startup time (~5-50ms) is acceptable for a CLI

### Repo strategy

**Start a new `lich` repo.** Copy proven low-level subsystems from the current `levelzero` repo; rewrite user-facing surfaces fresh. The current repo becomes archived "v0 research."

Rationale: v1 architecture differs significantly enough that refactor-in-place would mean deleting >70% of code while still maintaining tests/imports for the deleted parts. Fresh repo gives a clean v1 launch and uses the natural branding-pivot moment.

### Project structure (proposed)

```
lich/
├── packages/
│   ├── core/                # the engine
│   │   ├── src/
│   │   │   ├── config/      # yaml parser, schema validation, interpolation
│   │   │   ├── worktree/    # detection, naming, state directory
│   │   │   ├── ports/       # allocator with file-lock
│   │   │   ├── compose/     # compose runner (CLI-agnostic)
│   │   │   ├── owned/       # owned-service runner
│   │   │   ├── env/         # env resolution pipeline
│   │   │   ├── lifecycle/   # hook executor
│   │   │   ├── ready/       # ready_when evaluators + capture
│   │   │   ├── deps/        # dependency graph + startup ordering
│   │   │   ├── state/       # on-disk state read/write
│   │   │   └── output/      # CLI output formatting (phased, colored)
│   │   └── bin/
│   │       └── lich.ts      # CLI entry point
│   └── daemon/              # background process (dashboard + proxy + watcher)
│       ├── src/
│       │   ├── dashboard/   # web UI server
│       │   ├── proxy/       # friendly-URL reverse proxy
│       │   └── watcher/     # state directory watcher
│       └── bin/
│           └── lich-daemon.ts
├── examples/
│   ├── node-postgres/
│   └── python-postgres/     # optional, demonstrates framework-agnosticism
├── tests/
│   ├── unit/
│   └── e2e/                 # spawn real binary, drive against examples
├── bin/
│   └── dev-harness          # agent-friendly e2e entry point
└── skills/
    └── lich-instrument.md   # agent onramp skill
```

### Subsystems to port from current repo

- Worktree detection and naming
- Port allocator with file-lock
- Compose runner (refactored to be compose-CLI-agnostic, not docker-specific)
- Owned-service runner (with concurrently-style multiplexing)
- Signal handlers (SIGINT cleanup; the LEV-199/LEV-203 work)
- Log file writers and aggregation
- Per-worktree state directory management
- Registry lock + stale-process detection

### Subsystems to write fresh

- Top-level CLI structure (new commands, new framing)
- YAML config parser + JSON Schema validation
- Interpolation engine (`${...}` resolution against runtime context)
- Env resolution pipeline (`env_files` + `env_from` + `env` + interpolation)
- `ready_when` evaluators including `log_match` + `capture`
- Lifecycle hook executor (top-level and per-service)
- Dependency graph + startup/shutdown ordering
- `lich init` (dumb skeleton writer — single fixed template plus `.gitignore` handling)
- `lich validate` (schema check + reference graph resolution + light filesystem checks; outputs `--json` for agent consumption)
- Daemon process (dashboard + proxy + watcher in one process)
- Reverse proxy with `*.localhost` routing
- Dashboard UI (adapted from current dashboard package, simplified for new state shape)
- Phased CLI output system

### Platform support

- **Mac (Apple Silicon and Intel):** first-class
- **Linux (x86_64 and arm64):** first-class
- **Windows:** WSL2 only. No native Windows support in v1. Native Windows may come in v1.x if there's demand; the implementation cost (signals, paths, child process semantics) doesn't earn its place for v1.

### Distribution

- **Single binary per platform** via `bun build --compile`, distributed through:
  - GitHub Releases (primary)
  - `npm install -g lich` (Bun-bundled binary, for the Node-ecosystem-installer-by-habit crowd)
  - Optionally Homebrew formula post-launch

No multi-package npm ecosystem. One binary, one install command.

## 10. Non-goals for v1

Explicitly out of scope:

- **Plugin system** — extension happens via shell-out (`env_from`, `lifecycle`, owned-service `cmd`). No `@lich/plugin-*` packages.
- **Helper / preset packages** — `lich.yaml` is the surface; copy from examples or write inline.
- **Scaffolder** — no `create-lich-app`. Users start from any starter and add `lich.yaml`.
- **Published templates** — `examples/` lives in the lich repo; not separately distributed.
- **Framework knowledge** — lich never knows what Next.js / Rails / Django is. Users provide their own startup commands.
- **TypeScript config format** — YAML only. No `lich.config.ts`.
- **Custom DSL** — YAML only. No Starlark, HCL, etc.
- **Live-update / file-watch orchestration** — Tilt's territory. Lich's stance: your dev server handles its own watching; cross-service triggers are lifecycle scripts.
- **K8s as a runtime** — compose-compatible runtimes only.
- **Validation tools** (impact graph, coverage analysis, route-coverage checks) — defer; not part of "stack orchestration."
- **Cross-machine sync / team sharing / auth** — local-only.
- **Cloud / preview environments / managed dashboard** — future commercial layer, not v1.
- **Real-time metrics / CPU+RAM charts on the dashboard** — v2.
- **Native Windows** — WSL2 only.
- **Agent attribution / "who started which stack"** — not needed for v1; can be added if user demand surfaces.

## 11. Open decisions

These need concrete choices during implementation, but don't change the spec's shape:

- **Log rotation policy.** Default: rotate at 10MB per service, retain 5 rotations, plus daily rotation regardless of size. Configurable in `runtime.logs`.
- **Daemon auto-shutdown timing.** Default: 30 seconds with no stacks before exit (3 checks at 10s intervals). Avoids races where `lich up` is mid-progress.
- **Schema validation strictness.** Default: strict mode (unknown keys are errors). `--lax` flag for forward-compat during yaml schema migrations.
- **Multiple stacks per worktree?** Default: one stack per worktree. Multi-stack per worktree is not a v1 feature (would require a `--stack <name>` qualifier on every command).
- **`oneshot` services in dashboard.** Show as a separate "Tasks" section with last-run status, or inline with services? Probably inline with a different icon.

## 12. Success criteria

### What "v1 ships" means

- One binary, downloadable from GitHub Releases for Mac (arm64+x86) and Linux (arm64+x86)
- `npm install -g lich` works for the Node crowd
- README walks a new user from zero to working stack in under 5 minutes (with the `examples/node-postgres/` example)
- `lich init` produces a valid skeleton that passes `lich validate` and survives `lich up` cleanly (with "no services defined" messaging)
- `lich:instrument` skill takes the `examples/node-postgres` repo (with its `lich.yaml` deleted) and reproduces a working configuration via agent loop, verified by `lich up` succeeding
- `lich:instrument` skill ships in the repo and works in Claude Code
- Dashboard is auto-started and auto-opens browser on first `lich up`
- Friendly URLs work without any setup beyond installing lich
- Meta-harness passes; CI runs it on every PR
- One blog post explaining the problem and the tool

### What "v1 is useful" means

In user-facing terms:
- A user with an existing repo can drop in `lich.yaml`, run `lich up`, and have it work
- That same user can `git worktree add ../feature-x feature-x && cd ../feature-x && lich up` and have a second isolated stack running
- They can read the dashboard to see what's happening across both stacks
- They can run `lich nuke` and confidently know everything is cleaned up

### Signals to track

- GitHub stars and watchers (rough adoption)
- Issues filed (engagement signal — issues mean people are trying it)
- Discord or similar discussion (depth of adoption)
- Whether the author (you) uses lich daily and prefers it to your bash scripts at work
- Whether second-degree users (your coworkers, friends) adopt without being pushed

### Decision gates

After v1 ships, gates for further investment:

- **3 months post-launch:** is anyone using it daily other than you? If no, debug the friction.
- **6 months:** is it stable and well-loved by the users who tried it? If yes, scope v1.x improvements based on real usage. If no, decide whether to fix root causes or move on.
- **12 months:** does the case for commercial extensions (preview envs, review bot, cloud dev envs) hold up given actual adoption? If yes, scope v2.

## Appendix A: The honest take on size

Realistic ceiling for the OSS tool alone: useful tool with low-thousands of regular users. Not a venture-scale outcome on its own.

Realistic ceiling with the full commercial vision (preview envs + review bot + cloud dev envs) over 5-7 years: $5-50M ARR business with excellent execution. Lifestyle / bootstrapped scale, not unicorn scale.

Realistic floor: works great for the author and a few power users. The author has a better tool than their bash scripts at work, and a few other people benefit.

All three outcomes are valid. The architecture supports the commercial path without committing to it; v1 should not bake in any decisions that foreclose later expansion (the yaml-as-spec, framework-agnostic, single-binary, no-cloud-dependency choices already preserve optionality).

## Appendix B: Mapping to current Linear backlog

For project-management convenience, this spec maps to or supersedes the following items in the current `levelzero` Linear project:

- **Supersedes / absorbs:** LEV-221 (rename), LEV-235 (README), LEV-237 (package structure), LEV-238 (verb rename), LEV-239 (binary), LEV-225 (typed-client replacement → moot), LEV-226 (portless → folded into daemon proxy), LEV-236 (instrument skill)
- **Cut / defer:** all new-plugin tickets (LEV-227–231), validation tools work, anything plugin-API-related
- **Influences:** dashboard work (LEV-240–249) lands largely as designed, with the auto-start/proxy additions noted above

Most of v0's 220 done tickets encoded learning that this spec preserves (worktree detection, port allocation, compose orchestration, lifecycle handling). The architecture is different; the engineering is largely transferable.
