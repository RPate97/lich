# Dogfood-Stack Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `examples/dogfood-stack/` to exercise every Lich v1 feature that currently has zero e2e coverage (compose services, env_files, env_from, runtime block, lifecycle.before_down, per-service after_ready, ready_when.cmd, exclude-services profile pattern, commands consuming compose-port interpolations + env_from output).

**Architecture:** The dogfood-stack remains a single example directory. Each task adds one feature-gap-closing piece: a yaml block plus any fixture files, plus one new e2e test, plus updates to existing tests whose expected-service-list grew. Tests are TDD-first (write red, then implement, then green).

**Tech Stack:** Bun + TypeScript (lich binary), Vitest (unit tests), Bun's native runner (e2e), supabase CLI (oneshot service), docker compose via OrbStack or Docker Desktop (compose services), `tests/e2e/helpers/*` (existing helper modules).

**Spec source:** `docs/superpowers/specs/2026-05-25-dogfood-stack-expansion-design.md` (approved).

---

## Task ordering rationale

```
1. runtime: block               (no deps)
2. compose services             (introduces redis + mailhog; updates affected existing tests)
3. env_files                    (.env fixture)
4. env_from cmd                 (fake-secrets.sh fixture)
5. from-cmd-secrets env_group   (depends on 4)
6. health_probe (ready_when.cmd) (updates affected existing tests for service-list)
7. api after_ready hook
8. lifecycle.before_down        (teardown-marker.sh fixture)
9. dev:lite profile             (depends on 2, 6; api code change for opt-in REDIS_URL)
10. show:version command        (depends on 5)
11. cache:flush command         (depends on 2)
12. Final verification sweep
```

## Conventions across tasks

- **Build the lich binary** (`cd packages/lich && bun run build`) before any e2e test the first time, then again before any task whose change affects the binary's behavior. Each task notes when rebuild is needed.
- **`LICH` env var convention** — every example command assumes `LICH=/Users/ryan/Desktop/programming/levelzero/packages/lich/dist/lich`. Alias it with `alias lich=$LICH` if you prefer.
- **OrbStack-vs-Docker-Desktop** — doesn't matter; lich's `runtime.compose_cli: auto` (added in Task 1) picks up whichever is on PATH.
- **TDD discipline** — each task: write the new e2e test as `it.todo` first if iterating against a missing block; commit the test going green at the end. For yaml/fixture-only changes, write the assertion first, run it red, then make the change green.
- **Existing-test updates are part of the same commit** as the task that grew the service list. Don't separate them.

---

## Task 1: Add `runtime:` block

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml`
- Test: existing `tests/e2e/validate-plan2-errors.test.ts` (no change, just verify still passes)

- [ ] **Step 1: Add the `runtime:` block at the top of the yaml**

Open `examples/dogfood-stack/lich.yaml` and insert after the `version: "1"` line:

```yaml
version: "1"

runtime:
  # Plan 1: auto picks docker / podman / nerdctl from PATH. Pinned
  # explicitly to document the dogfood-stack's expectation; `auto` is
  # the default but having the block here exercises the runtime parser.
  compose_cli: auto
  # The daemon's reverse proxy port (Plan 5). 3300 is also the default;
  # pinning makes friendly URLs deterministic across test environments.
  proxy_port: 3300

owned:
  # ... rest unchanged
```

- [ ] **Step 2: Validate the yaml still parses**

Run: `$LICH validate examples/dogfood-stack/lich.yaml`
Expected: exit 0, no errors.

- [ ] **Step 3: Rebuild the binary if you haven't yet**

Run: `cd packages/lich && bun run build`
Expected: clean exit, `dist/lich` + `dist/lich-daemon` produced.

- [ ] **Step 4: Sanity-check lich up still works**

Run: `cd examples/dogfood-stack && $LICH up --no-browser` (Ctrl-C once you see "all probes 200 OK" type output, then `$LICH down`)
Expected: stack comes up normally; `runtime:` block is a no-op behaviorally for v1.

- [ ] **Step 5: Commit**

```bash
git add examples/dogfood-stack/lich.yaml
git commit -m "feat(dogfood): pin runtime block (compose_cli + proxy_port)"
```

---

## Task 2: Add compose services (redis + mailhog)

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add `services:` block; add env interpolations)
- Create: `tests/e2e/dogfood-compose-services.test.ts`
- Modify (existing test updates — service-list assertions):
  - `tests/e2e/basic-up.test.ts`
  - `tests/e2e/profiles-default.test.ts`
  - `tests/e2e/profiles-named.test.ts`
  - `tests/e2e/parallel-stacks.test.ts`
  - `tests/e2e/dashboard-stack-list.test.ts`
  - `tests/e2e/dashboard-stack-detail.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/dogfood-compose-services.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich, spawnLich } from "./helpers/lich.js";
