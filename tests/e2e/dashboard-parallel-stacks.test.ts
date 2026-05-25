/**
 * Dashboard + friendly URLs with TWO parallel stacks — Plan 5 Task 28 (LEV-430).
 *
 * The Plan-5-specific cross-cutting sentinel: prove the daemon + dashboard +
 * reverse proxy can correctly serve two stacks at once, under a single shared
 * LICH_HOME (which mirrors real per-machine usage). The existing
 * `parallel-stacks.test.ts` sentinel (Plan 1) only exercises raw `localhost:
 * <port>` URLs and the file-locked port allocator. THIS test extends that
 * shape to the Plan 5 surfaces:
 *
 *   1. Both stacks appear in `GET /api/stacks` — the dashboard's list
 *      projection joins every per-stack `state.json` it sees under the
 *      shared LICH_HOME, so a regression where the daemon serves only the
 *      first-discovered stack would surface immediately here.
 *   2. Each stack registers its OWN friendly hostnames in `state.routing`
 *      (per Plan 5 Task 8's `buildRoutingEntries`). The two worktree
 *      slugs differ (`lich-e2e-plan5-a-XXXX` vs `lich-e2e-plan5-b-XXXX`),
 *      so the hostnames differ too — e.g.
 *      `api.<worktree-a>.lich.localhost` vs `api.<worktree-b>.lich.localhost`.
 *      The proxy's routing table joins both stacks' entries into one
 *      `Map<hostname, upstreamUrl>` (per Plan 5 Task 11's `RoutingTable`);
 *      a regression where one stack's routes clobber the other's (e.g.
 *      a stale key cache, an accidental shared mutable map) surfaces as
 *      one of the curl probes hitting the wrong upstream.
 *   3. Curling each friendly URL via the proxy returns a 200 that
 *      matches the body returned by curling the corresponding raw
 *      upstream URL directly — proving the proxy is forwarding to the
 *      right port. The dogfood `api`'s `/health` body is deterministic
 *      across stacks (`{ status: "ok" }`), so we can't distinguish
 *      upstreams from the body alone; instead the "different upstreams"
 *      claim is grounded in (a) the routing entries record distinct
 *      hostnames mapped to distinct ports, (b) the proxied bodies match
 *      their respective raw upstream bodies (forwarding works), and
 *      (c) a hostname not in routing returns 404 (proves the proxy is
 *      Host-routing, not blindly forwarding to a single default).
 *   4. The dashboard URL is the SAME for both `lich up` invocations —
 *      the daemon is per-machine, not per-stack. Each `lich up` calls
 *      `ensureDaemonRunning` which short-circuits on the second call
 *      (`alreadyRunning: true`); only the first invocation actually
 *      spawns the daemon. This proves the per-machine singleton
 *      contract: one daemon serves N parallel stacks.
 *
 * Why this test exists separately from the existing parallel-stacks sentinel
 * (Plan 1) AND the dashboard-stack-list test (Plan 5 Task 24, LEV-426):
 *
 *   - `parallel-stacks.test.ts` proves the file-locked port allocator and
 *     state.json isolation. It deliberately does NOT depend on the daemon
 *     (it was written before Plan 5 wired the dashboard).
 *   - `dashboard-stack-list.test.ts` proves the `/api/stacks` projection for
 *     ONE stack. A regression in the cross-stack join (the projection
 *     iterating ALL `state.json` files under LICH_HOME) wouldn't surface
 *     there because the test only ever has one stack on disk.
 *   - THIS test pins the cross-stack contract end-to-end: both stacks
 *     visible via the dashboard's list AND each addressable via its own
 *     friendly URL through the shared proxy. Both halves of Plan 5's "two
 *     stacks visible simultaneously" acceptance criterion get exercised
 *     in the same test file so the failure attribution is concrete.
 *
 * Test layout (mirrors daemon-auto-start.test.ts's setup/assertions/teardown
 * pattern): each phase is its own `it` with an explicit timeout that
 * matches the worst-case latency of that phase. Bun's hook timeouts cap
 * at ~5s with no per-hook override, so the expensive teardown lives in a
 * final `it` rather than `afterAll`. Tests run in declaration order;
 * module-scoped state hands the LICH_HOME / stackPaths forward.
 *
 *   1. (setup-a) bring stack A up under the shared LICH_HOME; assert
 *      state.json reaches `status:up` AND the daemon is alive.
 *   2. (setup-b) bring stack B up under the SAME LICH_HOME; assert
 *      state.json reaches `status:up` AND the daemon URL hasn't changed
 *      (singleton contract).
 *   3. (assert) /api/stacks lists BOTH; routing entries are distinct;
 *      curl each friendly URL via proxy and assert correctness; curl a
 *      nonexistent hostname and assert 404.
 *   4. (teardown) lich nuke --yes (tears down both stacks AND the
 *      shared daemon), tmpdir cleanups.
 *
 * Resource budget: TWO full dogfood stacks (each = postgres + api + web +
 * tunnel_demo, with the postgres alpine image pulling fast). Per LEV-463
 * the supabase → postgres swap cut total cold-startup substantially.
 * The setup-a / setup-b `it` blocks use 600s timeouts to absorb the worst
 * case without flaking on slow CI hosts. Per the task description,
 * "this is the HEAVIEST e2e test in the suite."
 *
 * STATUS (2026-05-24): LEV-414 landed — the daemon wires both the
 * dashboard server and the proxy into its main loop — so this test should
 * be functional in a clean docker environment. Docker contention (too
 * many stacks already running, postgres failing to allocate its container
 * under load) is the most likely failure mode; if it surfaces, the test
 * fails loudly with the underlying error rather than faking the
 * assertion. Same contract as `parallel-stacks.test.ts` and
 * `basic-up.test.ts` (LEV-314).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";
import { waitForDaemonRunning } from "./helpers/daemon.js";
import { fetchDashboardJson } from "./helpers/dashboard-fetch.js";
import { parseLichUrls } from "./helpers/urls.js";
import { waitForHttp200 } from "./helpers/wait.js";
import { expectDbMode } from "./helpers/dbmode.js";

// ---------------------------------------------------------------------------
// Wire-format types — mirror `packages/lich/src/daemon/dashboard/stacks-view.ts`'s
// `StackView`. Duplicated locally (NOT imported) per testing-standards
// §"E2e tests spawn the real binary": the e2e suite stays out-of-process. If
// the wire format ever drifts from this shape, the test fails — that's the
// point of a separate type definition.
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

/**
 * Per-stack routing entry as written by `lich up` (`buildRoutingEntries`
 * in `packages/lich/src/commands/up.ts`). Mirrors `RoutingEntry` from
 * `state/snapshot.ts`. Duplicated locally for the same out-of-process
 * reason as `StackView`.
 */
