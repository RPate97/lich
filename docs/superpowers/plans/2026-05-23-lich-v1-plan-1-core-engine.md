# Lich v1 — Plan 1: Core Engine

> **Status:** HIGH-LEVEL SHELL — task structure captured; per-task code/steps to be refined when this plan is ready to execute. Update freely as Plan 0 execution surfaces concrete details.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task once it's refined. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 3, 4, 5, 9)

**Required reading (every subagent on every task):** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md` — both tiers (unit + e2e) for every feature; e2e tests spawn the real binary against `examples/dogfood-stack/`.

**Goal:** Stand up the lich engine: parse YAML config, allocate worktree-scoped ports, run compose services (CLI-agnostic), supervise owned host processes, resolve env, evaluate ready conditions, order startup by dependencies, and expose the basic CLI surface. By end of plan, `lich up` against `examples/dogfood-stack/` brings the stack up and serves traffic, and `lich validate` passes against the target yaml.

**Builds on:** Plan 0 (packages/lich/ skeleton, examples/dogfood-stack/, tests/e2e/ infrastructure)

**Architecture:** Engine is a single TypeScript package compiled to a single binary. Internal modules under `packages/lich/src/` for each subsystem (config, worktree, ports, compose, owned, env, ready, deps, state, output). Each subsystem has clear inputs/outputs and is unit-testable in isolation. The CLI commands compose these subsystems via a top-level orchestrator that runs the `lich up` lifecycle.

**Tech stack:** TypeScript on Bun, `yaml` for parsing, `ajv` for JSON Schema validation, `concurrently` for owned-service spawning, native `child_process` for compose shell-outs, `node:net` for TCP probes, `proper-lockfile` (or equivalent) for the port allocator's file lock.

---

## What this plan implements

From the spec:

- **Config schema** (section 4): `services`, `owned`, `env`, `env_files`, `env_from`, `lifecycle` (top-level + per-service basic shape), `runtime`. Profiles, `env_groups`, `commands` come in Plans 2-3.
- **Per-worktree isolation** (section 3): unique compose project name, allocated host ports, per-worktree state directory under `~/.lich/stacks/<id>/`.
- **CLI** (section 5): `up`, `down`, `logs`, `urls` (raw URLs only — friendly URLs in Plan 5), `stacks`, `nuke`, `validate`, `init`.
- **Compose runner** (section 4): shell out to `docker compose` / `podman compose` / `nerdctl compose` based on `runtime.compose`. Generate per-worktree override file with project name + port mappings.
- **Owned services** (section 4): host processes via concurrently; `port: { env: PORT }` single-port shape and `ports: { ... }` multi-port shape; `oneshot: true` + `stop_cmd:` for self-managing tools like Supabase.
- **Ready conditions** (section 4): `http_get`, `tcp`, `log_match` basics (no `capture:` yet — Plan 4). `ready_when.timeout` deferred to Plan 4.
- **Dependencies** (section 4): `depends_on` across compose/owned boundary; startup ordering respects the graph.
- **Env resolution** (section 4): top-level `env` literals, `env_files`, `env_from` shell-out (dotenv and JSON formats). Per-service overrides. Interpolation (`${services.X.host_port}`, `${owned.X.port}`, `${owned.X.ports.<name>}`, `${worktree.name}`, `${worktree.path}`, `${worktree.id}`). Auto-exported `LICH_WORKTREE` and `LICH_STACK_ID` (not `LICH_PROFILE` yet — profiles in Plan 3).
- **Lifecycle hooks** (section 4): top-level `before_up`, `after_up`, `before_down`. Per-service `lifecycle.before_start`, `lifecycle.after_ready`, `lifecycle.before_down`. (Profile-scoped lifecycle deferred to Plan 3.)

Out of scope for this plan (defer to later):

- `env_groups`, user-defined `commands`, `lich help/exec/env` (Plan 2)
- `profiles` (Plan 3)
- `fail_when`, `ready_when.timeout`, `ready_when.capture`, automatic exit detection beyond basic process-exit logging (Plan 4)
- Daemon, dashboard, reverse proxy, friendly URLs (Plan 5)
- `lich:instrument` skill (Plan 6)

---

## Subsystems introduced

Each lives under `packages/lich/src/<name>/` and gets its own unit test suite.

### `config/`

YAML parsing + JSON Schema validation + interpolation engine.

- `parse.ts` — read `lich.yaml`, parse to typed structure
- `schema.ts` — JSON Schema for the v1 yaml shape (subset implemented in this plan; extended in later plans)
- `interpolation.ts` — resolve `${...}` references against a runtime context, lazy and per-key
- `validate.ts` — schema check + reference graph resolution + light filesystem checks; produces structured errors with `file:line:col`

### `worktree/`

Detect the current worktree, derive a stable id and human-readable name. Port from v0 `packages/core/src/worktree.ts` with light refactor.

- Inputs: cwd
- Outputs: `{ name, id, path }` where id is a deterministic hash (worktree path or repo+branch)

### `ports/`

File-locked port allocator. Each `lich up` requests N ports for its stack; the allocator picks a free range, records it in `~/.lich/ports/`, and returns the assignments. Port from v0 `packages/core/src/ports/` and `registry-lock.ts`.

- File lock ensures two concurrent `lich up`s don't collide
- Release on `lich down`/`nuke`; stale-lock detection on startup

### `state/`

On-disk per-worktree state under `~/.lich/stacks/<stack-id>/`:
- `state.json` — snapshot of current stack (services, allocated ports, status, started_at)
- `logs/<service>.log` — per-service log files (rotated; rotation in Plan 4 polish)
- `env/<service>.env` — generated env file for each service (used by compose)

### `compose/`

CLI-agnostic compose runner. Detect which compose CLI is available (`docker compose`, `podman compose`, `nerdctl compose`); shell out with `-p <project-name>` and a generated override file.

- `detect.ts` — find an available compose CLI
- `runner.ts` — wrap the CLI with up/down/ps/logs operations
- `override.ts` — generate the per-worktree override yaml (project name, host port assignments)

### `owned/`

Host-process supervisor built on `concurrently`. Spawn processes with the resolved env, capture stdout/stderr to per-service log files, monitor for ready and exit, support `oneshot` + `stop_cmd`. Port from v0 `packages/core/src/owned/` with refactor for multi-port and oneshot.

### `env/`

Env resolution pipeline. Layers top-level → per-service per-key with later layers winning. Resolves `env_from` shell-out commands; reads `env_files`. Performs interpolation against the runtime context.

### `ready/`

`ready_when` evaluators:
- `http_get.ts` — poll an HTTP endpoint until 2xx
- `tcp.ts` — TCP connect until success
- `log_match.ts` — regex against accumulated log buffer
- Each has a polling loop; final timeout handling deferred to Plan 4

### `deps/`

Dependency graph computation + topological order for startup. Inputs: services + owned + their `depends_on` declarations. Output: ordered list of service names (with parallel groups within levels).

### `output/`

Phased CLI output framework. Spinners, colored status indicators, phased progress for `lich up`, final summary. `--quiet` and `--json` modes.

### `lifecycle/`

Hook executor. Runs shell commands with the resolved env in the right cwd; tracks success/failure; aborts the up/down sequence on hook failure (top-level + per-service `before_start` / `after_ready`); logs and ignores failures for `before_down` / `after_run`.

### `commands/` (CLI commands)

Each command is its own file: `up.ts`, `down.ts`, `logs.ts`, `urls.ts`, `stacks.ts`, `nuke.ts`, `validate.ts`, `init.ts`. The CLI dispatcher (already in place from Plan 0) wires them in.

---

## File structure delta

```
packages/lich/src/
  config/
    parse.ts
    schema.ts
    interpolation.ts
    validate.ts
  worktree/
    detect.ts
  ports/
    allocator.ts
    file-lock.ts
  state/
    directory.ts
    snapshot.ts
  compose/
    detect.ts
    runner.ts
    override.ts
  owned/
    runner.ts
    supervisor.ts
  env/
    resolve.ts
    files.ts
    shell-out.ts
  ready/
    http-get.ts
    tcp.ts
    log-match.ts
  deps/
    graph.ts
    sort.ts
  output/
    phased.ts
    colors.ts
  lifecycle/
    executor.ts
  commands/
    up.ts
    down.ts
    logs.ts
    urls.ts
    stacks.ts
    nuke.ts
    validate.ts
    init.ts
  errors.ts             # shared error types
  