import { waitForStackStatus, readState } from "./helpers/state.js";

const LICH = process.env.LICH ?? join(import.meta.dir, "..", "..", "packages", "lich", "dist", "lich");

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  // Ensure binary is built.
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["down", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "dogfood compose services (redis + mailhog) are reachable on their allocated ports",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-compose-svc-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);

    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });
    const snap = await readState(lichHome);

    // Both compose services should be present and ready.
    const services = snap!.services.map((s) => s.name);
    expect(services).toContain("redis");
    expect(services).toContain("mailhog");

    const redis = snap!.services.find((s) => s.name === "redis")!;
    const mailhog = snap!.services.find((s) => s.name === "mailhog")!;
    expect(redis.kind).toBe("compose");
    expect(mailhog.kind).toBe("compose");
    expect(redis.state).toBe("ready");
    expect(mailhog.state).toBe("ready");

    // Redis port should be ping-able. We use lich exec so the env
    // interpolation flows through (REDIS_URL is built from the
    // allocated port).
    const ping = runLich(["exec", "--", "sh", "-c", "redis-cli -u \"$REDIS_URL\" ping"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    expect(ping.exitCode).toBe(0);
    expect(ping.stdout).toContain("PONG");

    // Mailhog UI should be 200 OK on the allocated port.
    const ui = runLich(["exec", "--", "sh", "-c", "curl -fs $MAILHOG_UI/api/v1/messages > /dev/null && echo OK"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    expect(ui.exitCode).toBe(0);
    expect(ui.stdout).toContain("OK");
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (yaml hasn't been changed yet)**

Run: `cd tests/e2e && bun test dogfood-compose-services.test.ts`
Expected: fail (services array doesn't contain `redis` / `mailhog`).

- [ ] **Step 3: Add the `services:` block to the yaml**

In `examples/dogfood-stack/lich.yaml`, insert a new `services:` block BEFORE the existing `owned:` block:

```yaml
services:
  # Plan 1 compose services. Demonstrates the unowned (docker-compose-
  # managed) side of the stack. Both services are simple, fast to pull,
  # and have well-known healthchecks — chosen to keep e2e setup time low.
  redis:
    image: redis:7-alpine
    ports:
      - { container: 6379, env: REDIS_HOST_PORT }
    environment: {}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 1s
      retries: 30

  mailhog:
    # Multi-port compose service: 1025 SMTP + 8025 HTTP UI. Exercises
    # the per-port `env:` mapping pattern, distinct from the single-port
    # shape redis uses above.
    image: mailhog/mailhog:latest
    ports:
      - { container: 1025, env: SMTP_HOST_PORT }
      - { container: 8025, env: MAILHOG_UI_PORT }
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8025/api/v1/messages || exit 1"]
      interval: 3s
      timeout: 2s
      retries: 20
```

- [ ] **Step 4: Wire the new compose env into the top-level `env:` block**

In `examples/dogfood-stack/lich.yaml`, in the existing top-level `env:` block, add:

```yaml
env:
  # ... existing entries ...
  # Plan 1 compose-port interpolations (new). The api uses REDIS_URL
  # opt-in (no hard depends_on) so dev:lite can exclude redis cleanly.
  REDIS_URL: "redis://localhost:${services.redis.host_port}"
  SMTP_URL: "smtp://localhost:${services.mailhog.host_port_1025}"
  MAILHOG_UI: "http://localhost:${services.mailhog.host_port_8025}"
```

If the resolver in `packages/lich/src/env/resolve.ts` uses a different multi-port interpolation shape than `services.mailhog.host_port_1025`, align to whatever it expects (search the resolver for `host_port` and adjust both yaml and assertion strings accordingly).

- [ ] **Step 5: Update the existing test files' service-name assertions**

For each of these six files, find the array literal that lists expected service names (search for `"supabase"` in each — the assertions will be there) and add `"redis"` and `"mailhog"`:

- `tests/e2e/basic-up.test.ts`
- `tests/e2e/profiles-default.test.ts`
- `tests/e2e/profiles-named.test.ts`
- `tests/e2e/parallel-stacks.test.ts`
- `tests/e2e/dashboard-stack-list.test.ts`
- `tests/e2e/dashboard-stack-detail.test.ts`

Example for `basic-up.test.ts` (the assertion will look something like this — update accordingly):

```ts
// Before
expect(services.map((s) => s.name).sort()).toEqual([
  "api", "supabase", "tunnel_demo", "web",
]);

// After
expect(services.map((s) => s.name).sort()).toEqual([
  "api", "mailhog", "redis", "supabase", "tunnel_demo", "web",
]);
```

- [ ] **Step 6: Rebuild + run the new test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test dogfood-compose-services.test.ts`
Expected: pass.

- [ ] **Step 7: Run the updated existing tests**

Run one at a time (each is slow — ~60-90s):
```
bun test basic-up.test.ts
bun test profiles-default.test.ts
bun test profiles-named.test.ts
bun test dashboard-stack-list.test.ts
bun test dashboard-stack-detail.test.ts
```
(Skip `parallel-stacks.test.ts` for now — it brings up 2 stacks and takes 5+ min; verify it passes in the final sweep.)
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add examples/dogfood-stack/lich.yaml \
        tests/e2e/dogfood-compose-services.test.ts \
        tests/e2e/basic-up.test.ts \
        tests/e2e/profiles-default.test.ts \
        tests/e2e/profiles-named.test.ts \
        tests/e2e/parallel-stacks.test.ts \
        tests/e2e/dashboard-stack-list.test.ts \
        tests/e2e/dashboard-stack-detail.test.ts
git commit -m "feat(dogfood): add redis + mailhog compose services with e2e coverage"
```

---

## Task 3: Add `env_files:` (.env fixture)

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add `env_files:` block)
- Create: `examples/dogfood-stack/.env`
- Create: `examples/dogfood-stack/.gitignore` (add `.env.local`)
- Create: `tests/e2e/dogfood-env-files.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/dogfood-env-files.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

const LICH = process.env.LICH ?? join(import.meta.dir, "..", "..", "packages", "lich", "dist", "lich");

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  ".env values flow into stack env via env_files",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-env-files-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    // The committed .env contains LICH_DOGFOOD_EXAMPLE_FROM_DOTENV=hello-from-dotenv
    const probe = runLich(["exec", "--", "sh", "-c", "echo $LICH_DOGFOOD_EXAMPLE_FROM_DOTENV"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.trim()).toBe("hello-from-dotenv");
  },
  600_000,
);

it(
  ".env.local overrides .env when both are present",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-env-files-local-home-"));

    // Write a .env.local that overrides the value from .env.
    writeFileSync(
      join(stackPath, ".env.local"),
      "LICH_DOGFOOD_EXAMPLE_FROM_DOTENV=overridden-by-local\n",
    );

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    const probe = runLich(["exec", "--", "sh", "-c", "echo $LICH_DOGFOOD_EXAMPLE_FROM_DOTENV"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.trim()).toBe("overridden-by-local");
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (env_files not configured, .env missing)**

Run: `cd tests/e2e && bun test dogfood-env-files.test.ts`
Expected: fail (the probe returns empty, expected `hello-from-dotenv`).

- [ ] **Step 3: Create the `.env` fixture**

Create `examples/dogfood-stack/.env`:

```text
# Dogfood-stack baseline env. Loaded by lich via the top-level
# `env_files:` block. Values here are visible in the stack env
# (everything loaded by lich) and can be overridden by `.env.local`
# (gitignored, user-local) or by per-profile env.
LICH_DOGFOOD_EXAMPLE_FROM_DOTENV=hello-from-dotenv
```

- [ ] **Step 4: Create the `.gitignore`**

Create `examples/dogfood-stack/.gitignore`:

```text
# `.env.local` is the standard "user-only" overlay over `.env`. Never
# commit it — its values are by definition not shareable.
.env.local
```

- [ ] **Step 5: Add `env_files:` to the yaml**

In `examples/dogfood-stack/lich.yaml`, add a new top-level block BEFORE the existing `env:` block (alphabetical-ish ordering; placement doesn't affect semantics):

```yaml
# Plan 1 env_files. Loaded in order; later files override earlier
# (so `.env.local` wins over `.env`). lich tolerates missing files —
# `.env.local` is gitignored and not always present.
env_files:
  - .env
  - .env.local
```

- [ ] **Step 6: Rebuild + run the new test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test dogfood-env-files.test.ts`
Expected: both `it()` blocks pass.

- [ ] **Step 7: Commit**

```bash
git add examples/dogfood-stack/lich.yaml \
        examples/dogfood-stack/.env \
        examples/dogfood-stack/.gitignore \
        tests/e2e/dogfood-env-files.test.ts
git commit -m "feat(dogfood): add env_files (.env + .env.local precedence) with e2e"
```

---

## Task 4: Add `env_from:` (fake-secrets.sh fixture)

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add top-level `env_from:`)
- Create: `examples/dogfood-stack/scripts/fake-secrets.sh`
- Create: `tests/e2e/dogfood-env-from.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/dogfood-env-from.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "env_from cmd output flows into stack env",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-env-from-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    // fake-secrets.sh emits FAKE_SECRET_TOKEN=abc123 and FAKE_SECRET_REGION=us-east-1
    const probe = runLich(["exec", "--", "sh", "-c", "echo $FAKE_SECRET_TOKEN,$FAKE_SECRET_REGION"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.trim()).toBe("abc123,us-east-1");
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (env_from not wired, script missing)**

Run: `cd tests/e2e && bun test dogfood-env-from.test.ts`
Expected: fail (probe stdout is `,` — both vars empty).

- [ ] **Step 3: Create the script**

Create `examples/dogfood-stack/scripts/fake-secrets.sh`:

```sh
#!/bin/sh
# Mock secret-manager output for the dogfood-stack's env_from coverage.
# Real users would call e.g. `infisical export --format=dotenv` or
# `doppler secrets download --format=dotenv` here. We emit static values
# so e2e tests can assert on exact strings.
echo "FAKE_SECRET_TOKEN=abc123"
echo "FAKE_SECRET_REGION=us-east-1"
```

Make it executable:

```bash
chmod +x examples/dogfood-stack/scripts/fake-secrets.sh
```

- [ ] **Step 4: Add `env_from:` to the yaml**

In `examples/dogfood-stack/lich.yaml`, add a new top-level block right after the `env_files:` block from Task 3:

```yaml
# Plan 1 env_from. Runs the given command and parses its stdout as
# dotenv (KEY=value lines), merging the result into the stack env.
# Real users would call a secret-manager CLI here; the example uses a
# static fixture script so e2e assertions are deterministic.
env_from:
  - cmd: "./scripts/fake-secrets.sh"
    format: dotenv
```

- [ ] **Step 5: Rebuild + run the test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test dogfood-env-from.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add examples/dogfood-stack/lich.yaml \
        examples/dogfood-stack/scripts/fake-secrets.sh \
        tests/e2e/dogfood-env-from.test.ts
git commit -m "feat(dogfood): add env_from (fake-secrets.sh) with e2e"
```

---

## Task 5: Add `from-cmd-secrets` env_group

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add new env_group)
- Test: deferred to Task 10 (the `show:version` command exercises this end-to-end via `lich <user-command>`)

This task is yaml-only because the env_group's load path is covered by Task 10's e2e test. We commit the yaml change separately so the diff is reviewable.

- [ ] **Step 1: Add the new env_group**

In `examples/dogfood-stack/lich.yaml`, in the existing `env_groups:` block, append:

```yaml
env_groups:
  # ... existing entries (stack-plus-test, isolated-tools) ...

  # Plan 2 env_group using env_from. Distinct from the top-level
  # `env_from:` (Task 4) in that this scoped variant ONLY applies to
  # callers that opt in via `env_group: from-cmd-secrets`. Also blocks
  # process_env passthrough so the env is fully reproducible regardless
  # of the user's shell. Exercised by the `show:version` user command
  # (Task 10) end-to-end.
  from-cmd-secrets:
    process_env: false
    env_from:
      - cmd: "./scripts/fake-secrets.sh"
        format: dotenv
    env:
      ENVIRONMENT: "ci"
```

- [ ] **Step 2: Validate**

Run: `$LICH validate examples/dogfood-stack/lich.yaml`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add examples/dogfood-stack/lich.yaml
git commit -m "feat(dogfood): add from-cmd-secrets env_group (env_from inside a group)"
```

---

## Task 6: Add `health_probe` service (ready_when.cmd)

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add `health_probe` to `owned:`; add it to `dev` profile's owned list)
- Create: `tests/e2e/dogfood-ready-when-cmd.test.ts`
- Modify (existing test updates — service-list assertions):
  - `tests/e2e/basic-up.test.ts`
  - `tests/e2e/profiles-default.test.ts`
  - `tests/e2e/profiles-named.test.ts`
  - `tests/e2e/parallel-stacks.test.ts`
  - `tests/e2e/dashboard-stack-list.test.ts`
  - `tests/e2e/dashboard-stack-detail.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/dogfood-ready-when-cmd.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus, readState } from "./helpers/state.js";

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "health_probe service reaches ready via ready_when.cmd",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-ready-cmd-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    const snap = await readState(lichHome);
    const probe = snap!.services.find((s) => s.name === "health_probe");
    expect(probe).toBeDefined();
    expect(probe!.state).toBe("ready");
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (health_probe doesn't exist yet)**

Run: `cd tests/e2e && bun test dogfood-ready-when-cmd.test.ts`
Expected: fail (service not in snapshot).

- [ ] **Step 3: Add `health_probe` to the `owned:` block**

In `examples/dogfood-stack/lich.yaml`, append to the `owned:` block (after `tunnel_demo`):

```yaml
owned:
  # ... existing services (supabase, api, web, tunnel_demo) ...

  # Plan 4 ready_when.cmd demo. The only ready-check variant the rest
  # of the dogfood-stack doesn't exercise (api uses http_get, supabase
  # uses tcp, tunnel_demo uses log_match+capture). The probe pings the
  # api's /health endpoint; ready only when curl exits 0.
  health_probe:
    cmd: "sleep 99999"
    oneshot: false
    depends_on: [api]
    ready_when:
      cmd: 'curl -fs http://localhost:${owned.api.port}/health > /dev/null'
      timeout: 10s
```

- [ ] **Step 4: Add `health_probe` to the `dev` profile**

In the `profiles:` block, update `dev`'s owned list:

```yaml
profiles:
  dev:
    default: true
    owned: [supabase, api, web, tunnel_demo, health_probe]
    lifecycle:
      # ... unchanged ...
```

- [ ] **Step 5: Update the existing test files' service-name assertions**

For each of the same six files modified in Task 2, add `"health_probe"` to the expected service array:

```ts
// Before (Task 2 already added redis + mailhog)
expect(services.map((s) => s.name).sort()).toEqual([
  "api", "mailhog", "redis", "supabase", "tunnel_demo", "web",
]);

// After
expect(services.map((s) => s.name).sort()).toEqual([
  "api", "health_probe", "mailhog", "redis", "supabase", "tunnel_demo", "web",
]);
```

- [ ] **Step 6: Rebuild + run the new test + updated existing tests**

```bash
cd packages/lich && bun run build
cd ../../tests/e2e
bun test dogfood-ready-when-cmd.test.ts
bun test basic-up.test.ts
bun test profiles-default.test.ts
bun test profiles-named.test.ts
bun test dashboard-stack-list.test.ts
bun test dashboard-stack-detail.test.ts
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add examples/dogfood-stack/lich.yaml \
        tests/e2e/dogfood-ready-when-cmd.test.ts \
        tests/e2e/basic-up.test.ts \
        tests/e2e/profiles-default.test.ts \
        tests/e2e/profiles-named.test.ts \
        tests/e2e/parallel-stacks.test.ts \
        tests/e2e/dashboard-stack-list.test.ts \
        tests/e2e/dashboard-stack-detail.test.ts
git commit -m "feat(dogfood): add health_probe service exercising ready_when.cmd"
```

---

## Task 7: Add per-service `lifecycle.after_ready` on api

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add `lifecycle.after_ready` under `owned.api`)
- Create: `tests/e2e/dogfood-after-ready.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/dogfood-after-ready.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "per-service after_ready hook runs after the api becomes ready",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-after-ready-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    // api's after_ready hook writes a line to ${LICH_HOME}/api-warmup.log
    const warmupPath = join(lichHome, "api-warmup.log");
    expect(existsSync(warmupPath)).toBe(true);
    const contents = readFileSync(warmupPath, "utf8");
    expect(contents).toContain("[api] warmed up at");
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (hook doesn't exist)**

Run: `cd tests/e2e && bun test dogfood-after-ready.test.ts`
Expected: fail (file not present).

- [ ] **Step 3: Add the per-service lifecycle hook**

In `examples/dogfood-stack/lich.yaml`, under the existing `owned.api:` block, add:

```yaml
owned:
  api:
    # ... existing fields (cmd, cwd, port, depends_on, ready_when, fail_when) ...
    # Plan 1 per-service lifecycle hook. Writes a timestamped line to
    # the LICH_HOME root so e2e tests can assert the hook fired without
    # depending on any service-specific log surface. Lich exports
    # ${LICH_HOME} into every spawned subprocess automatically.
    lifecycle:
      after_ready:
        - 'echo "[api] warmed up at $(date -Iseconds)" >> ${LICH_HOME}/api-warmup.log'
```

- [ ] **Step 4: Rebuild + run the test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test dogfood-after-ready.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add examples/dogfood-stack/lich.yaml tests/e2e/dogfood-after-ready.test.ts
git commit -m "feat(dogfood): per-service after_ready on api (warmup log) with e2e"
```

---

## Task 8: Add `lifecycle.before_down` hook

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add top-level `lifecycle.before_down`)
- Create: `examples/dogfood-stack/scripts/teardown-marker.sh`
- Create: `tests/e2e/dogfood-before-down.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/dogfood-before-down.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "lifecycle.before_down runs as part of lich down",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-before-down-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    // Marker should NOT exist yet (script runs during down, not up).
    const markerPath = join(lichHome, "teardown-marker.txt");
    expect(existsSync(markerPath)).toBe(false);

    const down = runLich(["down", "--yes"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 120_000,
    });
    expect(down.exitCode).toBe(0);

    // Now the marker should exist with the expected content.
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8")).toContain("TEST_MODE=integration");
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (hook + script missing)**

Run: `cd tests/e2e && bun test dogfood-before-down.test.ts`
Expected: fail (marker file not present after down).

- [ ] **Step 3: Create the script**

Create `examples/dogfood-stack/scripts/teardown-marker.sh`:

```sh
#!/bin/sh
# Plan 2 lifecycle.before_down marker. Runs in the stack-plus-test
# env_group (inherits stack env, adds TEST_MODE). The e2e test asserts
# both that the file exists AFTER lich down (proving the hook fired)
# and that the env_group plumbing flowed env into the hook (TEST_MODE
# is set by the group; DATABASE_URL is inherited from the stack).
cat > "$LICH_HOME/teardown-marker.txt" <<EOF
TEST_MODE=$TEST_MODE
DATABASE_URL=$DATABASE_URL
EOF
```

Make it executable:

```bash
chmod +x examples/dogfood-stack/scripts/teardown-marker.sh
```

- [ ] **Step 4: Add the lifecycle hook**

In `examples/dogfood-stack/lich.yaml`, in the existing top-level `lifecycle:` block, add a `before_down:` array (after the existing `after_up:`):

```yaml
lifecycle:
  # after_up: (existing)
  #   - cmd: ./scripts/write-marker.sh
  #     env_group: stack-plus-test

  # Plan 2 lifecycle.before_down. Runs LIFO across the active profile
  # plus top-level before_down entries. Uses the same env_group as
  # after_up so the marker file proves both that the hook fired AND
  # that the env_group plumbing carried env into it.
  before_down:
    - cmd: ./scripts/teardown-marker.sh
      env_group: stack-plus-test
```

- [ ] **Step 5: Rebuild + run the test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test dogfood-before-down.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add examples/dogfood-stack/lich.yaml \
        examples/dogfood-stack/scripts/teardown-marker.sh \
        tests/e2e/dogfood-before-down.test.ts
git commit -m "feat(dogfood): add lifecycle.before_down (teardown-marker) with e2e"
```

---

## Task 9: Add `dev:lite` profile (+ api opt-in REDIS_URL)

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add `dev:lite` profile)
- Modify: `examples/dogfood-stack/apps/api/src/index.ts` (opt-in REDIS_URL — no-op when unset)
- Create: `tests/e2e/profiles-lite.test.ts`

