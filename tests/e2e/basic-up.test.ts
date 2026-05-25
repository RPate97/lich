/**
 * `lich up` against the dogfood-stack — Plan 1 basic flow (LEV-297).
 *
 * This was Plan 0's failing test. Plan 1 turns the validate half green and
 * adds full-up coverage that exercises every Plan-1 subsystem end-to-end
 * (config parse → port allocator → owned-service supervisor → ready
 * evaluators → state.json → urls → down → cleanup).
 *
 * Test breakdown:
 *
 *   1. `lich validate succeeds against the target yaml`
 *      Spawns the real binary in a tmpdir copy of the dogfood-stack,
 *      asserts exit 0 with no stderr. Doesn't actually need docker since
 *      `validate` is pure config parsing, but it runs unconditionally
 *      anyway — see prerequisites note below.
 *
 *   2. `lich up brings the stack up + lich down cleans it up`
 *      Runs unconditionally. Requires docker + supabase CLI v2+ on the
 *      host (see tests/e2e/README.md). On a host missing those, the test
 *      fails loudly with the actual docker / supabase error — that's
 *      desired, lich's whole purpose is orchestrating docker (LEV-314).
 *        - `lich up` against a tmpdir copy of the dogfood-stack
 *        - poll state.json until status:up (up to ~3 minutes for first
 *          supabase image pull)
 *        - `lich urls` lists web, api, supabase entries
 *        - hit each raw `http://localhost:<port>` URL via fetch:
 *            * api  /health → 200 JSON
 *            * web  /       → 200 HTML
 *            * supabase api / → reachable (Kong gateway)
 *        - `lich down` → state.json transitions to status:stopped, the
 *          previously allocated ports stop listening.
 *
 *   3. `serves the web app over its friendly URL` — Plan 5 (LEV-431)
 *      Brings the stack up with `--no-browser`, waits for the daemon's
 *      pid + url files, then hits `http://web.<worktree>.lich.localhost:
 *      3300/` via the proxy (using a loopback + Host-header probe to
 *      sidestep flaky `*.localhost` DNS on some hosts). Probes both
 *      127.0.0.1 AND [::1] because `Bun.serve` with `hostname: "localhost"`
 *      binds whichever family the OS resolver returns first — a browser
 *      would let the OS choose, so the test does the same. Asserts the
 *      proxy is transparent — same status, same body markers, similar
 *      size — as the raw URL.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one).
 *   - LICH_HOME pointed at a per-test tmp directory so the real ~/.lich
 *     stays untouched (no collisions with the user's own runs).
 *   - lich binary built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich down` then `lich nuke --yes` runs in `afterEach` even when the
 *     test body throws. The nuke step kills the Plan-5 daemon (which would
 *     otherwise hold the proxy port and break the next test).
 *   - tmpdir + LICH_HOME removed in `afterEach`.
 *   - Leaving leaks is a test bug; we'd rather see noisy cleanup logs than
 *     mysterious failures on the next run.
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
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
import { waitForHttp200 } from "./helpers/wait.js";
import { parseLichUrls, portFromUrl } from "./helpers/urls.js";
import { readStateJson, waitForStackStatus } from "./helpers/state.js";
import { waitForDaemonRunning } from "./helpers/daemon.js";

// ---------------------------------------------------------------------------
// Build the binary up front. We fail loudly here (don't skip) — the binary
// is OUR code, and a broken build is a real bug. Re-using whatever the
// previous run produced is fine; the build step is a no-op when dist/lich
// already exists, but we DO force it on a missing binary.
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
// Per-test fixture state — every test gets fresh tmpdirs / LICH_HOME so
// nothing leaks between tests and the user's real ~/.lich is never touched.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  // install: true — apps/web runs `next dev`, which needs `next` in
  // node_modules/.bin. Without it the web owned service exits 127 immediately
  // and the up test fails before any state.json is written. See LEV-313.
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-basic-up-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/** Always-best-effort teardown of a fixture. Logs failures, swallows them. */
function teardownFixture(fix: Fixture): void {
  // Best-effort lich down — if the up test failed before lich up succeeded,
  // there may be no stack to bring down, and that's fine.
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
  // Plan 5 (LEV-431) — nuke --yes follows the down so the daemon process
  // dies too. The Plan-5 daemon binds the proxy port (default 3300); if
  // we left it alive between tests, the next `lich up` would refuse to
  // bind a new proxy on the same port, leading to mysterious
  // 404/connection-refused failures in test N+1. The auto-shutdown loop
  // takes ~30s — long enough to corrupt the next test. Matches the
  // pattern in tests/e2e/dashboard-stack-detail.test.ts's teardown.
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
    console.warn(`afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
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
 * Find the (single) stack id present under `<lichHome>/stacks/`. The test
 * doesn't pre-compute the worktree hash; instead we list the directory and
 * pick the only entry. Returns null if no stack dir exists yet.
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

/** True if a TCP connect to localhost:port succeeds within ~1s. */
function tcpListening(port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 1000 });
    socket.on("connect", () => {
      socket.end();
      res(true);
    });
    socket.on("error", () => res(false));
    socket.on("timeout", () => {
      socket.destroy();
      res(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich validate against dogfood-stack", () => {
  it("exits 0 with no stderr for the target yaml", () => {
    fixture = makeFixture();
    const result = runLich(["validate"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
    });
    if (result.exitCode !== 0) {
      // Surface the actual error for fast diagnosis when this regresses.
      // eslint-disable-next-line no-console
      console.error("validate stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("validate stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("lich up against dogfood-stack (Plan 1 basic flow)", () => {
  it(
    "brings the stack up, serves raw URLs, then lich down cleans up",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Progress logger — writes to stderr (live during test) so the user
      // sees what phase we're in rather than staring at silence for minutes.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up ------------------------------------------------------
      // Run synchronously: `lich up` returns once the stack is fully ready
      // (services are detached — owned services run in their own process
      // groups, compose runs `-d`). Generous timeout: first run pulls the
      // supabase images, which can take a couple of minutes on a cold host.
      step("lich up (supabase first-pull ~30-60s)");
      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      // ---- state.json: status:up ---------------------------------------
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");
      const serviceNames = snap.services.map((s) => s.name).sort();
      // The dogfood stack defines these services. tunnel_demo was added by
      // LEV-368 as the Plan 4 capture demo; api/supabase/web are the core
      // owned services; mailhog/redis are the Plan 1 compose services
      // added by the Task-2 dogfood-stack expansion.
      expect(serviceNames).toEqual([
        "api",
        "mailhog",
        "redis",
        "supabase",
        "tunnel_demo",
        "web",
      ]);

      // ---- lich urls: expected services present, ports reachable -------
      const urlsResult = runLich(["urls"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      // Every declared service should appear in the urls output.
      expect(Object.keys(urls).sort()).toEqual(
        expect.arrayContaining(["api", "supabase", "web"]),
      );

      // api: single-port → "default"; verify /health responds.
      const apiUrl = urls.api?.default;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      // Express api: responds immediately after spawn. 10s is huge headroom.
      step(`probing api /health (${apiUrl})`);
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      const health = await fetch(`${apiUrl}/health`).then((r) => r.json());
      expect(health).toMatchObject({ status: "ok" });

      // web: single-port → "default"; verify root returns 200 HTML.
      const webUrl = urls.web?.default;
      expect(webUrl, `expected web url in: ${urlsResult.stdout}`).toBeTruthy();
      // Next.js dev cold compile on first request usually ~3-8s.
      step(`probing web / (${webUrl})`);
      await waitForHttp200(webUrl!, { timeoutMs: 20_000 });
      step("all probes 200 OK");
      const webResp = await fetch(webUrl!);
      expect(webResp.status).toBe(200);
      const webBody = await webResp.text();
      // Next.js dev pages always emit `<!DOCTYPE html>` and reference `_next`
      // in their script tags — either one is enough to prove we got HTML
      // from Next, not from some other process that grabbed the port.
      expect(webBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);

      // supabase: multi-port; the `api` entry is Kong, which proxies the
      // public API surface and answers on /. We just verify TCP listening
      // — Kong returns 404 on / without a Host header, so an HTTP-200 probe
      // is the wrong shape here.
      const supabaseApiUrl = urls.supabase?.api;
      expect(
        supabaseApiUrl,
        `expected supabase.api url in: ${urlsResult.stdout}`,
      ).toBeTruthy();
      const supabasePort = portFromUrl(supabaseApiUrl!);
      expect(supabasePort).toBeGreaterThan(0);
      expect(await tcpListening(supabasePort)).toBe(true);

      // Capture the allocated ports so the post-down check can verify they
      // stopped listening.
      const allocatedPorts: number[] = [];
      for (const svc of snap.services) {
        if (!svc.allocated_ports) continue;
        for (const p of Object.values(svc.allocated_ports)) {
          allocatedPorts.push(p);
        }
      }
      expect(allocatedPorts.length).toBeGreaterThanOrEqual(3);

      // ---- lich down: clean teardown -----------------------------------
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(downResult.exitCode).toBe(0);

      // state.json transitions to status:stopped (lich down keeps the
      // entry around for `lich stacks` visibility until `lich nuke`).
      const downSnap = readStateJson(lichHome, stackId!);
      expect(downSnap?.status).toBe("stopped");

      // Previously-allocated ports stop listening. Give services a brief
      // beat to release sockets after teardown returns.
      await new Promise<void>((r) => setTimeout(r, 2_000));
      for (const port of allocatedPorts) {
        const stillUp = await tcpListening(port);
        expect(stillUp, `port ${port} still listening after lich down`).toBe(
          false,
        );
      }
    },
    // Per-test override: 5 minutes — pulls + boots + teardown of a full
    // Supabase + Next + Express stack adds up.
    300_000,
  );

  // Friendly URL — Plan 5 (LEV-431). The pattern `http://<service>.<worktree>
  // .lich.localhost:<proxy_port>/` lives in the spec under section 5. Plan 5
  // wires up the daemon's reverse proxy on `runtime.proxy_port` (default
  // 3300) and the routing entries `lich up` writes into state.json; this
  // test verifies the whole pipeline end-to-end against the dogfood-stack.
  //
  // Why hit 127.0.0.1 with a `Host` header instead of the friendly URL
  // directly? `*.lich.localhost` IS a special-use TLD that modern browsers
  // and OSes auto-resolve to loopback (RFC 6761 + 8375). But not every Mac
  // / CI runner has `mDNSResponder` configured to return `127.0.0.1` for
  // arbitrary `*.localhost` names — some return ENOTFOUND. The proxy itself
  // routes purely on the `Host` header, so we use `127.0.0.1:<proxy_port>`
  // + an explicit `Host` to exercise the same code path without depending
  // on the host's DNS behavior. The plan's Task 23 implementation notes
  // call this out explicitly as the recommended fallback for `*.localhost`
  // resolution.
  //
  // `--no-browser` mirrors daemon-auto-start.test.ts — we want the daemon
  // to spawn (it must, for the proxy to bind) but we don't want a Chrome
  // tab popping up during a test run.
  it(
    "serves the web app over http://web.<worktree>.lich.localhost:3300/ (Plan 5 friendly URL)",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger — same pattern as the raw-URL test above; this
      // one is also slow (full dogfood-stack boot + supabase pull on cold
      // caches) and silence for minutes is no help when something hangs.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up --no-browser ----------------------------------------
      step("lich up --no-browser (supabase first-pull ~30-90s)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 300_000,
      });
      if (upResult.exitCode !== 0) {
        // Surface stdout+stderr so a failed up gives a real diagnostic
        // (docker not running, supabase CLI missing, etc.) rather than a
        // mystery "timeout waiting for daemon" downstream.
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      // ---- state.json: stack reached `up` ------------------------------
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");
      const worktreeName = snap.worktree_name;
      expect(
        worktreeName,
        "snapshot must record worktree_name for friendly-URL hostnames",
      ).toBeTruthy();

      // ---- daemon: pid + url files present, dashboard up ---------------
      // The daemon-auto-start path in `lich up` is best-effort (failures
      // don't fail the up — see commands/up.ts Plan 5 Task 9 block), so we
      // assert it explicitly here. Without the daemon, the proxy isn't
      // bound and the friendly URL has nothing to hit.
      step("waiting for daemon pid + url files");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 30_000,
      });
      step(`daemon alive: pid=${daemon.pid} url=${daemon.url}`);

      // ---- raw URL: capture the expected body --------------------------
      // We need the raw URL's response body so the friendly URL assertion
      // can prove the proxy is transparent (same body, same content), not
      // just "returns 200." The raw URL probe also doubles as a sanity
      // check that the web service itself is up — if THIS fails, the
      // friendly URL test fails for the wrong reason.
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const rawUrls = parseLichUrls(urlsResult.stdout);
      const rawWebUrl = rawUrls.web?.default;
      expect(
        rawWebUrl,
        `expected raw web url in: ${urlsResult.stdout}`,
      ).toBeTruthy();

      // Next.js dev cold-compile on first request usually ~3-8s; 20s
      // headroom mirrors the raw-URL test's budget.
      step(`probing raw web / (${rawWebUrl})`);
      await waitForHttp200(rawWebUrl!, { timeoutMs: 20_000 });
      const rawBody = await fetch(rawWebUrl!).then((r) => r.text());
      expect(rawBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);

      // ---- friendly URL: same body via proxy ---------------------------
      // The proxy port comes from `config.runtime.proxy_port` with a 3300
      // default. The dogfood-stack's lich.yaml doesn't set it, so 3300 is
      // what the daemon bound. If a future variant overrides it, this
      // assertion would need to read the config — but that's
      // out-of-scope for the LEV-431 gate (which is specifically about
      // proving the 3300 default path works end-to-end).
      const proxyPort = 3300;
      const friendlyHost = `web.${worktreeName}.lich.localhost`;
      const friendlyUrl = `http://${friendlyHost}:${proxyPort}/`;

      // Hit the proxy via loopback with an explicit Host header — see the
      // doc comment above this `it` block for the DNS rationale. We probe
      // both IPv4 (127.0.0.1) AND IPv6 (::1) because `Bun.serve` with
      // `hostname: "localhost"` binds only one family per process, and
      // which family wins depends on macOS's resolver order at the moment
      // the proxy started. A browser hitting `web.<wt>.lich.localhost`
      // would let the OS pick whichever family resolves, so the test
      // tracks that behavior: try both loopback addresses, accept the
      // first one that the proxy actually answers on.
      step(`probing friendly URL: ${friendlyUrl}`);
      const probeUrls = [
        `http://127.0.0.1:${proxyPort}/`,
        `http://[::1]:${proxyPort}/`,
      ];

      // Wait for the proxy to be up + the routing table to have picked up
      // the dogfood-stack's `web` entry. The routing watcher is debounced
      // ~100ms, so the table should be live within a few seconds of
      // state.json reaching status:up — but cold-start of the daemon and
      // of the routing watcher's initial fs scan can need a beat longer.
      const deadline = Date.now() + 15_000;
      let lastErr: unknown = null;
      let friendlyRes: Response | null = null;
      let chosenProbe: string | null = null;
      outer: while (Date.now() < deadline) {
        for (const probeUrl of probeUrls) {
          try {
            const res = await fetch(probeUrl, {
              headers: {
                Host: `${friendlyHost}:${proxyPort}`,
                // LEV-458 fixed the proxy's content-encoding double-
                // decompress bug; the `Accept-Encoding: identity`
                // workaround that used to live here is no longer needed.
              },
            });
            if (res.status === 200) {
              friendlyRes = res;
              chosenProbe = probeUrl;
              break outer;
            }
            lastErr = new Error(
              `${probeUrl} (Host=${friendlyHost}) returned ${res.status} — body: ${(await res.text()).slice(0, 200)}`,
            );
          } catch (err) {
            lastErr = new Error(
              `${probeUrl} (Host=${friendlyHost}) fetch threw: ${(err as Error).message}`,
            );
          }
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
      if (!friendlyRes) {
        throw new Error(
          `friendly URL ${friendlyUrl} never returned 200 within 15s. ` +
            `Tried loopback addresses: ${probeUrls.join(", ")}. ` +
            `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        );
      }
      expect(friendlyRes.status).toBe(200);
      step(`friendly URL 200 OK via ${chosenProbe}`);

      // Body match: the proxy is transparent, so the friendly URL must
      // serve the same bytes the raw URL serves. Compare bodies after the
      // status check — this is the "proxy actually proxies" assertion.
      // Note: Next.js dev sometimes injects per-request nonces in CSP
      // headers / Refresh-control comments, but the document body itself
      // should be stable across two back-to-back requests. We assert a
      // substring match (the `<!doctype` / `_next` markers from the raw
      // body must appear in the friendly body) rather than full equality
      // to avoid flaking on transient framework cosmetics.
      const friendlyBody = await friendlyRes.text();
      expect(friendlyBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);

      // The proxy IS transparent, so the response sizes should be very
      // close. We allow generous slack because Next.js may emit different
      // absolute timestamps / cache-bust query strings between two
      // requests, but the rough shape must match (within a few KB).
      const sizeDelta = Math.abs(friendlyBody.length - rawBody.length);
      expect(
        sizeDelta,
        `friendly body (${friendlyBody.length}B) and raw body (${rawBody.length}B) differ by ${sizeDelta}B — proxy may not be transparent`,
      ).toBeLessThan(2_000);

      // ---- lich down (in-body cleanup) ---------------------------------
      // Tear down inside the test body rather than leaving the heavy
      // teardown to `afterEach`. Vitest caps the hookTimeout at 60s
      // (vitest.config.ts), but a full supabase teardown can easily take
      // 30-60s on its own — leaving zero margin for the surrounding
      // `lich down` orchestration to finish. Calling it here keeps the
      // afterEach fallback fast (it sees status:stopped already and
      // no-ops) and avoids the "afterEach hook timed out" failure mode.
      step("lich down (in-body teardown)");
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:", downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:", downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);
      step("lich down exit 0");
    },
    // Per-test timeout: same 5-minute budget as the raw-URL sibling above
    // (supabase pull + boot + teardown dominates).
    300_000,
  );
});
