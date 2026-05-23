# Lich v1 — Testing Standards

**Status:** Required reading for all v1 implementation work (humans and agents).
**Companion to:** `2026-05-23-lich-v1-design.md` (the product spec) and `../plans/2026-05-23-lich-v1-plan-0-foundation.md` (the foundation plan that establishes the test infrastructure).

This document defines HOW we test lich v1. It is not optional. Every implementation plan and every individual task that adds or modifies behavior MUST follow it.

---

## The Rule (read this first)

**Every feature requires BOTH:**

1. **Unit tests** that verify internal correctness (pure functions, parsers, resolvers, state machines).
2. **End-to-end tests** that spawn the real `lich` binary, drive it against the real `examples/dogfood-stack/`, and assert observable behavior.

A feature is not complete until both tiers exist, run in CI, and pass.

**Writing one tier without the other is a bug.** Specifically:

- Unit tests without e2e tests: you've verified the internals work in isolation but have no proof the feature actually works through the CLI. Most of lich's value lives at the boundary between processes; this is exactly where shallow testing misses real bugs.
- E2e tests without unit tests: you can't pinpoint regressions and refactoring becomes scary because you don't know what's safe to change.

Both. Every feature. Non-negotiable.

---

## Why this matters for v1

In v0 (`levelzero`), agents produced code that passed tests but didn't actually work end-to-end. The pattern was: tests verified internal functions returned the right shape, but the compiled binary failed in subtle ways the tests didn't catch (signal handling, process lifecycle, real docker interactions, port conflicts, file path issues, etc.).

The fix is not "write more tests." The fix is **drive the real binary against the real example and assert the actual observable outcomes**, the same way a user would.

If a test passes but a human running `lich up` against the dogfood stack would see different behavior, **the test is wrong**, regardless of what it asserts.

---

## Where tests live

```
packages/lich/tests/unit/         # unit tests — fast, hermetic, no subprocess, no docker
tests/e2e/                        # e2e tests — spawn real binary, real docker, real example app
tests/e2e/helpers/                # shared helpers: tmpdir, lich spawn, wait conditions
examples/dogfood-stack/           # the failing test case — Next + Express + Supabase + migrations + seed
```

Run unit tests:
```bash
cd packages/lich && bun test
```

Run e2e tests:
```bash
cd tests/e2e && bun test
```

Both must pass before any commit that adds or modifies behavior.

---

## Unit tests: what they cover

Unit tests live in `packages/lich/tests/unit/<module>/<feature>.test.ts` mirroring the source layout. They:

- Test pure functions (config parsers, schema validation, env resolution, port allocator math, dependency graph computation, regex matchers, etc.)
- Run in milliseconds, all together in under 5 seconds
- Do NOT spawn subprocesses
- Do NOT touch docker
- Do NOT use real network or filesystem outside of `tmpdir` for transient state
- Are deterministic — running them 100 times in a row produces identical results

If a function does I/O (filesystem, network, subprocess), wrap the I/O behind an interface and unit-test the pure logic. Drive the I/O code paths via e2e tests where the real I/O is intentional.

### Unit test recipe

```typescript
import { describe, it, expect } from "vitest";
import { resolveProfile } from "../../src/profiles/resolve.js";

describe("resolveProfile", () => {
  it("resolves extends chain and computes union of services", () => {
    const config = {
      profiles: {
        base: { services: ["postgres"], owned: ["api"] },
        full: { extends: "base", services: ["redis"], owned: ["worker"] },
      },
    };
    const result = resolveProfile("full", config);
    expect(result.services).toEqual(["postgres", "redis"]);
    expect(result.owned).toEqual(["api", "worker"]);
  });

  it("detects cycles in extends chain", () => {
    const config = {
      profiles: {
        a: { extends: "b" },
        b: { extends: "a" },
      },
    };
    expect(() => resolveProfile("a", config)).toThrow(/cycle/i);
  });
});
```