- [ ] **Step 1: Inspect the current api entrypoint to confirm what's there**

Run: `cat examples/dogfood-stack/apps/api/src/index.ts`
Expected: small Express setup. The change is additive — wrap any redis use behind a `if (process.env.REDIS_URL) { ... }` guard. If the api doesn't currently import redis at all, just add a startup log line that proves the guard works either way:

```ts
// Inside the api's startup, after the Express app is created:
if (process.env.REDIS_URL) {
  console.log(`[api] would connect to redis at ${process.env.REDIS_URL}`);
} else {
  console.log(`[api] no REDIS_URL set; running without cache`);
}
```

The exact patch depends on the current file shape — find the `app.listen()` call and add the log lines just before it.

- [ ] **Step 2: Write the failing e2e test**

Create `tests/e2e/profiles-lite.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus, readState } from "./helpers/state.js";

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "dev:lite profile starts only supabase + api + web (excludes redis, mailhog, tunnel_demo, health_probe)",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-profiles-lite-home-"));

    const up = runLich(["up", "dev:lite", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    const snap = await readState(lichHome);
    const names = snap!.services.map((s) => s.name).sort();
    expect(names).toEqual(["api", "supabase", "web"]);

    // active_profile should be recorded.
    expect(snap!.active_profile).toBe("dev:lite");
  },
  600_000,
);
```

