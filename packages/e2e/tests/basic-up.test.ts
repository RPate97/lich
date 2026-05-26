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
 *      Runs unconditionally. Requires docker on the host (see
 *      tests/e2e/README.md). On a host missing it, the test fails loudly
 *      with the actual docker error — that's desired, lich's whole
 *      purpose is orchestrating docker (LEV-314).
 *        - `lich up` against a tmpdir copy of the dogfood-stack
 *        - poll state.json until status:up (postgres image is small,
 *          startup is sub-10s)
 *        - `lich urls` lists web, api, postgres entries
 *        - hit each raw `http://127.0.0.1:<port>` URL via fetch:
 *            * api  /health → 200 JSON
 *            * web  /       → 200 HTML
 *            * postgres TCP listening
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

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { parseLichUrls } from "../helpers/urls.js";
import { readStateJson, waitForStackStatus } from "../helpers/state.js";
import { waitForDaemonRunning } from "../helpers/daemon.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// ---------------------------------------------------------------------------
// Build the binary up front. We fail loudly here (don't skip) — the binary
// is OUR code, and a broken build is a real bug. Re-using whatever the
// previous run produced is fine; the build step is a no-op when dist/lich
// already exists, but we DO force it on a missing binary.
// ---------------------------------------------------------------------------


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
  //
  // LEV-465: timeout tightened from 120s → 20s. afterEach is a fast cleanup
  // path; vitest's hookTimeout caps total hook runtime at 60s anyway, so
  // the previous 120s value could never actually fire — it just masked
  // teardown hangs as "afterEach timed out" instead of a specific stuck
  // step. 20s is generous enough for a healthy `lich down` (sub-second
  // typically) yet tight enough to surface real teardown bugs loudly.
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
  // Plan 5 (LEV-431) — nuke --yes follows the down so the daemon process
  // dies too. The Plan-5 daemon binds the proxy port (default 3300); if
  // we left it alive between tests, the next `lich up` would refuse to
  // bind a new proxy on the same port, leading to mysterious
  // 404/connection-refused failures in test N+1. The auto-shutdown loop
  // takes ~30s — long enough to corrupt the next test. Matches the
  // pattern in tests/e2e/dashboard-stack-detail.test.ts's teardown.
  //
  // LEV-465: timeout tightened from 60s → 20s. `lich nuke --yes` was
  // diagnosed at sub-200ms even when killing a live daemon (SIGTERM →
  // 5s grace → SIGKILL), so 20s is huge headroom while still failing
  // loudly on a real shutdown hang.
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

/**
 * Probe the lich proxy via a raw HTTP/1.1 socket — REQUIRED instead of
 * `fetch()` because Node's undici fetch SILENTLY STRIPS the `Host`
 * header (it's on the WHATWG "forbidden headers" list, so the proxy
 * sees `Host: 127.0.0.1:3300` instead of the friendly URL).
 *
 * Returns a `Response`-shaped object whose status reflects the proxy's
 * reply. We only care about status here; bodies are decoded as
 * Transfer-Encoding: chunked or content-length-framed depending on the
 * proxy's response shape. Mirrors the pattern in
 * tests/e2e/friendly-urls.test.ts.
 *
 * @param ip — `127.0.0.1` or `::1`. The proxy binds both loopback
 *   families explicitly (LEV-459); either should work.
 * @param port — the proxy port (3300 by default in dogfood-stack).
 * @param hostHeader — the full `Host: ...` value to send (include the
 *   port suffix the test cares about, e.g. `web.<wt>.lich.localhost:3300`).
 * @param path — the URL path to GET. Defaults to `/`.
 */
async function fetchViaProxy(
  ip: string,
  port: number,
  hostHeader: string,
  path: string = "/",
): Promise<Response> {
  const { Socket } = await import("node:net");
  return new Promise<Response>((resolve, reject) => {
    const socket = new Socket();
    let buf = Buffer.alloc(0);
    socket.setTimeout(10_000);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
    });
    socket.on("end", () => {
      try {
        resolve(parseHttpResponse(buf));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      if (buf.length > 0) {
        try {
          resolve(parseHttpResponse(buf));
          return;
        } catch {
          /* fall through */
        }
      }
      reject(new Error(`proxy probe timeout: ${hostHeader}${path}`));
    });
    socket.on("error", (err) => reject(err));
    socket.connect(port, ip, () => {
      // Plain HTTP/1.1 GET request with explicit Host header.
      // Connection: close keeps the response self-contained — the
      // server flushes the body then FINs; we resolve on `end`.
      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        `Connection: close\r\n` +
        `\r\n`;
      socket.write(req);
    });
  });
}

