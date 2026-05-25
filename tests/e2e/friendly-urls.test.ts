/**
 * Friendly-URL reverse proxy end-to-end — Plan 5 Task 23 (LEV-425).
 *
 * The "friendly URL" is the user-visible payoff of Plan 5: instead of
 * having to remember `http://localhost:<random-allocated-port>/`, the user
 * can hit `http://<service>.<worktree>.lich.localhost:<proxy-port>/` for
 * any service in any worktree on their machine, and the lich daemon's
 * reverse proxy (LEV-413) routes the request to the right upstream.
 *
 * This test pins that promise against the real dogfood-stack:
 *
 *   1. `lich up --no-browser` brings up the stack AND triggers the
 *      daemon auto-start (LEV-411). The copied lich.yaml has a per-test
 *      `runtime.proxy_port` (see `pickProxyPort`) appended to it so the
 *      daemon binds OUR port — avoiding contention with the spec default
 *      3300, which a sibling agent's worktree or a stray dev daemon may
 *      already own.
 *   2. Pull the worktree name and allocated ports out of state.json.
 *      The worktree name is the `<worktree>` slot in friendly hostnames
 *      (per `buildRoutingEntries` in commands/up.ts); the ports are the
 *      raw upstreams the proxy ultimately forwards to.
 *   3. Hit `http://api.<wt>.lich.localhost:<proxyPort>/health` via the
 *      proxy and assert (a) HTTP 200, (b) the body matches the raw
 *      `http://127.0.0.1:<api-port>/health` body verbatim. That equality
 *      is what proves the proxy is actually forwarding to the right
 *      upstream — a regression that routed `api.<wt>` to some other
 *      service would yield a different body shape and fail this check.
 *   4. Same shape for `web.<wt>.lich.localhost:<proxyPort>/` — the
 *      Next.js dev server. We compare body lengths-and-prefix rather
 *      than full body because Next emits a `__NEXT_DATA__` blob that
 *      includes the requesting hostname and timestamps, which differ
 *      trivially across requests. The prefix (the HTML doctype + the
 *      first ~100 chars) is stable and proves we got the same page from
 *      the same upstream.
 *   5. Negative case: `http://nonexistent.<wt>.lich.localhost:<proxyPort>/`
 *      returns 404 from the proxy (NOT from the upstream — there IS no
 *      upstream, the proxy itself owns this 404 per proxy.ts's
 *      `notFoundBody`). Body should mention `lich.localhost` so a typo
 *      gives the user a debugging hint.
 *
 * ## Why we override the `Host` header instead of relying on DNS
 *
 * `*.lich.localhost` resolves to 127.0.0.1 on modern macOS / Linux per
 * RFC 6761 (the `localhost` TLD always points at loopback) — that's the
 * whole reason the spec picked the `.lich.localhost` suffix. But "modern"
 * isn't universal: some glibc resolvers, some Docker-tied DNS configs,
 * and some corporate VPN setups intercept `*.localhost` before the libc
 * stub resolver gets to apply RFC 6761. To keep this test robust across
 * environments, we connect directly to `http://localhost:<proxy-port>`
 * and set the `Host` header explicitly — same pattern the unit tests in
 * `packages/lich/tests/unit/daemon/proxy/proxy.test.ts` use (`fetchVia`).
 * Bun honors the explicit `Host` override, and the proxy routes purely
 * by `Host` header anyway, so the routing path is exactly what a browser
 * hitting `http://api.<wt>.lich.localhost:<proxyPort>/` would exercise.
 * See `fetchViaProxy`'s JSDoc for why `localhost` and not `127.0.0.1`.
 *
 * ## Why this test is separate from `basic-up.test.ts`
 *
 * `basic-up` proves the raw URLs (Plan 1 contract) work; this test
 * proves the friendly URLs (Plan 5 contract) work. The two contracts are
 * independent — a regression in the proxy would fail here without
 * affecting `basic-up`, and a regression in the orchestrator would fail
 * `basic-up` without reaching this test. Keeping them separate makes
 * failure attribution one-glance from the test name.
 *
 * `basic-up`'s `it.todo("serves the web app over http://web.<worktree>.
 * lich.localhost:3300/")` covers a narrower slice of what this test
 * already verifies; once LEV-414 is fully in we may promote that todo to
 * a real test, but the comprehensive coverage lives here.
 *
 * ## Isolation
 *
 * - tmpdir copy of dogfood-stack (the repo's source is never touched).
 * - LICH_HOME pointed at a per-test tmp directory — the daemon, its PID
 *   file, its URL file, and the stack's state.json all live there.
 * - lich binary built in `beforeAll` from packages/lich/ (matches the
 *   other e2e tests' pattern).
 *
 * ## Cleanup contract (testing-standards §"Resource cleanup contract")
 *
 * - `lich down` + `lich nuke --yes` run in `afterEach` even when the
 *   test body throws (nuke also tears down the daemon, per LEV-420 /
 *   Plan 5 Task 18). Both tmpdirs are recursively removed.
 * - Leaving the daemon behind would corrupt subsequent test runs (the
 *   next test's `lich up` would short-circuit on the already-running PID,
 *   pointing at THIS test's tmp LICH_HOME).
 *
 * ## Runtime budget
 *
 * ~5 minutes (LEV-463 swapped supabase for postgres so cold first-run is
 * ~10s instead of ~90s). The friendly-URL probes themselves are sub-
 * millisecond once the stack is up.
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
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForStackStatus } from "./helpers/state.js";
import { waitForDaemonRunning } from "./helpers/daemon.js";
import { waitForHttp200 } from "./helpers/wait.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Same pattern as basic-up.test.ts — fail loudly
// if the build is missing; the binary IS our code, a broken build is a real
// bug rather than something to skip.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

/**
 * Pick a per-test proxy port that won't collide with the spec default 3300
 * (which a sibling agent's worktree or a stray dev daemon may be holding).
 *
 * Why not just trust the spec default: this suite runs in CI alongside
 * potentially many other lich-touching tests AND sometimes on a developer
 * laptop where a "real" lich daemon is already bound to 3300. The daemon's
 * proxy-bind failure is swallowed silently (commands/daemon.ts logs a
 * warning and continues), so a contention-driven miss looks identical to
 * a routing bug from the test's perspective — both manifest as the proxy
 * 404'ing requests for OUR worktree's hostnames. Picking a high port that
 * varies per test process sidesteps the contention entirely.
 *
 * Range is the IANA dynamic/private range (49152-65535) less a small
 * margin; the modulo gives a stable-ish but varied value per process.
 * Bun.serve fails fast (within ms) if the port is taken, so on the rare
 * collision the daemon's bind error surfaces in the daemon log and we
 * notice — better than wedging on `waitForProxy200`.
 */