- [ ] **Step 3: Run the test — expect FAIL (profile doesn't exist)**

Run: `cd tests/e2e && bun test profiles-lite.test.ts`
Expected: fail (unknown profile `dev:lite`).

- [ ] **Step 4: Add the `dev:lite` profile**

In `examples/dogfood-stack/lich.yaml`, append a new entry to `profiles:`:

```yaml
profiles:
  # dev: (existing default)
  # dev:env-override: (existing)

  # Plan 3 exclude-services profile pattern. Minimum-viable stack for
  # fast api iteration: drops the optional services (redis, mailhog,
  # tunnel_demo, health_probe). NO `extends:` because explicit
  # services/owned lists REPLACE the implicit "all declared" set, not
  # subtract from it (per the profile resolver).
  dev:lite:
    services: []
    owned: [supabase, api, web]
    lifecycle:
      # Duplicated from dev rather than inherited, by design — keeps
      # dev:lite independent so changes to dev don't accidentally break
      # the fast-iteration profile.
      after_up:
        - supabase migration up
        - psql "$DATABASE_URL" -f supabase/seed.sql
```

- [ ] **Step 5: Rebuild + run the test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test profiles-lite.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add examples/dogfood-stack/lich.yaml \
        examples/dogfood-stack/apps/api/src/index.ts \
        tests/e2e/profiles-lite.test.ts
git commit -m "feat(dogfood): add dev:lite profile (exclude-services) + opt-in REDIS_URL"
```

---

## Task 10: Add `show:version` command

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add `commands.show:version`)
- Create: `tests/e2e/commands-env-from.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/commands-env-from.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "lich show:version returns env_from values via from-cmd-secrets env_group",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-commands-env-from-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    const result = runLich(["show:version"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("abc123");
    expect(result.stdout).toContain("us-east-1");
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (command doesn't exist)**

Run: `cd tests/e2e && bun test commands-env-from.test.ts`
Expected: fail (unknown command `show:version`).

- [ ] **Step 3: Add the command**

In `examples/dogfood-stack/lich.yaml`, in the existing `commands:` block, append:

```yaml
commands:
  # ... existing entries (test:e2e, db:psql, tools:env-check) ...

  # Plan 2 user-defined command consuming env_from'd values via an
  # env_group. Distinct from `tools:env-check`, which uses an env_group
  # whose env is only literal values. This one exercises the env_from
  # → env_group → user-command path end-to-end.
  show:version:
    cmd: 'echo "FAKE_SECRET_TOKEN=$FAKE_SECRET_TOKEN, region=$FAKE_SECRET_REGION"'
    env_group: from-cmd-secrets
    help: |
      Print values loaded via the `from-cmd-secrets` env_group's
      `env_from` shell-out. The script at
      `scripts/fake-secrets.sh` is the mock secret manager.
```

- [ ] **Step 4: Rebuild + run the test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test commands-env-from.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add examples/dogfood-stack/lich.yaml tests/e2e/commands-env-from.test.ts
git commit -m "feat(dogfood): add show:version command (env_from via env_group) with e2e"
```

---

## Task 11: Add `cache:flush` command

**Files:**
- Modify: `examples/dogfood-stack/lich.yaml` (add `commands.cache:flush`)
- Create: `tests/e2e/commands-compose-port.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/commands-compose-port.test.ts`:

```ts
import { it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

let stackPath: string;
let lichHome: string;

beforeAll(() => {
  execSync("bun run build", {
    cwd: join(import.meta.dir, "..", "..", "packages", "lich"),
    stdio: "ignore",
  });
});

afterEach(() => {
  try {
    runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 60_000 });
  } catch {}
  if (stackPath) rmSync(stackPath, { recursive: true, force: true });
  if (lichHome) rmSync(lichHome, { recursive: true, force: true });
});

it(
  "lich cache:flush succeeds under dev (redis running)",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-cache-flush-dev-home-"));

    const up = runLich(["up", "dev", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    const result = runLich(["cache:flush"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("flushed");
  },
  600_000,
);

it(
  "lich cache:flush fails under dev:lite (redis not running)",
  async () => {
    stackPath = copyExampleToTmpdir("dogfood-stack", { install: true });
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-cache-flush-lite-home-"));

    const up = runLich(["up", "dev:lite", "--no-browser"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    expect(up.exitCode).toBe(0);
    await waitForStackStatus(lichHome, "up", { timeoutMs: 60_000 });

    const result = runLich(["cache:flush"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 10_000,
    });
    // Non-zero — connection refused (or similar). We don't pin the
    // exact error message because it varies by redis-cli version, but
    // the command MUST fail since the cache isn't running.
    expect(result.exitCode).not.toBe(0);
  },
  600_000,
);
```

- [ ] **Step 2: Run the test — expect FAIL (command doesn't exist)**

Run: `cd tests/e2e && bun test commands-compose-port.test.ts`
Expected: both tests fail.

- [ ] **Step 3: Add the command**

In `examples/dogfood-stack/lich.yaml`, in the existing `commands:` block, append:

```yaml
commands:
  # ... existing entries + show:version from Task 10 ...

  # Plan 2 user-defined command consuming a ${services.X.host_port}
  # interpolation. REDIS_URL is built from the redis service's allocated
  # port (top-level env block). Failing loudly under dev:lite is the
  # correct behavior — the command obviously depends on the cache.
  cache:flush:
    cmd: 'redis-cli -u "$REDIS_URL" FLUSHDB && echo "flushed"'
    help: |
      Wipe the dev-stack redis cache. Requires `redis-cli` on PATH and
      the redis service running (i.e. profile dev, not dev:lite).
```

- [ ] **Step 4: Rebuild + run the test**

Run: `cd packages/lich && bun run build && cd ../../tests/e2e && bun test commands-compose-port.test.ts`
Expected: both tests pass. (Note: requires `redis-cli` on PATH; install via `brew install redis` if missing.)

- [ ] **Step 5: Commit**

```bash
git add examples/dogfood-stack/lich.yaml tests/e2e/commands-compose-port.test.ts
git commit -m "feat(dogfood): add cache:flush command (consumes compose port) with e2e"
```

---

## Task 12: Final verification sweep

**Files:**
- None modified — verification only.

- [ ] **Step 1: Validate the final yaml**

Run: `$LICH validate examples/dogfood-stack/lich.yaml --json`
Expected: exit 0, JSON output with `errors: []`.

- [ ] **Step 2: Run the full unit suite**

Run: `cd packages/lich && bun run test`
Expected: 1300+ pass, 0 fail (under vitest, the canonical runner).

- [ ] **Step 3: Typecheck**

Run: `cd packages/lich && bun run typecheck 2>&1 | grep '^src/'`
Expected: empty output (0 src/ errors). Test-file errors may persist; that's pre-existing.

- [ ] **Step 4: Rebuild both binaries**

Run: `cd packages/lich && bun run build`
Expected: `dist/lich` + `dist/lich-daemon` produced cleanly.

- [ ] **Step 5: Run the full e2e suite**

Run: `cd tests/e2e && bun test`
Expected: every test passes. The previously-deferred `parallel-stacks.test.ts` should now pass too (with the new service set). Allow 20-30 min on a clean docker daemon.

- [ ] **Step 6: Manual smoke**

```bash
cd examples/dogfood-stack
rm -rf .env.local  # ensure clean start
$LICH up dev --no-browser
$LICH urls         # friendly + raw URLs both present
$LICH stacks       # active_profile shown
$LICH show:version # env_from values
$LICH cache:flush  # works under dev
$LICH down --yes
ls "$HOME/.lich" 2>/dev/null || ls "$LICH_HOME" 2>/dev/null
# teardown-marker.txt should exist where the lifecycle hook wrote it
```

- [ ] **Step 7: Commit the verification record**

If anything failed, fix it and re-run. When everything passes, no separate commit is needed — the previous task commits stand. Optionally:

```bash
git log --oneline $(git merge-base HEAD master)..HEAD
# Should show ~11 focused commits, one per task.
```

- [ ] **Step 8: Update the spec/plan status to "Done"**

In `docs/superpowers/specs/2026-05-25-dogfood-stack-expansion-design.md`, update the status line at the top:

```markdown
> **Status:** Implemented 2026-05-XX (the date of completion).
```

Then:

```bash
git add docs/superpowers/specs/2026-05-25-dogfood-stack-expansion-design.md
git commit -m "docs(spec): mark dogfood-stack expansion implemented"
```

---

## Self-review summary

**Spec coverage check** — every section of the spec has a task:

| Spec section | Task(s) |
|---|---|
| §3 Compose services (redis + mailhog) | Task 2 |
| §4 Runtime block + lifecycle (before_down, per-svc after_ready) | Task 1 (runtime), Task 7 (after_ready), Task 8 (before_down) |
| §5 Env layering (env_files, env_from, env_group with env_from) | Task 3 (env_files), Task 4 (env_from), Task 5 (env_group) |
| §6 dev:lite profile | Task 9 |
| §7 ready_when.cmd via health_probe | Task 6 |
| §8 New commands (show:version, cache:flush) | Task 10, Task 11 |
| §9 Migration of existing tests | Folded into Task 2 + Task 6 (the two tasks that grew the service set) |
| §10 New e2e tests | Each task creates the corresponding test |
| Final verification | Task 12 |

**Placeholder scan** — none of the disallowed patterns appear (no "TBD", "implement later", "similar to Task N").

**Type/identifier consistency** — all yaml keys, service names (`redis`, `mailhog`, `health_probe`), env vars (`REDIS_URL`, `FAKE_SECRET_TOKEN`, etc.), and command names (`show:version`, `cache:flush`) match across the tasks that reference them.