packages/lich/tests/unit/
  config/
  worktree/
  ports/
  state/
  compose/
  owned/
  env/
  ready/
  deps/
  lifecycle/
  commands/

tests/e2e/
  up-basic.test.ts                # extends existing basic-up.test.ts
  validate.test.ts                # new
  down.test.ts                    # new
  logs.test.ts                    # new
  parallel-stacks.test.ts         # new — REQUIRED sentinel per testing standards
```

---

## Task list (high-level — refine to bite-sized when ready to execute)

Order roughly matches build dependencies — earlier tasks unblock later ones. Many tasks within can run in parallel under the orchestrator once their inputs are in place.

1. **JSON Schema for v1 yaml (subset for this plan)** — covers `services`, `owned`, `env`, `env_files`, `env_from`, `lifecycle`, `runtime`. Used by both validate and parse.
2. **YAML parser** — load and parse `lich.yaml` to typed structure; validate against schema.
3. **`lich validate` command** — schema check + structured error output (incl `--json`). Tests use known-good/known-bad fixtures.
4. **Worktree detection** — port from v0; verify still works across git versions.
5. **Port allocator** — port from v0; verify file-lock semantics under parallel.
6. **State directory management** — per-worktree dir creation, snapshot read/write, log file paths.
7. **Compose CLI detection + runner** — refactor v0 compose code to support `runtime.compose` choice.
8. **Compose override generator** — produce the YAML that adds project name + port mappings to the user's compose file.
9. **Owned-service runner (basic)** — single-port shape via concurrently; per-service log files.
10. **Owned-service runner (multi-port + oneshot + stop_cmd)** — extend for Supabase/LocalStack-style services.
11. **Env file loading (`env_files`)** — read dotenv files relative to project root; merge.
12. **Env shell-out (`env_from`)** — exec the command, parse dotenv or JSON, merge.
13. **Env resolution pipeline** — combine literals + files + shell-out + per-service overrides; per-key precedence.
14. **Interpolation engine** — `${...}` resolution against runtime context with lazy per-key evaluation.
15. **Ready evaluators: `http_get`** — polling http GET, success on 2xx.
16. **Ready evaluators: `tcp`** — TCP connect probe.
17. **Ready evaluators: `log_match`** — regex against accumulated log buffer (without capture for now).
18. **Dependency graph + topological sort** — input `depends_on` declarations across compose+owned; output ordered groups.
19. **Top-level lifecycle hook executor** — `before_up`, `after_up`, `before_down`; shell command runner with env injection.
20. **Per-service lifecycle hooks** — `before_start`, `after_ready`, `before_down`; per-service variants of the executor.
21. **Phased CLI output framework** — `output/` module: spinners, status icons, phase boundaries, final summary, `--quiet`, `--json`.
22. **`lich init` command** — dumb skeleton writer; `.gitignore` entry; schema reference comment.
23. **`lich up` command (integration)** — wires everything: parse → validate → allocate ports → write override → start compose → wait healthy → start owned → wait ready → run hooks → print summary.
24. **`lich down` command** — read state → run before_down hooks → stop owned → stop compose → release ports → clear state.
25. **`lich logs` command** — read per-service log files; tail with follow.
26. **`lich urls` command** — read state, print raw `localhost:<port>` URLs for each service. (Friendly URLs come in Plan 5.)
27. **`lich stacks` command** — list all stacks on the machine from `~/.lich/stacks/*/state.json`.
28. **`lich nuke` command** — stop everything, clean state directories.
29. **E2e tests: parallel stacks sentinel** — REQUIRED per testing standards; two tmpdirs with the dogfood-stack, both `lich up`, both serve traffic on different ports, no collisions.
30. **E2e tests: lich up basic** — the existing `basic-up.test.ts` second test (`lich validate succeeds`) turns green; the first test (`brings the stack up and serves the web app`) turns green once friendly URLs land in Plan 5 — but a `--raw` variant should pass here.
31. **E2e tests: lich down clean teardown** — no orphan processes, no orphan containers.
32. **E2e tests: lich logs filtering** — per-service log filter works.

---

## Cross-plan dependencies (which Plan 0 tasks must be done first)

- **All of Plan 0** must be complete before any Plan 1 task starts. Plan 1 builds inside the skeleton Plan 0 set up.
- Specifically Plan 0 Tasks 1-5 (lich package skeleton + CLI scaffolding) gate Plan 1 Tasks 1-3.
- Plan 0 Tasks 6-12 (dogfood-stack) gate any e2e test in Plan 1 (Tasks 29-32).
- Plan 0 Tasks 13-17 (e2e test infrastructure) gate Plan 1 Tasks 29-32 directly.

---

## Testing requirements (per testing standards)

Every feature needs BOTH unit tests AND e2e tests. For Plan 1 specifically:

- **Unit tests** for: YAML parsing, schema validation, interpolation resolution, port allocation logic, dependency graph computation, env resolution layering, lifecycle hook executor, each ready evaluator.
- **E2e tests** for: `lich validate` against the dogfood-stack yaml (passes), `lich up` against the dogfood-stack (services started, healthy, in correct order, lifecycle hooks ran, env wired correctly), `lich down` (clean teardown), parallel stacks (REQUIRED sentinel), `lich logs` (per-service filtering), `lich urls --raw` (URLs are reachable), `lich stacks` (lists running stacks).
- **Failure-case e2e tests**: invalid yaml exits non-zero with file:line:col error; missing required field caught; cyclic `depends_on` caught.

The "deliberately broken yaml" failure-case tests (port in use, exit 1 immediately, never becomes ready, etc.) move to Plan 4 — that plan adds `fail_when`, `ready_when.timeout`, and the full failure UX.

---

## Acceptance criteria

Plan 1 is done when:

- `lich validate examples/dogfood-stack/lich.yaml` exits 0 with no output
- `lich up` from inside `examples/dogfood-stack/` (using a tmpdir copy) brings the stack up: Supabase starts, migrations run via `after_up`, seed runs via `after_up`, Express API connects to Supabase, Next.js connects to API
- `curl http://localhost:<api-port>/api/things` returns the seeded 3 rows
- `curl http://localhost:<web-port>/` returns HTML that renders the things
- `lich logs api` shows the API's stdout
- `lich stacks` shows the running stack
- `lich down` cleanly stops everything (verified by `docker ps` empty and no host processes lingering)
- Two parallel `lich up` invocations from two different tmpdirs both succeed; both stacks serve traffic on different ports
- All e2e tests in `tests/e2e/` pass except `basic-up.test.ts`'s "brings the stack up and serves the web app" test which is gated on Plan 5's friendly URLs

When all of the above hold, Plan 1 ships. Plan 2 starts.