Good unit tests:
- Test ONE behavior per `it()` block
- Have descriptive names (`resolves extends chain and computes union of services`, not `test1`)
- Test both happy path AND error path
- Include edge cases (empty input, missing fields, etc.)

---

## End-to-end tests: what they cover

E2e tests live in `tests/e2e/<feature>.test.ts`. They:

- Spawn the **actual compiled `lich` binary** via the `spawnLich` / `runLich` helpers
- Copy `examples/dogfood-stack/` to a tmpdir via `copyExampleToTmpdir`
- Run real `docker compose`, real `supabase`, real `bun run dev`
- Assert observable behavior the way a user would observe it (HTTP responses, log content, exit codes, file existence, docker resource visibility, port reachability)
- Are slower (seconds to minutes per test) — vitest config gives them generous timeouts (default 120s per test)
- Run serially (single-fork pool) to avoid docker resource contention

E2e tests are NOT optional and are NOT a nice-to-have. They are the proof that the feature works.

---

## What every command's e2e tests MUST verify

The list below is the floor for e2e coverage. Each command's test suite must include tests for the categories that apply to that command. Tests for additional behavior beyond this list are welcome; tests that skip these categories are incomplete.

### For `lich up`

- **Correct services started.** After `lich up` succeeds, every service listed in the resolved profile is running. Verify via `docker compose ps` (for compose services) and process listing / TCP probe (for owned services). Services NOT in the profile are NOT running.
- **Services are healthy.** Every started service's `ready_when` condition is verified to actually pass (curl the http endpoint, connect to the TCP port, etc.). Not just "lich reported them ready" — verify independently.
- **Started in correct order.** When `depends_on` is declared, services start in the right order. Verify by reading the per-service log timestamps OR by asserting that the dependent service couldn't have started successfully before its dependency was ready (e.g., the api's startup log shows successful DB connection, which is only possible if postgres was ready first).
- **Lifecycle hooks ran.** `after_up` hooks completed. Verify the side effect (migration applied → table exists; seed run → rows exist).
- **Env vars wired correctly.** The API can talk to the DB (verified by hitting an endpoint that queries the DB). The web can talk to the API (verified by fetching a page that renders DB data).
- **Targeted the correct stack.** Resources are namespaced by worktree. Compose project name includes the worktree hash. State directory under `~/.lich/stacks/<this-stack-id>/` exists; OTHER stack directories are NOT touched.
- **Exit code is 0 on success, non-zero on failure.** Verify both directions.
- **Output is useful.** `lich up` printed phased progress and a final summary with URLs. Verify the URLs are reachable.

### For `lich down`

- **All services stopped.** No leftover docker containers (compose services), no leftover host processes (owned services). Verify via `docker compose ps` (empty) and process listing.
- **No orphan resources.** No leftover networks, volumes (per-worktree state in `~/.lich/stacks/<id>/` is preserved; docker volumes for the compose project are removed unless declared persistent).
- **State directory updated.** Stack is marked stopped in the on-disk state; subsequent `lich stacks` shows it as stopped (or absent).
- **Other stacks untouched.** If another stack was running in a different worktree, `lich down` from this worktree does NOT affect it. Verify by checking the other stack is still up after this `lich down`.
- **`before_down` lifecycle ran.** Side effects verified.

### For `lich logs`

- **Returns content from the correct stack.** Run from the worktree's directory; logs returned belong to this stack, not another.
- **Per-service filtering works.** `lich logs api` returns only the api's logs.
- **Streaming follows new lines.** When the service writes a new log line, the streaming output picks it up within a small delay.

### For `lich urls`

- **Returns reachable URLs.** Every URL printed is verified to actually serve traffic (HTTP 200 from the web URL, etc.).
- **Friendly URLs follow the `<service>.<worktree>.lich.localhost:<proxy-port>` pattern.**
- **`--raw` returns the underlying `localhost:<allocated-port>` URLs**, which are also reachable.

### For `lich stacks`

