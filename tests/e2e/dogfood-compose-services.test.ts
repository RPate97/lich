/**
 * Compose-services dogfood coverage — Task 2 of the dogfood-stack expansion
 * (docs/superpowers/plans/2026-05-25-dogfood-stack-expansion.md). Pins:
 *
 *   1. Both compose services declared in `examples/dogfood-stack/lich.yaml`
 *      (`redis`, `mailhog`) appear in state.json after `lich up`, both with
 *      `kind: "compose"` and `state: "ready"`. Catches regressions in the
 *      compose runner / override emitter / health-wait loop without needing
 *      to inspect the override yaml.
 *
 *   2. The compose-port interpolation `${services.redis.host_port}` actually
 *      resolves at env-resolution time: `lich exec` with the resulting
 *      `REDIS_URL` reaches the redis container and `redis-cli ping` returns
 *      `PONG`. This is the end-to-end proof that the allocator → override →
 *      interpolation pipeline is wired correctly for compose services
 *      (the previous test cases only exercised owned-service port
 *      interpolation via `${owned.<name>.ports.<key>}`).
 *
 * Mailhog UI assertion:
 *   The `mailhog` service exposes two container ports (1025 SMTP + 8025 UI),
 *   but the interpolation engine (`packages/lich/src/config/interpolation.ts`)
 *   only ships `${services.<name>.host_port}` (the FIRST declared port). The
 *   multi-port `${services.<name>.ports.<key>}` shape is documented in the
 *   design spec but is owned-service-only in the current implementation —
 *   compose services hit the `unknown reference path` branch. The yaml
 *   therefore only sets `SMTP_URL` from the primary port; no `MAILHOG_UI`
 *   is exported, so this test does not poke the 8025 UI surface.
 *
 *   The UI surface IS still verified indirectly: mailhog's container-side
 *   `healthcheck` block in `lich.yaml` polls `http://localhost:8025/api/v1
 *   /messages` from inside the container. If the UI server fails to bind,
 *   the healthcheck never passes, the service never reaches `ready`, and
 *   the kind/state assertion below fails. So the surface is implicitly
 *   covered without needing a host-side curl.
 *
 *   Once the engine grows multi-port `${services.<name>.ports.<key>}`
 *   resolution for compose services, this test can be extended to add a
 *   `lich exec` probe against `MAILHOG_UI/api/v1/messages` for the
 *   first-class assertion. Filed as a follow-up in the expansion plan.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (the repo's source is never touched).
 *   - LICH_HOME pointed at a per-test tmp directory so the real ~/.lich
 *     stays untouched (no collisions with the user's own runs).
 *   - lich binary built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich down` then `lich nuke --yes` runs in `afterEach` even when the
 *     test body throws. nuke kills the daemon (which would otherwise hold
 *     the proxy port and break the next test) and releases compose
 *     resources for redis + mailhog.
 *   - tmpdir + LICH_HOME removed in `afterEach`.
 *
 * Runtime budget: ~5 minutes. The dominant cost is supabase first-pull
 * (dogfood-stack always boots the full owned + compose set), not redis /
 * mailhog themselves — those images are tiny and pull in seconds.
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail loudly (not skip) — the binary IS our code
// and a broken build is a real bug. Matches basic-up.test.ts / dashboard-*
// for consistency across the e2e suite.
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-test fixture — fresh tmpdir + LICH_HOME so nothing leaks between tests
// and the user's real ~/.lich stays untouched. Mirrors basic-up.test.ts.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  // install: true — apps/web runs `next dev` which needs `next` in
  // node_modules/.bin (LEV-313). Same reasoning as basic-up.test.ts.
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-compose-services-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 120_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 60_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`,
      err,
    );
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

/**
 * Find the (single) stack id present under `<lichHome>/stacks/`. Mirrors
 * basic-up.test.ts's helper — the test only ever brings one stack up, so
 * the single-entry assumption holds.
 */
function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return null;
  return entries[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dogfood-stack compose services (redis + mailhog)", () => {
  it(
    "redis + mailhog reach `ready` and the REDIS_URL interpolation pings the container",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger — `lich up` is silent for ~30-90s on cold
      // supabase + mailhog + redis pulls; surface what phase the test is in
      // so a hang is obvious. Same pattern as basic-up.test.ts.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up --no-browser ------------------------------------------
      // --no-browser avoids spawning Chrome in headless / CI runs (LEV-411).
      // The compose pipeline runs regardless of the browser flag.
      step("lich up --no-browser (cold pulls supabase + redis + mailhog)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 300_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      // ---- state.json: status:up + compose services present -------------
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");

      const services = snap.services.map((s) => s.name);
      expect(services).toContain("redis");
      expect(services).toContain("mailhog");

      const redis = snap.services.find((s) => s.name === "redis")!;
      const mailhog = snap.services.find((s) => s.name === "mailhog")!;
      // Kind: both come from the `services:` block, so the snapshot must
      // tag them as `compose`. If the snapshot writer ever mislabels them
      // as `owned` (regression in `state/snapshot.ts`'s kind detection)
      // the dashboard list/detail tests would also fail, but pinning here
      // surfaces the bug in the dedicated compose-coverage test first.
      expect(redis.kind).toBe("compose");
      expect(mailhog.kind).toBe("compose");
      // State: ready means the healthcheck (or ready_when, for owned) has
      // passed. For these compose services that means redis-cli answered
      // PING and mailhog's wget probe got 200 from the UI — both are the
      // healthcheck blocks in lich.yaml.
      expect(redis.state).toBe("ready");
      expect(mailhog.state).toBe("ready");
      step("redis + mailhog kind=compose state=ready");

      // ---- redis interpolation end-to-end -------------------------------
      // `lich exec` resolves the stack env, including REDIS_URL =
      // "redis://localhost:${services.redis.host_port}". The redis-cli
      // binary on the host PATH connects to that allocated port and runs
      // PING. A PONG reply proves:
      //   1. The allocator picked a free port and pinned it to 6379 in the
      //      compose override.
      //   2. The interpolation engine resolved `services.redis.host_port`
      //      to that allocated port.
      //   3. The compose runner brought up the redis container with the
      //      right binding.
      //
      // The `--` separator is load-bearing: mri (the CLI parser) would
      // otherwise eat the `-c` flag as its own option. See exec.test.ts
      // for the same pattern + reasoning.
      step("lich exec redis-cli ping");
      const ping = runLich(
        ["exec", "--", "sh", "-c", 'redis-cli -u "$REDIS_URL" ping'],
        {
          cwd: stackPath,
          env: { LICH_HOME: lichHome },
          timeout: 10_000,
        },
      );
      if (ping.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("redis-cli ping stdout:", ping.stdout);
        // eslint-disable-next-line no-console
        console.error("redis-cli ping stderr:", ping.stderr);
      }
      expect(ping.exitCode).toBe(0);
      expect(ping.stdout).toContain("PONG");
      step("redis PONG received");
    },
    // Per-test timeout: 5 minutes. The cold-pull path for supabase alone
    // can run ~60-90s; redis + mailhog add a few seconds each.
    300_000,
  );
});