/**
 * Minimal HTTP/1.1 response parser. Decodes chunked transfer-encoding
 * so the test's body-match assertion compares decoded payload, not
 * `<hex>\r\n<bytes>\r\n0\r\n` framing.
 */
function parseHttpResponse(raw: Buffer): Response {
  const sep = raw.indexOf("\r\n\r\n");
  const headerEnd = sep >= 0 ? sep : raw.length;
  const headerBlock = raw.subarray(0, headerEnd).toString("utf8");
  const rawBody = sep >= 0 ? raw.subarray(sep + 4) : Buffer.alloc(0);
  const [statusLine, ...headerLines] = headerBlock.split("\r\n");
  const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
  if (!m) {
    throw new Error(
      `unparseable HTTP response line: ${JSON.stringify(statusLine)}`,
    );
  }
  const status = parseInt(m[1], 10);
  const headers = new Headers();
  let chunked = false;
  for (const line of headerLines) {
    const ci = line.indexOf(":");
    if (ci > 0) {
      const name = line.slice(0, ci).trim();
      const value = line.slice(ci + 1).trim();
      headers.append(name, value);
      if (
        name.toLowerCase() === "transfer-encoding" &&
        /\bchunked\b/i.test(value)
      ) {
        chunked = true;
      }
    }
  }
  const body = chunked ? decodeChunkedBody(rawBody) : rawBody;
  return new Response(body, { status, headers });
}