- **Lists every running stack on the machine.** Start two stacks in two tmpdirs; `lich stacks` from either shows both. Stop one; the next `lich stacks` shows only the remaining.
- **Includes worktree name, status, uptime.**

### For `lich nuke`

- **All stacks down.** After `lich nuke`, `lich stacks` is empty. No running docker containers from any lich stack remain.
- **Cleans up state directories.** `~/.lich/stacks/` is empty (or only contains genuinely-broken state that nuke couldn't clean).

### For `lich restart`

- **Whole-stack restart:** all services stopped then started. New PIDs.
- **Selected services:** only the named services restart. Others keep their PIDs.
- **`--owned` / `--compose`:** only owned / only compose services restart.
- **Dependency-respecting:** restart order matches `depends_on`.

### For `lich validate`

- **Exit 0 for a valid yaml.** No stderr output.
- **Exit non-zero for invalid yaml.** Stderr contains the specific issue with file:line:col context.
- **Catches each category of error:** missing required field, unknown field (strict mode), invalid reference (`depends_on` to nonexistent service), invalid `env_group` reference, cycle in `extends`, regex compile failure in `ready_when.log_match` or `fail_when.log_match`.

### For `lich init`

- **Writes a valid skeleton.** The output file passes `lich validate` immediately.
- **Survives `lich up`.** A freshly-init'd skeleton with no services defined produces a clean "no services to start" message and exits 0.
- **Idempotent.** Running `lich init` twice in the same directory does not overwrite an existing `lich.yaml` (or does so only with `--force`).
- **Adds `.lich/` to `.gitignore`** without duplicating if already present.

### For `lich exec` / `lich env` / `lich help`

- **`lich exec <cmd>` runs the command with the resolved env loaded.** Verify by execing a command that prints an env var (`lich exec sh -c 'echo $DATABASE_URL'`) and asserting the output matches the expected resolved value.
- **`lich exec --env-group=<g>` uses the named group's env**, not the default.
- **`lich env <g>` prints dotenv-formatted output** that can be `source`d in a shell.
- **`lich help` lists all built-in and user-defined commands** with their summaries; `lich help <cmd>` shows the per-command help text.

### For user-defined commands

- **A defined command is invokable via `lich <name>`.**
- **Extra argv is forwarded to the underlying shell command.**
- **`env_group` override flag works** (`lich <name> --env-group=<other>` runs with the named group's env).
- **Unknown command emits a useful error** (`Did you mean ...?` suggestion is nice-to-have).

### For profiles

- **`lich up` (no arg) activates the default profile.**
- **`lich up <profile>` activates the named profile.**
- **`lich up <bad-name>` exits non-zero with a clear error.**
- **Profile resolution honors `extends`.** Verify the resolved service set matches the union of the chain.
- **Switching profiles while a stack is up is refused** with a clear error.
- **Services not in the active profile do NOT start.** Even if they're defined in `services:` or `owned:`.

### For env_groups

- **Default group `stack` includes top-level env + interpolated runtime values.**
- **User-defined groups don't include `stack`** unless they `extends: stack`.
- **`extends` chain resolves correctly** (parent vars present, child vars override).
- **`process_env: false` blocks shell env passthrough.** Verify by setting an env var in the test shell and asserting it does NOT appear in `lich env <group>` output for a group with `process_env: false`.

### For failure detection

- **Process exit failure is detected.** Define an owned service whose `cmd` exits immediately with code 1. `lich up` aborts, prints the failure, exits non-zero. Last log lines are inline in the output.
- **`ready_when.timeout` fires.** Define a service whose `cmd` runs but never satisfies `ready_when` within the timeout. `lich up` aborts after the timeout.
- **`fail_when.log_match` fires.** Define a service that logs a matching pattern but doesn't exit. `lich up` aborts.
- **Dashboard reflects failure** (if dashboard exists in this tier yet).

### For worktree isolation (cross-cutting)

- **Two worktrees, same project, no port collisions.** Copy the example to two tmpdirs. `lich up` in both. Both stacks start successfully. Verify both web URLs return 200; both API URLs return 200; the two postgres containers have different host ports.
- **State directories don't collide.** Each worktree's `~/.lich/stacks/<id>/` is distinct.
- **Compose project names don't collide.** `docker compose ps` shows two separate projects.
- **`lich down` in one worktree leaves the other running.** Verified by stack count and process count before/after.

---

## The e2e test recipe (template every test follows)

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich, spawnLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";
import type { ChildProcess } from "node:child_process";

let cleanup: (() => void) | null = null;
let lichProc: ChildProcess | null = null;

afterEach(async () => {
  // Always tear down the lich process first to release resources cleanly
  if (lichProc) {
    // SIGINT mimics Ctrl-C; lich's signal handler should clean up
    lichProc.kill("SIGINT");
    // Give it time to tear down docker resources
    await new Promise<void>((r) => setTimeout(r, 3000));
    lichProc = null;
  }
  // Then remove the tmpdir
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

describe("<feature>", () => {
  it("<observable behavior>", async () => {
    // ARRANGE: copy the example to a fresh tmpdir
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    cleanup = cleanupFn;

    // ACT: spawn lich and wait for it to do whatever this test verifies
    lichProc = spawnLich(["up"], { cwd: path });

    // Assert that the observable outcome holds. Use real probes:
    await waitForHttp200("http://localhost:4000/health", { timeoutMs: 60_000 });

    // ASSERT: verify the actual outcomes the test cares about
    const things = await fetch("http://localhost:4000/api/things").then((r) =>
      r.json()
    );
    expect(things).toHaveLength(3); // proves DB seeding ran
    expect(things[0].name).toBeTruthy(); // proves wiring works
  });
});
```

Notice:
- **Real HTTP fetches** (not mocked) — proves the stack actually serves traffic
- **Real expectations on data** (not just "did the request succeed") — proves the end-to-end flow worked
- **`afterEach` always cleans up** — no leaked processes or directories
- **Generous timeouts** — e2e is slow; failures should be timeouts at the wait, not at the test framework

---

## Required parallel-stack test

Every plan that touches stack lifecycle (up, down, restart) MUST include this test or an equivalent:

```typescript
it("two parallel stacks coexist without colliding", async () => {
  const a = copyExampleToTmpdir("dogfood-stack");
  const b = copyExampleToTmpdir("dogfood-stack");
  cleanup = () => {
    a.cleanup();
    b.cleanup();
  };

  const procA = spawnLich(["up"], { cwd: a.path });
  const procB = spawnLich(["up"], { cwd: b.path });

  try {
    // Both stacks must come up. Use the friendly URL convention or
    // discover the allocated ports via `lich urls --raw`.
    const urlsA = JSON.parse(
      runLich(["urls", "--json"], { cwd: a.path }).stdout
    );
    const urlsB = JSON.parse(
      runLich(["urls", "--json"], { cwd: b.path }).stdout
    );

    // The allocated ports MUST differ
    expect(urlsA.api.port).not.toBe(urlsB.api.port);
    expect(urlsA.web.port).not.toBe(urlsB.web.port);

    // Both URLs respond
    await waitForHttp200(`http://localhost:${urlsA.api.port}/health`);
    await waitForHttp200(`http://localhost:${urlsB.api.port}/health`);

    // Hitting A's API returns A's stack's data; same for B
    const thingsA = await fetch(`http://localhost:${urlsA.api.port}/api/things`).then(r => r.json());
    const thingsB = await fetch(`http://localhost:${urlsB.api.port}/api/things`).then(r => r.json());
    expect(thingsA).toHaveLength(3);
    expect(thingsB).toHaveLength(3);
  } finally {
    procA.kill("SIGINT");
    procB.kill("SIGINT");
    await new Promise<void>((r) => setTimeout(r, 5000));
  }
});
```

If this test passes, the core worktree-isolation premise of lich is working. If it fails, lich's primary value proposition is broken. Treat this test as a sentinel.

---

## TDD workflow per feature

For each implementation task that adds a feature:

1. **Read the spec section** that defines the feature.
2. **Write the failing unit test(s)** for the smallest internal contract you can identify.
3. **Run** — verify they fail with a meaningful error (not a syntax error). If they pass already, you misunderstood the contract; revise.
4. **Write the failing e2e test(s)** for the observable behavior the feature delivers.
5. **Run** — verify the e2e test also fails. Now you have a target on both axes.
6. **Implement** the minimum to make the unit tests pass.
7. **Run unit tests** — verify they pass.
8. **Implement** the wiring to make the e2e test pass (often this means hooking the unit-tested logic into the CLI / runtime).
9. **Run e2e tests** — verify they pass.
10. **Run BOTH** test suites together — verify nothing regressed.
11. **Refactor** if needed; both suites stay green.
12. **Commit** with a clear message naming the feature.

If at step 9 the e2e test still fails despite passing unit tests, **the gap between unit and e2e is exactly where lich's real bugs live**. Debug there. Don't paper over it with more unit tests.

---

## Anti-patterns to avoid

These are bugs in the test design. Subagents should refuse to ship code with these patterns.

### "It compiled" testing

```typescript
// ❌ BAD: only checks the process didn't crash
const result = runLich(["up"], { cwd: path });
expect(result.exitCode).toBe(0);
// ... nothing else
```

Exit code 0 tells you nothing about whether the feature actually worked. Always assert on observable outcomes (HTTP response, file content, log output, database state, etc.).

### Mock-the-CLI testing

```typescript
// ❌ BAD: doesn't actually run the binary
import { handleUp } from "../../packages/lich/src/commands/up.js";
const result = await handleUp({ /* fake args */ });
expect(result.ok).toBe(true);
```

The whole point of e2e tests is to verify the binary behaves correctly. Bypassing it via direct module imports defeats the purpose. Use `spawnLich` / `runLich` always for e2e.

### Stateful tests

```typescript
// ❌ BAD: test 2 depends on test 1's state
let stackPath: string;
it("starts the stack", () => {
  stackPath = copyExampleToTmpdir(...).path;
  // start it...
});
it("checks the stack is up", () => {
  // uses stackPath from previous test — fragile, can't reorder
});
```

Every e2e test is self-contained. Setup happens in the test or in `beforeEach`. Teardown in `afterEach`. No shared mutable state between tests.

### Cleanup-on-success-only

```typescript
// ❌ BAD: if the test fails before cleanup, processes leak
it("does the thing", async () => {
  const proc = spawnLich(["up"], { cwd: path });
  await waitForHttp200(url); // ← if this throws, proc is never killed
  expect(...);
  proc.kill();
});
```

Always put teardown in `afterEach`, not inline at the end of the test. Use the `let lichProc: ChildProcess | null = null` pattern from the recipe so `afterEach` can always reach the process.

### Asserting on lich's own output instead of actual outcomes

```typescript
// ❌ BAD: trusts lich's report that things worked
expect(result.stdout).toContain("Stack ready");

// ✓ GOOD: independently verifies things actually work
await waitForHttp200("http://localhost:4000/health");
const data = await fetch("http://localhost:4000/api/things").then(r => r.json());
expect(data).toHaveLength(3);
```

Lich claiming "stack ready" is necessary but not sufficient. The test should hold lich to the higher bar of "the stack actually serves traffic." If lich's output and reality disagree, the test catches it.

### Sleep-based waits

```typescript
// ❌ BAD: flaky, slow, masks real timing bugs
spawnLich(["up"], { cwd: path });
await sleep(15_000);
expect(/* something */);
```

Use the `wait*` helpers (`waitForHttp200`, `waitForTcpOpen`) which poll with timeouts. Sleeps are flaky on slow CI and slow locally; waits succeed as soon as the condition is met.

### Ignoring the parallel-stack case

If you're testing stack lifecycle and you don't have a parallel-stacks test, you don't have the test. Worktree isolation is THE differentiator of lich. Every stack-lifecycle feature must verify it doesn't break parallel.

---

## Resource cleanup contract

E2e tests start docker containers, host processes, and write files. They MUST leave the system clean after running. Specifically:

- **No leftover docker containers** from this test. Verify via `docker ps -a --filter "label=lich.test=<test-id>"` (lich tags resources with the stack id, which derives from the worktree, which is the tmpdir).
- **No leftover host processes.** Test cleanup must kill any spawned lich subprocesses (which in turn kill their owned services).
- **No leftover tmpdirs.** The `copyExampleToTmpdir` helper returns a `cleanup` function; tests must call it (in `afterEach`).
- **No leftover state in `~/.lich/`.** If a test creates state entries that don't get cleaned by `lich down` or `lich nuke`, the test must clean them manually.

If a test leaves resources behind, subsequent tests may collide and fail spuriously. The CI's first run after such a test will look like a new bug. **Leaving leaks is a test bug, not an infrastructure problem.**

Tests can verify their own cleanliness:

```typescript
afterEach(() => {
  // ... standard cleanup ...
  // Verify nothing leaked
  const containers = execSync("docker ps -a --filter label=lich.worktree=" + testId).toString();
  expect(containers.split("\n").filter(Boolean)).toHaveLength(1); // header only
});
```

---

## Test naming

- Files: `<feature>.test.ts`. Examples: `up-basic.test.ts`, `up-profiles.test.ts`, `validate-cycle-detection.test.ts`, `parallel-stacks.test.ts`.
- `describe` blocks: the feature or command being tested.
- `it` blocks: complete sentences describing the observable behavior, starting with a verb. Examples:
  - `"brings the stack up and serves the web app"` ✓
  - `"refuses to switch profiles while a stack is running"` ✓
  - `"test1"` ❌
  - `"up command"` ❌

Good test names make CI failures instantly diagnosable. A subagent reading a CI failure should know what's broken without opening the file.

---

## CI gating

Both test suites MUST pass before any commit:

```bash
cd packages/lich && bun test            # unit tests
cd tests/e2e && bun test                # e2e tests
```

If you're adding a feature and the e2e test you wrote fails, that's the expected starting state. Implement until both pass. Don't merge with failing tests unless they are the documented "failing test case" (`tests/e2e/basic-up.test.ts` until Plan 5+ completes the friendly URL piece).

---

## Specific guidance for subagents

When dispatched to implement a task:

1. **Read this document fully** before starting any implementation.
2. **Read the spec section** for the feature you're adding.
3. **Read the plan task** carefully — it tells you what files to touch and what code to write.
4. **Write tests in the order:** unit first (fastest feedback), then e2e (proof of correctness).
5. **Run tests after each edit.** Don't accumulate uncommitted changes that haven't been tested. The plan's bite-sized step structure exists precisely to keep this loop tight.
6. **If you can't make the e2e test pass without changing the spec or the plan,** stop and report. Do not silently adjust the e2e test to pass; that defeats the purpose. The right move is to flag the gap and ask for guidance.
7. **If you find a real bug in lich while implementing,** add an e2e test that captures it BEFORE fixing it. This grows the regression suite and makes the bug visible to future readers.

---

## Required reading order for subagents

For any v1 implementation work, read in this order:

1. **This document** (testing standards) — required first read
2. **`docs/superpowers/specs/2026-05-23-lich-v1-design.md`** — the product spec; the source of truth for what features do
3. **`docs/superpowers/plans/2026-05-23-lich-v1-plan-<N>-<name>.md`** — the specific plan you're executing
4. **`examples/dogfood-stack/lich.yaml`** — what lich must handle by end of v1; this is the e2e test target
5. **`tests/e2e/helpers/`** — the helpers your e2e tests must use

If you find yourself wanting to read v0 docs in `docs/superpowers/{specs,plans}/archive-v0/`, stop. Those describe a different system. The v1 spec and v1 plans are the only sources for current implementation guidance.
