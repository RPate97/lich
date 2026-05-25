/**
 * Dashboard `/api/stacks/:id` end-to-end — Plan 5 Task 25 (LEV-427).
 *
 * Sibling to `dashboard-stack-list.test.ts`. That test pins the LIST
 * endpoint's wire format; this one pins the single-stack DETAIL endpoint's
 * wire format. They live in separate files because the failure modes are
 * distinct — a regression in the list projection (sort order, fan-out)
 * is unrelated to a regression in the detail lookup (id-not-found 404,
 * per-service `ports` map shape) and conflating them would make a single
 * red test ambiguous.
 *
 * Coverage of this test:
 *
 *   1. `lich up --no-browser` against a tmpdir copy of the dogfood-stack
 *      brings the stack up AND triggers the daemon auto-start (LEV-411).
 *   2. Discover the stack id via `<LICH_HOME>/stacks/<id>/` directory
 *      listing — same single-entry trick `basic-up.test.ts` uses (we
 *      only ever bring up one stack per test).
 *   3. `GET /api/stacks/<id>` (via `fetchDashboardJson<StackView>`) returns
 *      the stack with:
 *        - the right `id` (matches the directory name)
 *        - the right `worktree_name` (slug derived from the tmpdir basename)
 *        - `status: "up"` (matches the on-disk state.json)
 *        - `active_profile: "dev"` (dogfood-stack's default profile per
 *          lich.yaml:131-133)
 *        - the six expected services (`api`, `mailhog`, `redis`,
 *          `supabase`, `tunnel_demo`, `web`) all in the `ready` state —
 *          verifying the projection surfaces per-service detail
 *        - allocated ports per service — every dogfood-stack owned service
 *          gets at least one port (Plan 1 allocator output); the projection
 *          surfaces them as `ports` (renamed from snapshot's
 *          `allocated_ports`, see `stacks-view.ts`'s `projectService`)
 *        - `primary_url` set (Plan 5 Task 8 routing population — the
 *          dogfood-stack always has routing entries because every service
 *          has at least one allocated port)
 *   4. Negative case: `GET /api/stacks/nonexistent-id` returns 404. The
 *      `fetchDashboardJson` helper throws `HTTP 404: <path>` on non-2xx,
 *      so we assert the thrown error message contains `404`.
 *
 * Why this test exists separately from `dashboard-stack-list.test.ts`:
 *   - The list endpoint returns `StackView[]` directly; the detail endpoint
 *     returns one `StackView` or a 404. Different shapes → different bugs.
 *   - The detail endpoint is what the SPA's per-stack page uses; a 404
 *     regression there breaks the "click a stack to view it" flow without
 *     the list page noticing.
 *   - The per-service `ports` projection (renaming `allocated_ports` →
 *     `ports`) is only verifiable on the detail endpoint where the test
 *     can pin per-service ports against `state.json`. The list test does
 *     the existential service check; this test does the structural check.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (the repo's source is never touched).
 *   - LICH_HOME pointed at a per-test tmp directory — the daemon, its
 *     PID file, its URL file, and the stack's state.json all live there.
 *   - lich binary built in `beforeAll` from packages/lich/ (matches the
 *     other e2e tests' pattern).
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich down` + `lich nuke --yes` run in `afterEach` even when the
 *     test body throws (nuke also tears down the daemon, per LEV-420 /
 *     Plan 5 Task 18). Both tmpdirs are recursively removed.
 *   - Leaving the daemon process behind would corrupt subsequent test
 *     runs (the next test's `lich up` would short-circuit on the
 *     already-running PID).
 *
 * Runtime budget: ~5 minutes (mostly the cold-supabase pull on first
 * run). The actual dashboard fetches are sub-millisecond once the stack
 * is up; the heavy time is the up itself.
 *
 * STATUS (2026-05-24): This test fails until LEV-414 wires the dashboard
 * server into the daemon. The failure mode pre-LEV-414 is `waitForDaemonRunning`
 * timing out (no `daemon.url` written) or `fetchDashboardJson` throwing
 * "No daemon.url" — both diagnostic enough to confirm the test is correct
 * and the wiring is what's missing.
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
import { waitForDaemonRunning } from "./helpers/daemon.js";
import { fetchDashboardJson } from "./helpers/dashboard-fetch.js";

// ---------------------------------------------------------------------------
// Wire-format types — mirror `packages/lich/src/daemon/dashboard/stacks-view.ts`'s
// `StackView`. Duplicated locally (NOT imported) per testing-standards
// §"E2e tests spawn the real binary": the e2e suite stays out-of-process. If
// the wire format ever drifts from this shape, the test fails and the drift
// gets caught — that's the whole point of a separate type definition.
// ---------------------------------------------------------------------------

interface StackViewService {
  name: string;
  kind: "owned" | "compose";
  state: string;
  failure_reason?: string;
  failure_log_tail?: string[];
  ports?: Record<string, number>;
}

interface StackView {
  id: string;
  worktree_name: string;
  status: string;
  active_profile?: string;
  services: StackViewService[];
  primary_url?: string;
  started_at?: string;
}

// ---------------------------------------------------------------------------
// Build the binary up front. Same pattern as basic-up.test.ts and
// dashboard-stack-list.test.ts — fail loudly if the build is missing; the
// binary IS our code, a broken build is a real bug rather than something
// to skip.
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
// and the real ~/.lich never gets touched. Matches the shape used by
// basic-up.test.ts / dashboard-stack-list.test.ts.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  // install: true — apps/web runs `next dev`, which needs `next` in
  // node_modules/.bin. Without it the web owned service exits 127
  // immediately and `lich up` fails before state.json reaches "up".
  // Same justification as basic-up.test.ts (LEV-313).
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(
    join(tmpdir(), "lich-e2e-dashboard-stack-detail-home-"),
  );
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Belt-and-braces teardown. Best-effort lich down (clean shutdown of the
 * services), then lich nuke (kills the daemon process — LEV-420 — so the
 * next test's daemon spawns cleanly), then tmpdir cleanup. Every step is
 * a separate try/catch so one failure doesn't block the others.
 */
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
  // nuke --yes: the daemon process is per-machine and per-LICH_HOME; if we
  // leave it alive, the daemon.pid/daemon.url under our tmp LICH_HOME stay
  // valid and the next test's `lich up` would short-circuit on the
  // "already running" branch — even though the OTHER test wants a fresh
  // daemon spawn. Nuke kills the daemon AND clears its files.
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