function pickProxyPort(): number {
  // Range 50000-60000 — well clear of the spec default 3300, well clear
  // of common dev ports (8080, 8443, etc.), and well clear of the
  // ephemeral range macOS uses for outbound connections (49152-65535
  // technically overlaps, but most outbound connects pick higher).
  return 50_000 + (process.pid % 10_000);
}

function makeFixture(proxyPort: number): Fixture {
  // install: true — apps/web runs `next dev`, which needs `next` in
  // node_modules/.bin. Without it the web owned service exits 127
  // immediately and `lich up` fails before state.json reaches "up".
  // Same justification as basic-up.test.ts (LEV-313).
  //
  // The `prefix` override (`lichfu-` instead of the default
  // `lich-e2e-dogfood-stack-`) is defensive: sibling agents running in
  // parallel worktrees sometimes periodically `rm -rf
  // /var/folders/.../lich-e2e-*` to clean up their own stragglers,
  // which would also nuke MY tmpdir mid-test (next.js then crashes
  // with MODULE_NOT_FOUND when its node_modules vanishes). Using a
  // distinct prefix sidesteps that glob.
  const stack = copyExampleToTmpdir("dogfood-stack", {
    install: true,
    prefix: "lichfu-",
  });
  const home = mkdtempSync(join(tmpdir(), "lichfu-home-"));

  // Pin `runtime.proxy_port` in the copied lich.yaml so the daemon binds
  // OUR port rather than the spec default 3300. The dogfood-stack's
  // lich.yaml has no `runtime:` block, so we append one. YAML's repeated
  // top-level keys are forbidden, but this file has no existing `runtime:`
  // so the append is safe. If the dogfood-stack ever grows a `runtime:`
  // block, this test needs to update the file in-place instead — caught
  // by the daemon's bind-fail surface (proxy 404s for our worktree).
  const yamlPath = join(stack.path, "lich.yaml");
  appendFileSync(
    yamlPath,
    `\nruntime:\n  proxy_port: ${proxyPort}\n`,
    "utf8",
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
  // LEV-465: timeouts tightened from 120s/60s → 20s. afterEach is a
  // fast cleanup path; vitest's hookTimeout caps at 60s. `lich nuke
  // --yes` was diagnosed at sub-200ms even when killing a live daemon.
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
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
      timeout: 20_000,
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
 * basic-up.test.ts's helper of the same name. The test only ever brings
 * one stack up, so the single-entry assumption holds.
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

/**
 * Fetch a request through the proxy with an explicit `Host` header. We
 * connect to `127.0.0.1:<proxyPort>` (where the proxy is bound — LEV-459
 * binds both IPv4 and IPv6 loopback) but tell the proxy we're hitting
 * `<hostHeader>` — exactly what a browser hitting
 * `http://<friendly-host>:<proxy-port>/` would send over the wire after
 * DNS resolves `*.lich.localhost` to loopback.
 *
 * Why explicit `Host` injection (rather than relying on `*.lich.localhost`
 * DNS): shields the test from environment-specific quirks in `*.localhost`
 * resolution (some glibc resolvers / Docker DNS / corporate VPN configs
 * intercept `*.localhost` before the libc stub resolver applies RFC 6761).
 * Bun's `fetch` honors the explicit `Host` override.
 *
 * Earlier this helper used `http://localhost:<port>` to dodge the IPv6-only
 * bind bug; LEV-459 fixed that (proxy now binds both stacks), so 127.0.0.1
 * is the safe explicit choice now.
 */
async function fetchViaProxy(
  proxyPort: number,
  hostHeader: string,
  path: string = "/",
): Promise<Response> {
  const headers = new Headers();
  headers.set("Host", hostHeader);
  // LEV-458 fixed the proxy's content-encoding double-decompress bug
  // (`buildClientResponse` now strips `content-encoding`/`content-length`
  // since Bun's `fetch` already decompressed upstream gzip). This used to
  // force `Accept-Encoding: identity` to dodge that bug; no longer needed.
  return fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers });
}