/** Decode an HTTP/1.1 chunked-transfer-encoding body. */
function decodeChunkedBody(raw: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const crlf = raw.indexOf("\r\n", pos);
    if (crlf < 0) break;
    const sizeHex = raw.subarray(pos, crlf).toString("utf8");
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) break;
    pos = crlf + 2;
    if (size === 0) break;
    out.push(raw.subarray(pos, pos + size));
    pos += size + 2; // skip chunk + trailing \r\n
  }
  return Buffer.concat(out);
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
      // Run synchronously: `lich up` returns once the stack is fully ready.
      // Default profile is dev:fast (no postgres, no compose) — just api +
      // web on the host. Typically ~2-3s.
      step("lich up --no-browser (dev:fast — api + web on host)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
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
      // dev:fast profile: just api + web. The dev profile additionally
      // includes postgres (compose) and tunnel_demo (owned) — exercised
      // separately by the compose-pool tests.
      expect(serviceNames).toEqual(["api", "web"]);

      // ---- lich urls --raw: localhost URLs that don't depend on proxy -
      // We use --raw so this test only exercises the up/down + service-up
      // contract, not the Plan 5 friendly-URL proxy (which is covered by
      // the second test in this file via the daemon path).
      //
      // Before LEV-419 (friendly URLs by default), `lich urls` already
      // returned localhost URLs and this test worked unconditionally.
      // With friendly URLs as the default, hitting them without first
      // waiting for the daemon's routing table to settle races —
      // surfaced by dev:fast being fast (the stack now comes up in ~3s,
      // not enough time for the routing watcher's debounce). Using --raw
      // sidesteps that race.
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      // Every declared service should appear in the urls output.
      expect(Object.keys(urls).sort()).toEqual(
        expect.arrayContaining(["api", "web"]),
      );

      // api: single-port → flat string url (post-LEV-419 + LEV-464
      // parseLichUrls flat-shape); verify /health responds.
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      // Express api: responds immediately after spawn. 10s is huge headroom.
      step(`probing api /health (${apiUrl})`);
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      // dev:fast profile: /health.db should be "stub" (no DATABASE_URL).
      // Catches accidental drift if the default flip ever silently flips
      // back to dev — see helpers/dbmode.ts.
      await expectDbMode(apiUrl!, "stub");
      const health = await fetch(`${apiUrl}/health`).then((r) => r.json());
      expect(health).toMatchObject({ status: "ok", db: "stub" });

      // web: single-port → flat string url; verify root returns 200 HTML.
      const webUrl = urls.web;
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

      // Capture the allocated ports so the post-down check can verify they
      // stopped listening. dev:fast has api + web → 2 owned ports.
      const allocatedPorts: number[] = [];
      for (const svc of snap.services) {
        if (!svc.allocated_ports) continue;
        for (const p of Object.values(svc.allocated_ports)) {
          allocatedPorts.push(p);
        }
      }
      expect(allocatedPorts.length).toBeGreaterThanOrEqual(2);

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
  // LEV-480: `lich up` now blocks on the daemon's routing table reflecting
  // this stack's friendly hostnames before returning. The wait is fast
  // (POST /api/routing/reload + GET /api/routing polls) — under dev:fast
  // it adds ~50ms to the up. The race that used to skip this test (the
  // routing watcher's 100ms debounce missing the final state.json write)
  // is closed, so this test re-enables.
  it(
    "serves the web app over http://web.<worktree>.lich.localhost:3300/ (Plan 5 friendly URL)",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Live progress logger — same pattern as the raw-URL test above; this
      // one also boots the full dogfood-stack, but with postgres replacing
      // supabase the cold path is sub-minute.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up --no-browser ----------------------------------------
      step("lich up --no-browser (dev:fast — api + web boot ~2-3s)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // Surface stdout+stderr so a failed up gives a real diagnostic
        // (docker not running, image pull failure, etc.) rather than a
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
      // Post-LEV-419 + LEV-463 parseLichUrls flat-shape: single-port owned
      // services land under the bare service key, not `.default`.
      const rawWebUrl = rawUrls.web;
      expect(
        rawWebUrl,
        `expected raw web url in: ${urlsResult.stdout}`,
      ).toBeTruthy();

      // Verify api /health.db is "stub" under dev:fast before we proceed —
      // catches silent default-flip drift end-to-end before we waste cycles
      // on the proxy assertions.
      const rawApiUrl = rawUrls.api;
      expect(rawApiUrl, `expected raw api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${rawApiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(rawApiUrl!, "stub");

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

      // Wait for the proxy to be up + the routing table to have picked up
      // the dogfood-stack's `web` entry. LEV-480: `lich up` now blocks on
      // /api/routing reflecting this stack's hostnames before returning,
      // so this poll should succeed on the first iteration in the happy
      // path. The retry loop survives transient connection-refused races
      // between bind and probe.
      //
      // We use a raw HTTP/1.1 socket (not fetch()) because Node's
      // undici fetch SILENTLY STRIPS the `Host` header when it's overridden
      // (it's on the WHATWG "forbidden headers" list). vitest runs under
      // Node, so a fetch-based probe would 404 even when the proxy is
      // correctly serving the route. Same pattern that
      // tests/e2e/friendly-urls.test.ts uses for the same reason.
      const deadline = Date.now() + 15_000;
      let lastErr: unknown = null;
      let friendlyRes: Response | null = null;
      let chosenProbe: string | null = null;
      // Try both IPv4 and IPv6 loopback — `Bun.serve` may bind only one
      // family depending on macOS resolver order. The proxy now binds
      // BOTH explicitly (LEV-459), so either should work.
      const probeHosts: Array<{ ip: string; label: string }> = [
        { ip: "127.0.0.1", label: "http://127.0.0.1" },
        { ip: "::1", label: "http://[::1]" },
      ];
      outer: while (Date.now() < deadline) {
        for (const probe of probeHosts) {
          try {
            const res = await fetchViaProxy(
              probe.ip,
              proxyPort,
              `${friendlyHost}:${proxyPort}`,
              "/",
            );
            if (res.status === 200) {
              friendlyRes = res;
              chosenProbe = `${probe.label}:${proxyPort}/`;
              break outer;
            }
            lastErr = new Error(
              `${probe.label}:${proxyPort}/ (Host=${friendlyHost}) returned ${res.status} — body: ${(await res.text()).slice(0, 1000)}`,
            );
          } catch (err) {
            lastErr = new Error(
              `${probe.label}:${proxyPort}/ (Host=${friendlyHost}) probe threw: ${(err as Error).message}`,
            );
          }
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
      if (!friendlyRes) {
        throw new Error(
          `friendly URL ${friendlyUrl} never returned 200 within 15s. ` +
            `Tried IPv4 and IPv6 loopback. ` +
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
      // (vitest.config.ts); postgres teardown is fast (~1s) but the
      // owned-service stop sequence still runs through SIGTERM → grace →
      // SIGKILL per service. Calling it here keeps the afterEach fallback
      // fast (it sees status:stopped already and no-ops) and avoids the
      // "afterEach hook timed out" failure mode.
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
    // Per-test timeout: 5-minute budget mirrors the raw-URL sibling above.
    // With postgres replacing supabase the cold path is sub-minute, but the
    // larger budget covers slow CI boxes and warm-image edge cases.
    300_000,
  );
});