// ---------------------------------------------------------------------------
// Helpers private to this suite
// ---------------------------------------------------------------------------

/**
 * Find the (single) stack id present under `<lichHome>/stacks/`. Mirrors
 * basic-up.test.ts and dashboard-stack-list.test.ts's helper of the same
 * name. The test only ever brings one stack up, so the single-entry
 * assumption holds.
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

describe("dashboard /api/stacks/:id against dogfood-stack", () => {
  it(
    "returns one StackView with per-service detail including ports + primary_url",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger — the heavy step is `lich up` (cold supabase
      // pull) which can be silent for ~30-90s on first run. Surface what
      // phase the test is in so a hang is obvious.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up --no-browser -----------------------------------------
      // --no-browser keeps CI/headless hosts from trying to spawn Chrome
      // (the daemon would still open it without the flag — LEV-411). The
      // dashboard server starts regardless.
      step("lich up --no-browser (cold supabase pull ~30-90s)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // Surface the failure cause immediately so a regression is one
        // line of output, not a debugging session.
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      // ---- wait for state.json: status:up -------------------------------
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");

      // ---- wait for daemon ----------------------------------------------
      // After `lich up` exits successfully, the daemon should already be
      // running (the auto-start hook fires before `up` returns — see
      // up.ts's LEV-411 block). 10s is plenty: on the cold path the
      // daemon takes ~500ms to write its URL file.
      step("waiting for daemon (pid + url files)");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 10_000,
      });
      expect(daemon.url).toMatch(/^http:\/\//);
      step(`daemon up at ${daemon.url}`);

      // ---- GET /api/stacks/:id ------------------------------------------
      // The dashboard server returns a single `StackView` directly for
      // /api/stacks/:id (NOT wrapped) — see `server.ts`'s `jsonResponse(stack)`
      // at the segments.length === 1 branch of the /api/stacks/* dispatcher.
      step(`fetching /api/stacks/${stackId}`);
      const stack = await fetchDashboardJson<StackView>(
        lichHome,
        `/api/stacks/${stackId}`,
      );

      // id: must equal the directory name we discovered on disk. Proves
      // the projection didn't mangle/swap ids during the snapshot →
      // StackView mapping.
      expect(stack.id).toBe(stackId);

      // worktree_name: derived from the tmpdir basename. We don't pin the
      // exact value (it includes a random suffix) — assert it's a
      // non-empty DNS-safe slug, matching `sanitizeName`'s contract.
      // Then assert it matches the snapshot's worktree_name verbatim
      // (the projection passes it through unchanged).
      expect(stack.worktree_name).toMatch(/^[a-z0-9-]+$/);
      expect(stack.worktree_name.length).toBeGreaterThan(0);
      expect(stack.worktree_name).toBe(snap.worktree_name);

      // status: "up". Projection of the snapshot's same field. If it
      // differs we've got a stale cache or a bad mapping.
      expect(stack.status).toBe("up");

      // active_profile: dogfood-stack defines `dev` as the default
      // profile (lich.yaml:131-133, "default: true"). Plan 3 Task 14+
      // writes it into the snapshot; the projection forwards it
      // verbatim (stacks-view.ts:243-247).
      expect(stack.active_profile).toBe("dev");

      // services: dogfood-stack defines four owned services + two compose
      // services (mailhog/redis were added by Task-2 of the dogfood-stack
      // expansion). All should be in `ready` after a successful `lich up`
      // (Plan 4's ready_when contract for owned; docker healthcheck for
      // compose). We don't pin the order — the projection doesn't sort
      // within a stack — but the set must match exactly.
      const serviceNames = stack.services.map((s) => s.name).sort();
      expect(serviceNames).toEqual([
        "api",
        "mailhog",
        "redis",
        "supabase",
        "tunnel_demo",
        "web",
      ]);

      // Per-service kind tag. The dogfood-stack mixes owned + compose:
      // mailhog/redis are the only compose entries (declared under the
      // top-level `services:` block); everything else is owned. The
      // projection passes the kind through unchanged.
      const expectedKinds: Record<string, "owned" | "compose"> = {
        api: "owned",
        mailhog: "compose",
        redis: "compose",
        supabase: "owned",
        tunnel_demo: "owned",
        web: "owned",
      };
      for (const svc of stack.services) {
        expect(svc.kind).toBe(expectedKinds[svc.name]);
        // After `status: up`, every service is ready. If a service were
        // still `initializing` or `starting`, the stack-level status
        // would be `starting` or `partial`, not `up`. Catching that here
        // means a regression in the state machine surfaces.
        expect(svc.state).toBe("ready");
      }

      // Per-service `ports` map. Pinned against state.json's
      // `allocated_ports` for each service — `projectService` renames
      // `allocated_ports` → `ports` and otherwise passes through verbatim
      // (stacks-view.ts:262-282). A regression in that rename would fail
      // here; the LIST test (dashboard-stack-list) doesn't pin this.
      //
      // Iterate the snapshot's services (source of truth) and confirm
      // each one's allocated ports appear under the wire `ports` field.
      for (const snapSvc of snap.services) {
        const wireSvc = stack.services.find((s) => s.name === snapSvc.name);
        expect(wireSvc).toBeDefined();
        if (
          snapSvc.allocated_ports &&
          Object.keys(snapSvc.allocated_ports).length > 0
        ) {
          // Service has ports on disk — wire must expose them under
          // `ports` (NOT `allocated_ports`). Deep-equal so port-key
          // ordering doesn't matter.
          expect(wireSvc!.ports).toEqual(snapSvc.allocated_ports);
          // Every port value should be a positive integer (the allocator
          // never assigns 0 or negative). Belt-and-braces: catches a
          // regression where the projection accidentally JSON-stringifies
          // a number to a string.
          for (const port of Object.values(wireSvc!.ports!)) {
            expect(typeof port).toBe("number");
            expect(port).toBeGreaterThan(0);
          }
        } else {
          // Service has no ports — wire must omit the `ports` field
          // entirely (NOT emit an empty object). Matches
          // `projectService`'s "only set when non-empty" rule.
          expect(wireSvc!.ports).toBeUndefined();
        }
      }

      // primary_url: derived from the snapshot's `routing` block, which
      // Plan 5 Task 8 populates from each service's allocated ports. For
      // a successfully-up dogfood stack, routing MUST be non-empty
      // (every service has at least one allocated port → at least one
      // routing entry → primary_url defined).
      //
      // The projection (stacks-view.ts:310-319) returns the first
      // routing entry's `upstream_url`, which is always
      // `http://127.0.0.1:<port>`.
      expect(stack.primary_url).toBeDefined();
      expect(stack.primary_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      // started_at: ISO 8601 timestamp from the snapshot. The projection
      // passes it through verbatim. Asserting it exists + parses confirms
      // the projection isn't dropping the field (a subtle regression that
      // would break the SPA's uptime display).
      expect(stack.started_at).toBeDefined();
      expect(Number.isNaN(Date.parse(stack.started_at!))).toBe(false);

      step("all /api/stacks/:id assertions passed");

      // ---- Negative case: 404 on nonexistent id ------------------------
      // The dashboard server returns 404 (with body
      // `{"error":"not_found","message":"stack not found: <id>"}`) when
      // the requested id isn't in the cache. `fetchDashboardJson` throws
      // `HTTP 404: <path>` on any non-2xx — assert the throw and that the
      // message carries the 404 marker (so a future 500 regression
      // wouldn't accidentally satisfy this assertion).
      step("fetching /api/stacks/nonexistent-id (expect 404)");
      let caught: unknown = null;
      try {
        await fetchDashboardJson<StackView>(
          lichHome,
          "/api/stacks/nonexistent-id",
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("404");
      step("404 negative case passed");
    },
    // Per-test override: 5 minutes — same shape as basic-up. The cold
    // supabase pull on first run is the bottleneck; subsequent runs hit
    // warm images and complete in under a minute.
    300_000,
  );
});