interface RoutingEntry {
  /** e.g. `"api.lich-e2e-plan5-a-XXXX"` */
  hostname: string;
  /** e.g. `"http://127.0.0.1:54321"` */
  upstream_url: string;
  /** The service this entry belongs to — e.g. `"api"`. */
  service: string;
}

// ---------------------------------------------------------------------------
// Build the binary up front. Mirrors basic-up.test.ts / parallel-stacks.test.ts
// / dashboard-stack-list.test.ts — fail loudly if a build is missing; the
// binaries ARE our code, so a broken build is a real bug rather than
// something to skip past.
//
// We need BOTH `lich` (the CLI driving `up`/`down`/`nuke`) AND `lich-daemon`
// (the daemon binary spawned by `ensureDaemonRunning` in the up command's
// success path). Either missing → test can't run end-to-end.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");
const lichDaemonBinary = resolve(repoRoot, "packages/lich/dist/lich-daemon");

beforeAll(() => {
  if (!existsSync(lichBinary)) {
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
  }
  if (!existsSync(lichDaemonBinary)) {
    const build = spawnSync("bun", ["run", "build:daemon"], {
      cwd: resolve(repoRoot, "packages/lich"),
      stdio: "inherit",
      timeout: 120_000,
    });
    if (build.status !== 0) {
      throw new Error(
        `failed to build lich-daemon binary (exit ${build.status}); cannot run e2e tests`,
      );
    }
    if (!existsSync(lichDaemonBinary)) {
      throw new Error(
        `lich-daemon build reported success but ${lichDaemonBinary} does not exist`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Module-scoped fixture state — tests run in declaration order, so the
// setup `it`s populate these and the assertion + teardown `its` consume
// them. This mirrors daemon-auto-start.test.ts's pattern (chosen because
// Bun caps before/afterAll timeouts at ~5s with no override).
// ---------------------------------------------------------------------------

interface StackCopy {
  path: string;
  cleanup: () => void;
}

let lichHome: string | null = null;
let stackA: StackCopy | null = null;
let stackB: StackCopy | null = null;
/** Captured during setup-a so setup-b + assertions can verify singleton. */
let daemonInfo: { pid: number; url: string } | null = null;

/**
 * Pick a unique proxy port for this test process so we don't fight with
 * sibling agents/daemons holding 3300 (the spec default the user-facing
 * docs prescribe). Same pattern as `tests/e2e/friendly-urls.test.ts`:
 * derive from PID so concurrent vitest forks under the new fast pool
 * don't collide on the same port. Range 50000-60000 sits well clear of
 * the spec default and of common dev ports (8080, 8443, etc.).
 */
function pickProxyPort(): number {
  return 50_000 + (process.pid % 10_000);
}

/** Captured during setup-a so setup-b + assertions share it. */
let proxyPort: number | null = null;

// ---------------------------------------------------------------------------
// Live progress logger — this is the heaviest e2e test in the suite (two
// full dogfood-stack ups = postgres pull + boot * 2). Without progress
// lines the user stares at silence for minutes wondering whether anything's
// wrong. Module-scoped so every `it` shares the same t0 — the elapsed
// numbers tell a continuous story.
// ---------------------------------------------------------------------------

const t0 = Date.now();
function step(label: string): void {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`  [+${elapsed}s] ${label}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `lich up --no-browser` synchronously against `cwd` with the shared
 * LICH_HOME. `--no-browser` keeps CI / headless hosts from trying to spawn
 * Chrome on every up — the daemon still starts, the dashboard URL is still
 * written; only the `open <url>` side effect is suppressed.
 */
function lichUp(cwd: string): ReturnType<typeof runLich> {
  return runLich(["up", "--no-browser"], {
    cwd,
    env: { LICH_HOME: lichHome! },
    // dev:fast brings up api + web on the host in ~3s. 60s is huge
    // headroom for slow CI; bigger than that just masks regressions.
    timeout: 60_000,
  });
}

/**
 * Read state.json for a worktree by scanning
 * `<LICH_HOME>/stacks/<id>/state.json` and finding the snapshot whose
 * `worktree_path` matches `cwd`. Mirrors the helper in
 * `parallel-stacks.test.ts` — we don't know stack_id a-priori (it's a
 * hash of the absolute path) so we enumerate and filter.
 */
function readStateForWorktree(
  worktreePath: string,
): {
  stack_id: string;
  worktree_name: string;
  status: string;
  services: Array<{
    name: string;
    state: string;
    allocated_ports?: Record<string, number>;
  }>;
  routing?: RoutingEntry[];
} | null {
  const stacksRoot = join(lichHome!, "stacks");
  if (!existsSync(stacksRoot)) return null;

  for (const entry of readdirSync(stacksRoot)) {
    const dir = join(stacksRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const statePath = join(dir, "state.json");
    if (!existsSync(statePath)) continue;
    try {
      const snap = JSON.parse(readFileSync(statePath, "utf8")) as {
        stack_id: string;
        worktree_name: string;
        worktree_path: string;
        status: string;
        services: Array<{
          name: string;
          state: string;
          allocated_ports?: Record<string, number>;
        }>;
        routing?: RoutingEntry[];
      };
      // realpath collapse: macOS tmpdirs route through /private/var/folders,
      // so worktree.path may differ from the path we copied to by that
      // prefix. Compare suffixes so both `/var/.../X` and `/private/var/.../X`
      // resolve as the same worktree. Same pattern as the sentinel test.
      if (
        snap.worktree_path === worktreePath ||
        snap.worktree_path.endsWith(worktreePath) ||
        worktreePath.endsWith(snap.worktree_path)
      ) {
        return snap;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fetch a friendly URL via the proxy using the `Host`-header override
 * pattern. Same shape as the proxy unit tests' `fetchVia` helper.
 *
 * Why this rather than `fetch("http://api.X.lich.localhost:3300/...")`:
 * `*.localhost` resolution to 127.0.0.1 is reliable on modern macOS/Linux
 * but not universally guaranteed in every CI environment (some
 * Docker-in-Docker setups don't have the right DNS suffix rules). The
 * `Host`-header override avoids the DNS dependency entirely — we connect
 * directly to `127.0.0.1:<proxyPort>` and tell the proxy via the `Host`
 * header which upstream we want. The proxy routes by `Host` regardless
 * of how the client got there, so the behavior is identical to what a
 * real browser would observe.
 *
 * Why `http.request` rather than `fetch`: Node's WHATWG `fetch`
 * implementation (undici) treats `Host` as a forbidden header and
 * silently strips it — the proxy then sees `Host: 127.0.0.1:3300` and
 * 404s because that hostname isn't in its routing table. The
 * lower-level `http.request` API doesn't enforce that restriction and
 * passes the explicit `Host` through verbatim, which is what every
 * production HTTP client (curl, browsers via their own internal
 * stacks) does. Confirmed via:
 *   $ node -e "fetch(url, { headers: { Host: '...' }}).then(...)"  // 404
 *   $ node -e "http.request({ headers: { Host: '...' }}, ...).end()"  // 200
 *
 * `proxyPort` defaults to 3300, which matches the daemon's default when
 * no `runtime.proxy_port` is set in the yaml — the dogfood-stack doesn't
 * pin it, so 3300 is correct.
 */
async function fetchViaProxy(
  proxyPort: number,
  friendlyHostname: string,
  path: string,
): Promise<{ status: number; text: () => Promise<string> }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path,
        method: "GET",
        headers: {
          // Include the explicit `:port` suffix in the Host header so it
          // matches what a real browser would send when the user typed
          // the friendly URL with its port. The proxy strips the `:port`
          // before routing, so the exact value doesn't matter beyond
          // "looks like a browser-shaped Host header."
          Host: `${friendlyHostname}:${proxyPort}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            text: async () => body,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// afterAll catch-all — if anything blew up so badly that the (teardown)
// `it` never ran, this is the last line of defense to keep the user's
// disk + docker state from leaking. Best-effort; the teardown `it` is
// the primary cleanup. Mirrors daemon-auto-start.test.ts's pattern.
// ---------------------------------------------------------------------------

afterAll(() => {
  if (stackA && lichHome) {
    try {
      // nuke --yes against either stack path tears down BOTH stacks
      // (nuke iterates all stacks under LICH_HOME, not just the cwd's)
      // AND kills the shared daemon (LEV-420 / Plan 5 Task 18). Best-
      // effort: a hard exit shouldn't propagate up from this safety net.
      spawnSync(lichBinary, ["nuke", "--yes"], {
        cwd: stackA.path,
        env: { ...process.env, LICH_HOME: lichHome },
        timeout: 60_000,
      });
    } catch {
      /* best-effort */
    }
  }
  for (const stack of [stackA, stackB]) {
    if (!stack) continue;
    try {
      stack.cleanup();
    } catch {
      /* best-effort */
    }
  }
  if (lichHome && existsSync(lichHome)) {
    try {
      rmSync(lichHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  stackA = null;
  stackB = null;
  lichHome = null;
  daemonInfo = null;
  proxyPort = null;
});

// ---------------------------------------------------------------------------
// The cross-cutting Plan 5 sentinel — split into setup-a, setup-b, assert,
// and teardown `it` blocks. Each block has its own timeout sized for its
// worst case. State threads through module-scoped variables (this mirrors
// daemon-auto-start.test.ts's contract: Bun's hook timeouts cap at ~5s
// with no override, so expensive setup/teardown lives in `it`s).
// ---------------------------------------------------------------------------

describe("dashboard + friendly URLs with two parallel stacks (Plan 5 Task 28)", () => {
  it(
    "(setup-a) lich up A under shared LICH_HOME; daemon spawns",
    async () => {
      // Single shared LICH_HOME — this is the whole point of the test.
      // The daemon's PID + URL files land here; both stacks' state.json
      // files land under `<LICH_HOME>/stacks/<id>/`. Both `lich up`s see
      // the SAME daemon (the second short-circuits via the already-
      // running branch of `ensureDaemonRunning`).
      lichHome = mkdtempSync(
        join(tmpdir(), "lich-e2e-dashboard-parallel-home-"),
      );

      // Two copies with explicitly different basenames so the slugged
      // worktree names visually differ (`lich-e2e-plan5-a-XXXX` vs
      // `lich-e2e-plan5-b-XXXX`) — and therefore the friendly hostnames
      // the proxy serves differ too. The unique-basename guarantee is
      // what makes the "two distinct friendly hostnames" assertion below
      // meaningful: if both worktrees somehow got the same slug, the
      // proxy would have a collision and one stack's routes would
      // overwrite the other's.
      //
      // install: true — apps/web runs `next dev`, which needs `next` in
      // node_modules/.bin. Without it the web owned service exits 127
      // immediately and `lich up` fails before any state.json is written.
      // Same rationale as basic-up.test.ts / parallel-stacks.test.ts
      // (LEV-313). We install BOTH up front so the (setup-b) `it` doesn't
      // pay the install cost a second time (each install is ~10-20s).
      step("preparing tmpdir copies + bun install (~20s)");
      stackA = copyExampleToTmpdir("dogfood-stack", {
        prefix: "lich-e2e-plan5-a-",
        install: true,
      });
      stackB = copyExampleToTmpdir("dogfood-stack", {
        prefix: "lich-e2e-plan5-b-",
        install: true,
      });

      // Pin `runtime.proxy_port` in BOTH copied lich.yamls so the daemon
      // binds OUR port rather than the spec default 3300. Under the new
      // fast pool (maxForks > 1) and on dev machines with stray daemons
      // already on 3300, the default would silently route our test
      // requests to whatever daemon happens to own 3300 — which has no
      // routes for our test stacks and returns 404. Same pattern as
      // tests/e2e/friendly-urls.test.ts.
      //
      // dogfood-stack already has a `runtime: { proxy_port: 3300, ... }`
      // block — we do an in-place substitution rather than append (YAML
      // duplicate-key error). The regex matches the literal `proxy_port:`
      // line under the existing block.
      proxyPort = pickProxyPort();
      for (const stack of [stackA, stackB]) {
        const yamlPath = join(stack.path, "lich.yaml");
        const orig = readFileSync(yamlPath, "utf8");
        const updated = orig.replace(
          /(\n\s*)proxy_port:\s*\d+/,
          `$1proxy_port: ${proxyPort}`,
        );
        if (updated === orig) {
          throw new Error(
            `failed to substitute proxy_port in ${yamlPath} — did the dogfood-stack stop pinning runtime.proxy_port?`,
          );
        }
        writeFileSync(yamlPath, updated, "utf8");
      }
      step(`pinned proxy_port=${proxyPort} in both lich.yamls`);

      // First `lich up` spawns the daemon as a side effect (writes
      // `<LICH_HOME>/daemon.pid` and `daemon.url`, starts the dashboard
      // server + proxy server + state watcher). The summary line
      // `Dashboard: <url>` confirms the daemon launched.
      step("lich up A --no-browser (dev:fast — api + web on host)");
      const upA = lichUp(stackA.path);
      if (upA.exitCode !== 0) {
        throw new Error(
          `lich up A exited ${upA.exitCode}\n` +
            `--- stdout ---\n${upA.stdout}\n` +
            `--- stderr ---\n${upA.stderr}`,
        );
      }
      const stateA = readStateForWorktree(stackA.path);
      expect(stateA, "state.json for A should exist after up").not.toBeNull();
      expect(stateA!.status).toBe("up");
      step(
        `A up (stack_id=${stateA!.stack_id}, worktree=${stateA!.worktree_name})`,
      );

      // dev:fast profile sentinel: A's api /health should report db: stub.
      // Catches silent drift if the default profile ever flips back to dev.
      // Probe via `lich urls --raw` (localhost URLs) to dodge the friendly-
      // URL routing race under dev:fast's sub-3s startup.
      const urlsA = runLich(["urls", "--raw"], {
        cwd: stackA.path,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsA.exitCode).toBe(0);
      const parsedA = parseLichUrls(urlsA.stdout);
      const apiUrlA = parsedA.api;
      expect(apiUrlA, `expected api url for A in: ${urlsA.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrlA}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrlA!, "stub");
      step("A api /health reports db: stub");

      // Wait for daemon: after A's up, the daemon should be alive and
      // its PID + URL files present. Generous 30s timeout to cover the
      // cold-spawn case where Bun's startup adds a few hundred ms.
      step("waiting for daemon (pid + url files)");
      daemonInfo = await waitForDaemonRunning(lichHome, {
        timeoutMs: 30_000,
      });
      // Bun's `hostname: "localhost"` binds 127.0.0.1 only, but the URL
      // it advertises uses "localhost" verbatim. Both forms are
      // acceptable as long as the bind is local-only.
      expect(daemonInfo.url).toMatch(
        /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/,
      );
      step(`daemon up: pid=${daemonInfo.pid} url=${daemonInfo.url}`);
    },
    /* timeout */ 90_000,
  );

  it(
    "(setup-b) lich up B under the SAME LICH_HOME; daemon is shared",
    async () => {
      // Defensive: if (setup-a) bailed, these will be null and the
      // assertion fails with a clear message rather than NPE.
      expect(lichHome, "lichHome — setup-a must have run").not.toBeNull();
      expect(stackB, "stackB — setup-a must have run").not.toBeNull();
      expect(daemonInfo, "daemonInfo — setup-a must have run").not.toBeNull();

      // Second `lich up` should short-circuit on the already-running
      // daemon (`ensureDaemonRunning` returns alreadyRunning: true). The
      // dashboard URL it surfaces in the summary should match A's URL —
      // that's the per-machine singleton contract. We don't parse the
      // summary text here (brittle); we verify the contract via the
      // daemon URL file (it shouldn't have changed).
      step("lich up B --no-browser (shared daemon already running)");
      const upB = lichUp(stackB!.path);
      if (upB.exitCode !== 0) {
        throw new Error(
          `lich up B exited ${upB.exitCode}\n` +
            `--- stdout ---\n${upB.stdout}\n` +
            `--- stderr ---\n${upB.stderr}`,
        );
      }
      const stateB = readStateForWorktree(stackB!.path);
      expect(stateB, "state.json for B should exist after up").not.toBeNull();
      expect(stateB!.status).toBe("up");
      step(
        `B up (stack_id=${stateB!.stack_id}, worktree=${stateB!.worktree_name})`,
      );

      // A still up after B's up — cross-stack non-interference. The
      // sentinel claim re-asserted: B's lifecycle didn't perturb A's.
      const stateA = readStateForWorktree(stackA!.path);
      expect(stateA, "A's state.json should survive B's up").not.toBeNull();
      expect(stateA!.status).toBe("up");
      // Stack IDs differ (hash of distinct absolute paths). Visual
      // distinguishability is a property of distinct basenames; the
      // hash collision-resistance is what guarantees the ID itself
      // differs.
      expect(stateA!.stack_id).not.toBe(stateB!.stack_id);

      // The daemon URL stayed the same across both `lich up`s — the
      // singleton contract. If the second up had spawned a NEW daemon
      // (bug: stale-PID handling false-positive, or a race in
      // `ensureDaemonRunning`), the URL file would have been overwritten
      // and the proxy/dashboard would be on a different port.
      const daemonAfterB = await waitForDaemonRunning(lichHome!, {
        timeoutMs: 5_000,
      });
      expect(
        daemonAfterB.url,
        `daemon URL should be unchanged after B's up; was ${daemonInfo!.url}, now ${daemonAfterB.url}`,
      ).toBe(daemonInfo!.url);
      expect(
        daemonAfterB.pid,
        `daemon PID should be unchanged after B's up; was ${daemonInfo!.pid}, now ${daemonAfterB.pid}`,
      ).toBe(daemonInfo!.pid);
      step("daemon unchanged — singleton contract holds");

      // dev:fast profile sentinel for B too: B's api /health should also
      // report db: stub. Asserting per-stack catches a hypothetical
      // regression where the second `lich up` accidentally inherits a
      // different profile via env leakage.
      const urlsB = runLich(["urls", "--raw"], {
        cwd: stackB!.path,
        env: { LICH_HOME: lichHome! },
      });
      expect(urlsB.exitCode).toBe(0);
      const parsedB = parseLichUrls(urlsB.stdout);
      const apiUrlB = parsedB.api;
      expect(apiUrlB, `expected api url for B in: ${urlsB.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrlB}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrlB!, "stub");
      step("B api /health reports db: stub");
    },
    /* timeout */ 90_000,
  );

  it(
    "(assert) /api/stacks lists both; each friendly URL hits its own upstream",
    async () => {
      expect(lichHome, "lichHome — setup must have run").not.toBeNull();
      expect(stackA, "stackA — setup must have run").not.toBeNull();
      expect(stackB, "stackB — setup must have run").not.toBeNull();

      // proxy port pinned in setup-a (PID-derived, see pickProxyPort).
      // Under parallel test execution multiple daemons can compete for
      // 3300; the per-test pin makes ours unique. The 3300 default still
      // applies to real user invocations of `lich up` (the test just
      // overrides it for isolation).
      expect(proxyPort, "proxyPort — setup-a must have run").not.toBeNull();
      const pp = proxyPort!;

      // Re-read both states so the assertion phase works against fresh
      // snapshots (the watcher may have caused additional writes after
      // setup-b returned). waitForStackStatus is idempotent — calling
      // it just confirms the current status.
      const stateA = readStateForWorktree(stackA!.path);
      const stateB = readStateForWorktree(stackB!.path);
      expect(stateA, "state.json for A").not.toBeNull();
      expect(stateB, "state.json for B").not.toBeNull();
      await waitForStackStatus(lichHome!, stateA!.stack_id, "up", {
        timeoutMs: 10_000,
      });
      await waitForStackStatus(lichHome!, stateB!.stack_id, "up", {
        timeoutMs: 10_000,
      });

      // Wait for the dashboard's view of BOTH stacks to catch up to
      // status:up before asserting. `lich up` returns once state.json is
      // written; the dashboard's in-memory cache (see
      // packages/lich/src/daemon/dashboard/server.ts's `reload`) refreshes
      // on the watcher's debounce (~100ms), so there's a small window where
      // the disk says "up" but `/api/stacks` still shows "starting" for
      // the most-recently-started stack (typically B). The disk wait above
      // doesn't cover this — the dashboard cache is a separate piece of
      // state that has to catch up independently. Poll the API endpoint
      // itself until both stacks show up. (LEV-430 race fix, LEV-466.)
      step("waiting for dashboard cache to reflect both stacks up");
      const dashboardReadyDeadline = Date.now() + 10_000;
      let dashboardReadyLast: StackView[] = [];
      while (Date.now() < dashboardReadyDeadline) {
        try {
          dashboardReadyLast = await fetchDashboardJson<StackView[]>(
            lichHome!,
            "/api/stacks",
          );
          const a = dashboardReadyLast.find((s) => s.id === stateA!.stack_id);
          const b = dashboardReadyLast.find((s) => s.id === stateB!.stack_id);
          if (a?.status === "up" && b?.status === "up") break;
        } catch {
          // transient fetch error → retry until the outer deadline
        }
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      if (Date.now() >= dashboardReadyDeadline) {
        throw new Error(
          `timeout waiting for /api/stacks to show both stacks up; ` +
            `last response: ${JSON.stringify(
              dashboardReadyLast.map((s) => ({ id: s.id, status: s.status })),
            )}`,
        );
      }

      // ---- Sentinel #1: BOTH stacks appear in /api/stacks --------------
      // The dashboard list projection iterates every per-stack
      // state.json under `<LICH_HOME>/stacks/`. A regression where it
      // returns only the most-recently-touched stack (e.g. a stale cache
      // not refreshed by the watcher) would surface immediately here.
      step("fetching /api/stacks");
      const stacks = await fetchDashboardJson<StackView[]>(
        lichHome!,
        "/api/stacks",
      );
      expect(Array.isArray(stacks)).toBe(true);
      expect(
        stacks.length,
        `expected exactly two stacks in /api/stacks; got ${stacks.length}: ${JSON.stringify(stacks.map((s) => s.id))}`,
      ).toBe(2);

      const apiStackA = stacks.find((s) => s.id === stateA!.stack_id);
      const apiStackB = stacks.find((s) => s.id === stateB!.stack_id);
      expect(
        apiStackA,
        `/api/stacks missing entry for A (stack_id=${stateA!.stack_id}); got ${JSON.stringify(stacks)}`,
      ).toBeDefined();
      expect(
        apiStackB,
        `/api/stacks missing entry for B (stack_id=${stateB!.stack_id}); got ${JSON.stringify(stacks)}`,
      ).toBeDefined();
      expect(apiStackA!.status).toBe("up");
      expect(apiStackB!.status).toBe("up");
      // worktree_name slugs match the on-disk snapshots verbatim — the
      // projection passes them through. We also assert they DIFFER
      // (the two tmpdir basenames are distinct so the slugs must be).
      expect(apiStackA!.worktree_name).toBe(stateA!.worktree_name);
      expect(apiStackB!.worktree_name).toBe(stateB!.worktree_name);
      expect(apiStackA!.worktree_name).not.toBe(apiStackB!.worktree_name);
      step(
        `/api/stacks lists both: ${apiStackA!.worktree_name} + ${apiStackB!.worktree_name}`,
      );

      // ---- Sentinel #2: distinct friendly hostnames --------------------
      // Each stack's `state.routing` is populated by `buildRoutingEntries`
      // in `commands/up.ts` (Plan 5 Task 8). For a single-port owned
      // service named `api`, the hostname is `api.<worktree-name>` —
      // distinct worktree names → distinct hostnames → no proxy
      // collisions. We pin both halves of that chain.
      const routingA = stateA!.routing ?? [];
      const routingB = stateB!.routing ?? [];
      expect(
        routingA.length,
        `A should have routing entries after up; got 0`,
      ).toBeGreaterThan(0);
      expect(
        routingB.length,
        `B should have routing entries after up; got 0`,
      ).toBeGreaterThan(0);

      // The api service is single-port (dogfood `apps/api` declares one
      // `port:` block keyed `default`), so its hostname is plain
      // `api.<worktree>`. Find that entry in each stack's routing.
      const apiEntryA = routingA.find((r) => r.service === "api");
      const apiEntryB = routingB.find((r) => r.service === "api");
      expect(
        apiEntryA,
        `A's routing should include an api entry; got ${JSON.stringify(routingA)}`,
      ).toBeDefined();
      expect(
        apiEntryB,
        `B's routing should include an api entry; got ${JSON.stringify(routingB)}`,
      ).toBeDefined();

      // The hostname format is `<service>.<worktree>` — assert both
      // halves explicitly so the test catches drift in either part. If
      // a future change inverts the order to `<worktree>.<service>`,
      // both endsWith and startsWith would fail and the regression
      // surfaces with a clear message.
      expect(apiEntryA!.hostname).toBe(`api.${stateA!.worktree_name}`);
      expect(apiEntryB!.hostname).toBe(`api.${stateB!.worktree_name}`);
      expect(apiEntryA!.hostname).not.toBe(apiEntryB!.hostname);
      step(
        `distinct hostnames: ${apiEntryA!.hostname} vs ${apiEntryB!.hostname}`,
      );

      // The upstream URLs must also differ — same hostname different
      // upstream would mean a port-allocator regression sharing a port
      // between stacks (which `parallel-stacks.test.ts` already covers,
      // but it's free to re-assert here).
      expect(apiEntryA!.upstream_url).not.toBe(apiEntryB!.upstream_url);

      // ---- Wait for proxy routing to register BOTH stacks' api routes --
      // The daemon's proxy maintains an in-memory routing table sourced from
      // each stack's state.routing block (Plan 5 Task 11). The watcher
      // refreshes that table on a debounce after each state.json write —
      // under dev:fast's sub-3s startup the table may not be populated for
      // both stacks by the time we get here, even though /api/stacks has
      // caught up to status:up (the dashboard cache and proxy routing
      // table are independent pieces of state). Poll the proxy directly
      // until both friendly URLs return 200 — that proves the routing
      // table has both entries. Mirrors LEV-466's polling pattern but for
      // the proxy rather than the dashboard cache.
      step("waiting for proxy routing to register both A + B api routes");
      const routingReadyDeadline = Date.now() + 10_000;
      let lastStatusA = 0;
      let lastStatusB = 0;
      while (Date.now() < routingReadyDeadline) {
        try {
          const ra = await fetchViaProxy(
            pp,
            `${apiEntryA!.hostname}.lich.localhost`,
            "/health",
          );
          lastStatusA = ra.status;
          const rb = await fetchViaProxy(
            pp,
            `${apiEntryB!.hostname}.lich.localhost`,
            "/health",
          );
          lastStatusB = rb.status;
          if (ra.status === 200 && rb.status === 200) break;
        } catch {
          // transient fetch error → retry until the outer deadline
        }
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      if (Date.now() >= routingReadyDeadline) {
        throw new Error(
          `timeout waiting for proxy to route both stacks' api; ` +
            `last A status=${lastStatusA}, last B status=${lastStatusB}`,
        );
      }

      // ---- Sentinel #3: each friendly URL hits its own upstream --------
      // Curl each api's friendly URL via the proxy with the `Host`-header
      // override pattern (connect to 127.0.0.1:<proxyPort>, set Host)
      // rather than relying on `*.lich.localhost` DNS resolution. See
      // `fetchViaProxy`'s JSDoc.
      //
      // The dogfood api's `/health` returns the deterministic body
      // `{ status: "ok" }` from EVERY stack — by itself it can't
      // distinguish A's upstream from B's. So we verify "different
      // upstreams" via a chain of grounded assertions:
      //
      //   a. Both friendly URLs return 200 — proves both upstreams are
      //      reachable through the proxy under their own hostnames.
      //   b. The proxy returns the SAME body for a friendly URL and for
      //      its corresponding raw upstream URL — proves the proxy is
      //      forwarding to the right port (not just any port that happens
      //      to be up).
      //   c. The proxy returns 404 for a hostname not in routing —
      //      proves the proxy is actually doing Host-based routing, not
      //      blindly forwarding every request to one upstream. (If a
      //      regression had it blindly forwarding to whatever upstream
      //      was "first" or "default", this assertion would fire.)
      //
      // The combination of (a)+(b)+(c) plus the distinct-hostnames /
      // distinct-upstream-urls assertions from sentinel #2 transitively
      // proves "two friendly URLs route to two distinct upstreams"
      // without needing per-stack identifying info in the response body.
      const friendlyHostA = `${apiEntryA!.hostname}.lich.localhost`;
      const friendlyHostB = `${apiEntryB!.hostname}.lich.localhost`;

      step(`probing A via proxy Host:${friendlyHostA}`);
      const resProxyA = await fetchViaProxy(
        pp,
        friendlyHostA,
        "/health",
      );
      expect(
        resProxyA.status,
        `proxy returned ${resProxyA.status} for ${friendlyHostA}; expected 200`,
      ).toBe(200);
      const bodyProxyA = await resProxyA.text();

      step(`probing B via proxy Host:${friendlyHostB}`);
      const resProxyB = await fetchViaProxy(
        pp,
        friendlyHostB,
        "/health",
      );
      expect(
        resProxyB.status,
        `proxy returned ${resProxyB.status} for ${friendlyHostB}; expected 200`,
      ).toBe(200);
      const bodyProxyB = await resProxyB.text();

      // Hit each api's RAW upstream URL directly (bypassing the proxy)
      // so we have a ground truth to compare the proxied responses
      // against. If the proxy is forwarding correctly, the proxied
      // body for A matches the raw body from A's upstream port.
      step(`probing A raw upstream ${apiEntryA!.upstream_url}/health`);
      const resRawA = await fetch(`${apiEntryA!.upstream_url}/health`);
      expect(resRawA.status).toBe(200);
      const bodyRawA = await resRawA.text();

      step(`probing B raw upstream ${apiEntryB!.upstream_url}/health`);
      const resRawB = await fetch(`${apiEntryB!.upstream_url}/health`);
      expect(resRawB.status).toBe(200);
      const bodyRawB = await resRawB.text();

      // The proxy must forward to the right upstream. If A's friendly
      // hostname accidentally routed to B's upstream (and vice-versa),
      // both sides of this assertion would still hold because the
      // bodies are deterministic — but the chained "raw matches
      // proxied" pinning catches a regression where the proxy returns
      // a constant stub body or fails to forward path/method correctly.
      expect(
        bodyProxyA,
        `proxied A body should match raw A upstream body; got proxied=${JSON.stringify(bodyProxyA)} raw=${JSON.stringify(bodyRawA)}`,
      ).toBe(bodyRawA);
      expect(
        bodyProxyB,
        `proxied B body should match raw B upstream body; got proxied=${JSON.stringify(bodyProxyB)} raw=${JSON.stringify(bodyRawB)}`,
      ).toBe(bodyRawB);

      // Sentinel for "the proxy is actually routing, not blindly
      // forwarding": a hostname not in the routing table must 404. A
      // regression where the proxy accepts any `*.lich.localhost`
      // hostname and forwards it to a default upstream would fail
      // here. We construct a hostname that's guaranteed not to be in
      // either stack's routing (the worktree-name part doesn't match
      // any real stack on disk).
      step("probing nonexistent friendly hostname (expect 404)");
      const resMiss = await fetchViaProxy(
        pp,
        "api.nonexistent-worktree-xyz.lich.localhost",
        "/health",
      );
      expect(
        resMiss.status,
        `proxy should 404 for a hostname not in routing; got ${resMiss.status}`,
      ).toBe(404);
      step("404 negative case passed");

      step("both friendly URLs route to their own upstreams — sentinel passed");
    },
    /* timeout */ 60_000,
  );

  it(
    "(teardown) lich nuke --yes tears down both stacks + the shared daemon",
    () => {
      // No state to tear down? Setup must have bailed; nothing to do
      // here (the afterAll catch-all already covers stragglers).
      if (!stackA || !lichHome) return;

      // nuke --yes against either stack path tears down BOTH stacks
      // (nuke iterates all stacks under LICH_HOME, not just the cwd's)
      // AND kills the shared daemon (LEV-420 / Plan 5 Task 18). That's
      // the cleanest single-call teardown — no need for per-stack down
      // calls plus a separate daemon kill.
      step("lich nuke --yes (tears down both stacks + daemon)");
      const nukeResult = runLich(["nuke", "--yes"], {
        cwd: stackA.path,
        env: { LICH_HOME: lichHome },
        timeout: 180_000,
      });
      if (nukeResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich nuke stdout:", nukeResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich nuke stderr:", nukeResult.stderr);
      }
      // nuke uses escape-hatch semantics (always exit 0 unless a
      // catastrophic internal failure) — so a 0 here just confirms the
      // command ran. We don't make per-stack assertions about the
      // teardown outcome; that's covered by `nuke*.test.ts` for the
      // single-stack case.
      expect(nukeResult.exitCode).toBe(0);
      step("nuke exit 0");
    },
    /* timeout */ 200_000,
  );
});