/**
 * Poll the proxy for an HTTP 200 against a friendly Host. Wraps the
 * polling pattern from `waitForHttp200` (helpers/wait.ts) but injects the
 * `Host` header through `fetchViaProxy`. We need polling specifically for
 * the very first request through the proxy: Bun's `fetch` connection-
 * pooling logic occasionally returns ECONNRESET on the very first
 * post-bind connect, which is non-deterministic and goes away on retry.
 * The vanilla `waitForHttp200` would also handle this, but it only takes
 * a URL — no way to inject a Host header.
 */
async function waitForProxy200(
  proxyPort: number,
  hostHeader: string,
  path: string = "/",
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetchViaProxy(proxyPort, hostHeader, path);
      if (res.status >= 200 && res.status < 300) {
        // Drain body so the underlying socket can be released to the
        // pool — otherwise Bun keeps the connection half-open and the
        // next test's fetch gets stuck on a stale keepalive.
        await res.text();
        return;
      }
      // Drain non-2xx responses too.
      await res.text();
    } catch {
      // ignore; will retry until outer deadline
    }
    await new Promise<void>((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timeout waiting for HTTP 200 from proxy ${hostHeader}${path} after ${timeout}ms`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("friendly URL reverse proxy against dogfood-stack", () => {
  it(
    "routes <service>.<worktree>.lich.localhost:<proxyPort> to the correct upstream and 404s on unknown service",
    async () => {
      // Pick the proxy port first so we can both pin it in the copied
      // lich.yaml AND use it in the assertions below. The spec default
      // 3300 is intentionally avoided — see `pickProxyPort` for why.
      const proxyPort = pickProxyPort();
      fixture = makeFixture(proxyPort);
      const { stackPath, lichHome } = fixture;

      // Live progress logger — `lich up` is the heaviest step but postgres
      // pulls fast (~5MB alpine image, LEV-463 swap). Surface what phase
      // the test is in so a hang is obvious. Matches the pattern from
      // basic-up.test.ts, daemon-auto-shutdown.test.ts, and the other
      // dashboard tests.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up --no-browser -----------------------------------------
      // --no-browser keeps CI/headless hosts from trying to spawn Chrome
      // (the daemon would still open it without the flag — LEV-411). The
      // dashboard server AND the proxy server both start regardless; the
      // flag only affects the auto-open side effect.
      step("lich up --no-browser (postgres pull + boot ~5-10s)");
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

      // ---- wait for daemon (the proxy is part of the daemon) ------------
      // After `lich up` exits successfully, the daemon should already be
      // running (the auto-start hook fires before `up` returns — see
      // up.ts's LEV-411 block). 30s is plenty: on the cold path the
      // daemon takes ~500ms to write its URL file, and the proxy binds
      // immediately after.
      step("waiting for daemon (pid + url files)");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 30_000,
      });
      expect(daemon.url).toMatch(/^http:\/\//);
      step(`daemon up at ${daemon.url}`);

      // ---- pull routing inputs out of state.json ------------------------
      // worktree_name is the `<worktree>` slot in friendly hostnames per
      // `buildRoutingEntries` (commands/up.ts:2638). Already sanitized to
      // `[a-z0-9-]+` by `worktree/detect.ts`'s `sanitizeName`.
      const worktreeName = snap.worktree_name;
      expect(worktreeName).toMatch(/^[a-z0-9-]+$/);
      expect(worktreeName.length).toBeGreaterThan(0);
      step(`worktree name: ${worktreeName}`);

      // Find the api + web services' raw allocated ports. The dogfood
      // stack declares `api` and `web` as single-port owned services (see
      // examples/dogfood-stack/lich.yaml), so each has a single
      // `default`-keyed entry in `allocated_ports`. The friendly hostname
      // is `<service>.<worktree>` for single-port services (per
      // buildRoutingEntries' single-port branch).
      const apiService = snap.services.find((s) => s.name === "api");
      const webService = snap.services.find((s) => s.name === "web");
      expect(apiService).toBeDefined();
      expect(webService).toBeDefined();
      expect(apiService!.allocated_ports).toBeDefined();
      expect(webService!.allocated_ports).toBeDefined();

      // Single-port services: snapshot stores one entry keyed `default`.
      // We grab the only value rather than hardcoding the key in case the
      // snapshot convention shifts in a future plan (e.g. compose services
      // pick their own key). The friendly hostname doesn't care about the
      // key for single-port services — it's `<service>.<worktree>` either
      // way.
      const apiPorts = Object.values(apiService!.allocated_ports!);
      const webPorts = Object.values(webService!.allocated_ports!);
      expect(apiPorts.length).toBe(1);
      expect(webPorts.length).toBe(1);
      const apiPort = apiPorts[0];
      const webPort = webPorts[0];
      expect(apiPort).toBeGreaterThan(0);
      expect(webPort).toBeGreaterThan(0);
      step(`raw ports: api=${apiPort} web=${webPort}`);

      // ---- proxy port: pinned per-test (see pickProxyPort) --------------
      // `makeFixture` already appended `runtime.proxy_port: <proxyPort>`
      // to the copied lich.yaml; the daemon reads that and binds the same
      // port. This avoids contention with the spec default 3300, which a
      // sibling agent's worktree or a stray dev daemon may already own.
      step(`proxy port: ${proxyPort}`);

      // ---- positive case 1: api.<wt>.lich.localhost:<proxyPort>/health --
      // Wait for the proxy to answer at least once with a 200 — the very
      // first request can race with the proxy's bind on slow CI. Once
      // we've got a 200, do the body-equality assertion in a fresh call.
      const apiHost = `api.${worktreeName}.lich.localhost:${proxyPort}`;
      step(`probing ${apiHost}/health via proxy`);
      await waitForProxy200(proxyPort, apiHost, "/health", {
        timeoutMs: 15_000,
      });

      // Fetch via proxy AND via raw URL; bodies must match. The api
      // /health endpoint returns deterministic JSON (`{"status":"ok"}`),
      // so a verbatim string compare is the right shape. A mismatch would
      // mean the proxy routed `api.<wt>` to a different upstream than the
      // raw URL — which is exactly the kind of routing bug this test
      // catches.
      const apiViaProxy = await fetchViaProxy(proxyPort, apiHost, "/health");
      expect(apiViaProxy.status).toBe(200);
      const apiProxyBody = await apiViaProxy.text();

      // Probe the raw URL the proxy is supposed to be forwarding to.
      // Same /health endpoint, no Host-header trickery — straight at
      // 127.0.0.1:<api-port>. We use `waitForHttp200` first to absorb any
      // ECONNRESET on the cold path, then fetch the body.
      step(`probing raw http://127.0.0.1:${apiPort}/health`);
      await waitForHttp200(`http://127.0.0.1:${apiPort}/health`, {
        timeoutMs: 10_000,
      });
      const apiViaRaw = await fetch(`http://127.0.0.1:${apiPort}/health`);
      expect(apiViaRaw.status).toBe(200);
      const apiRawBody = await apiViaRaw.text();

      // The /health endpoint returns deterministic JSON, so the proxy
      // body must equal the raw body exactly. This is THE test that
      // proves the proxy forwards correctly — a routing bug or a
      // body-mangling bug (transfer-encoding mishandling, charset issues)
      // would fail this equality.
      expect(apiProxyBody).toBe(apiRawBody);
      step(`api.${worktreeName} body matches raw upstream (${apiRawBody.length} bytes)`);

      // ---- positive case 2: web.<wt>.lich.localhost:<proxyPort>/ --------
      // Same pattern as api, but Next.js dev server. The body comparison
      // is trickier because Next emits a `__NEXT_DATA__` blob that
      // includes timestamps and the requesting hostname — both differ
      // trivially between two requests. We compare:
      //   - status code (200 vs 200)
      //   - body length (within a small tolerance for the dynamic parts)
      //   - HTML doctype prefix (proves we got the same page from the
      //     same Next instance, not a redirect or a different upstream)
      const webHost = `web.${worktreeName}.lich.localhost:${proxyPort}`;
      step(`probing ${webHost}/ via proxy`);
      // Next dev cold-compiles on first request; the cold-compile budget
      // is 20s per basic-up.test.ts, but the api test above already
      // warmed an HTTP request through the proxy, so Next has probably
      // already been hit by `lich up`'s ready_when probe.
      await waitForProxy200(proxyPort, webHost, "/", { timeoutMs: 20_000 });

      const webViaProxy = await fetchViaProxy(proxyPort, webHost, "/");
      expect(webViaProxy.status).toBe(200);
      const webProxyBody = await webViaProxy.text();

      step(`probing raw http://127.0.0.1:${webPort}/`);
      await waitForHttp200(`http://127.0.0.1:${webPort}/`, {
        timeoutMs: 10_000,
      });
      const webViaRaw = await fetch(`http://127.0.0.1:${webPort}/`);
      expect(webViaRaw.status).toBe(200);
      const webRawBody = await webViaRaw.text();

      // Both responses must look like Next.js HTML. Use the same regex
      // basic-up.test.ts uses (line 309) — `<!doctype html>` or `_next`
      // or `next` is enough to prove it's a Next-rendered page.
      expect(webProxyBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);
      expect(webRawBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);

      // Body length should be similar — Next pages aren't perfectly
      // deterministic across two requests (timestamps in __NEXT_DATA__
      // and slot ids in React's renderToString differ), but they're
      // close. A wild mismatch (e.g. one is 200 bytes and the other is
      // 20000) would mean the proxy routed `web.<wt>` to a totally
      // different upstream. We allow up to 50% delta as a smoke check;
      // this is loose enough to absorb Next's internal nondeterminism
      // and tight enough to catch a "routed to the wrong service" bug.
      const lengthDelta = Math.abs(webProxyBody.length - webRawBody.length);
      const lengthRatio = lengthDelta / Math.max(webRawBody.length, 1);
      expect(
        lengthRatio,
        `web body length differed too much: proxy=${webProxyBody.length}, raw=${webRawBody.length}`,
      ).toBeLessThan(0.5);

      // The first ~100 bytes (HTML doctype + open html tag + start of
      // head) are typically stable across two Next dev requests because
      // they're emitted before any of the dynamic content. If the prefix
      // diverges wildly, we routed to a different page.
      const prefixLen = Math.min(100, webProxyBody.length, webRawBody.length);
      expect(webProxyBody.slice(0, prefixLen)).toBe(
        webRawBody.slice(0, prefixLen),
      );
      step(
        `web.${worktreeName} body matches raw upstream (proxy=${webProxyBody.length} bytes, raw=${webRawBody.length} bytes)`,
      );

      // ---- negative case: nonexistent service -> 404 from proxy ---------
      // The proxy owns this 404 (NOT an upstream). The routing table has
      // no entry for `nonexistent.<wt>` because the dogfood-stack defines
      // no such service; per proxy.ts's `notFoundBody`, the proxy returns
      // 404 with a plain-text body explaining the friendly URL pattern.
      // The body should mention `lich.localhost` so a typoing user gets
      // a debugging hint.
      const nonexistentHost = `nonexistent.${worktreeName}.lich.localhost:${proxyPort}`;
      step(`probing ${nonexistentHost}/ via proxy (expect 404)`);
      const missRes = await fetchViaProxy(proxyPort, nonexistentHost, "/");
      expect(missRes.status).toBe(404);
      const missBody = await missRes.text();
      // The proxy's 404 body advertises the friendly URL pattern — proves
      // this 404 came from the proxy and not from some upstream (an
      // upstream's 404 would have a different shape; Next's 404 page is
      // HTML, Express's is "Cannot GET /", etc.).
      expect(missBody.toLowerCase()).toContain("lich.localhost");
      step("nonexistent service correctly 404s from proxy");

      step("all friendly-URL assertions passed");
    },
    // Per-test override: 5 minutes — same shape as basic-up,
    // dashboard-stack-detail, and the other dogfood-stack-based tests.
    // Postgres pulls fast (~5MB alpine, LEV-463 swap) so even cold first-
    // run is sub-minute, but the headroom is kept for slow CI boxes. The
    // proxy probes themselves are sub-millisecond once the stack is up.
    300_000,
  );
});
