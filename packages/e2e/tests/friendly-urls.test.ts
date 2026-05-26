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
 * environments, we connect directly to `http://127.0.0.1:<proxy-port>`
 * and set the `Host` header explicitly — the proxy routes purely by
 * `Host` header anyway, so the routing path is exactly what a browser
 * hitting `http://api.<wt>.lich.localhost:<proxyPort>/` would exercise.
 *
 * ## Why a raw HTTP/1.1 client (`fetchViaProxy`) instead of `fetch()`
 *
 * Bun 1.2 silently DROPS explicit `Host` header overrides on outbound
 * `fetch()` requests, replacing them with the URL-derived host
 * (`127.0.0.1:<proxyPort>`). The proxy then can't parse the friendly
 * subdomain out of the Host header and 404s every request — even though
 * the routing table has the route. Validated by a raw-socket probe with
 * the explicit Host returning 200 while the equivalent `fetch()` call
 * returns 404 against the same proxy + table state.
 *
 * `fetchViaProxy` opens a TCP socket, writes a one-shot HTTP/1.1 GET
 * with `Connection: close` and the explicit Host header, drains to FIN,
 * and parses the response (including chunked-encoding decoding for
 * Next.js dev's streaming responses). This gives us byte-level control
 * the standard fetch API can't.
 *
 * The unit tests in `packages/lich/tests/unit/daemon/proxy/proxy.test.ts`
 * use `fetch()` and pass — likely because that test rig runs in-process
 * with a different code path, or the Bun version it was authored against
 * honored the override. We use the raw socket here for robustness.
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
 * Sub-minute typical (post LEV-470: dev:fast is the default, ~2-3s boot;
 * Next dev cold compile is the dominant cost). The friendly-URL probes
 * themselves are sub-millisecond once the stack is up. The 90s per-test
 * timeout is headroom for slow CI boxes and Next's cold compile.
 *
 * ## Pool classification (e2e-suite-solid-and-fast design): FAST.
 *
 * The whole point of this file is friendly-URL routing. Both the
 * positive cases (api+web at `<service>.<worktree>.lich.localhost:<port>`)
 * and the negative case (nonexistent service 404s from the proxy) work
 * identically under dev:fast and dev — the routing table is built by the
 * same `up.ts` block in either profile, and the dev:fast service set
 * (api + web) is exactly what this test exercises. The `expectDbMode("stub")`
 * call on the api host catches silent drift if the default ever flips
 * back to "dev".
 *
 * The `waitForProxy200` polling with a 15s/20s deadline absorbs the brief
 * window where the daemon's routing watcher is still settling after the
 * fast (~2-3s) up — same pattern that powers
 * dashboard-parallel-stacks.test.ts (LEV-466). basic-up.test.ts's second
 * test (friendly URL via proxy) hit a tighter version of this race
 * because it had no polling layer between the up returning and the
 * single friendly-URL fetch — basic-up's it.skip handed the coverage
 * off to THIS file, which already polls and so doesn't race.
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
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForStackStatus } from "../helpers/state.js";
import { waitForDaemonRunning } from "../helpers/daemon.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Same pattern as basic-up.test.ts — fail loudly
// if the build is missing; the binary IS our code, a broken build is a real
// bug rather than something to skip.
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
  // lich.yaml DOES have a `runtime:` block (the post-LEV-470 stack ships
  // with proxy_port: 3300 hardcoded), so we must update it in place — a
  // naive append would create a duplicate top-level `runtime:` key and
  // yaml would reject the file with "Map keys must be unique". We do a
  // line-anchored regex substitution on the `proxy_port: NNNN` line; if
  // the dogfood-stack ever drops that line, this test needs revisiting
  // (the regex would no-op, the daemon would still bind 3300, and we'd
  // surface a contention-driven 404 — same diagnosis path as before).
  const yamlPath = join(stack.path, "lich.yaml");
  const yamlSrc = readFileSync(yamlPath, "utf8");
  const updated = yamlSrc.replace(
    /^(\s*)proxy_port:\s*\d+/m,
    `$1proxy_port: ${proxyPort}`,
  );
  if (updated === yamlSrc) {
    throw new Error(
      `friendly-urls makeFixture: failed to update proxy_port in ${yamlPath}; ` +
        `expected a 'proxy_port: NNNN' line under runtime:`,
    );
  }
  writeFileSync(yamlPath, updated, "utf8");

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
 *
 * Why raw HTTP-over-TCP instead of `fetch()`: Bun 1.2 silently drops the
 * explicit `Host` header on outbound fetch requests, replacing it with the
 * URL-derived host (`127.0.0.1:<proxyPort>`). The proxy then can't parse
 * the friendly subdomain and 404s. A small HTTP/1.1 client over a raw
 * socket gives us byte-level control over the request line + Host header,
 * which is what the unit tests rely on (`packages/lich/tests/unit/daemon/
 * proxy/proxy.test.ts`'s `fetchVia` happens to work because Bun's fetch
 * behavior may vary by version + transport details). The shape here is
 * single-request, single-response — no need for keep-alive or
 * content-length parsing magic; the server sends `Connection: close` (or
 * we send it) and we drain to EOF.
 */
async function fetchViaProxy(
  proxyPort: number,
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
    socket.connect(proxyPort, "127.0.0.1", () => {
      // Plain HTTP/1.1 GET request with explicit Host header. Connection:
      // close keeps the response self-contained — server flushes body then
      // FIN, we resolve on end. No need to parse content-length / chunked
      // encoding to know when we're done.
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
 * Minimal HTTP/1.1 response parser. Splits on the blank line between
 * headers and body, decodes `Transfer-Encoding: chunked` bodies, and
 * returns a `Response` whose `.text()` returns the decoded payload.
 *
 * We only care about the status code and body bytes. Chunked decoding
 * is necessary because Next.js dev streams responses with
 * `Transfer-Encoding: chunked` and our raw socket reader gets the chunk
 * size prefix (e.g. `330\r\n...\r\n0\r\n\r\n`) along with the body — a
 * direct compare against the upstream's already-decoded body would
 * mismatch on the chunk frame. Content-Length-framed responses (e.g.
 * the api's small JSON /health) just pass through.
 */
function parseHttpResponse(raw: Buffer): Response {
  const sep = raw.indexOf("\r\n\r\n");
  const headerEnd = sep >= 0 ? sep : raw.length;
  const headerBlock = raw.subarray(0, headerEnd).toString("utf8");
  const rawBody = sep >= 0 ? raw.subarray(sep + 4) : Buffer.alloc(0);
  const [statusLine, ...headerLines] = headerBlock.split("\r\n");
  const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
  if (!m) {
    throw new Error(`unparseable HTTP response line: ${JSON.stringify(statusLine)}`);
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
      if (name.toLowerCase() === "transfer-encoding" && /\bchunked\b/i.test(value)) {
        chunked = true;
      }
    }
  }
  const body = chunked ? decodeChunked(rawBody) : rawBody;
  return new Response(body, { status, headers });
}

/**
 * Decode an HTTP/1.1 `Transfer-Encoding: chunked` body. Each chunk is
 * `<hex-size>\r\n<bytes>\r\n`; the body ends with a zero-size chunk
 * (`0\r\n\r\n`, possibly with trailer headers we ignore). Returns the
 * concatenated decoded payload.
 */
function decodeChunked(raw: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const crlf = raw.indexOf("\r\n", pos);
    if (crlf < 0) break;
    const sizeStr = raw.subarray(pos, crlf).toString("utf8").split(";")[0].trim();
    const size = parseInt(sizeStr, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`bad chunk size: ${JSON.stringify(sizeStr)}`);
    }
    pos = crlf + 2;
    if (size === 0) break; // last chunk
    if (pos + size > raw.length) break; // truncated
    out.push(raw.subarray(pos, pos + size));
    pos += size;
    if (raw[pos] === 0x0d && raw[pos + 1] === 0x0a) pos += 2;
  }
  return Buffer.concat(out);
}

/**
 * Poll the proxy for an HTTP 200 against a friendly Host. Wraps the
 * polling pattern from `waitForHttp200` (helpers/wait.ts) but injects the
 * `Host` header through `fetchViaProxy`'s raw-socket client. We need
 * polling specifically for the very first request through the proxy
 * because the daemon's routing-table watcher (100ms debounce, LEV-405)
 * has to fire after `lich up` writes state.json, and on macOS the
 * fs.watch → daemon reload → routing table swap chain can take up to
 * ~20s to settle. Each polled request is cheap (one TCP roundtrip);
 * we loop until 200 or deadline.
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
      //
      // Default profile is now `dev:fast` (LEV-470) — just api + web on
      // the host, no postgres. Boot is ~3-5s warm. Under fork-pool
      // contention (maxForks: 4) Next's cold compile can stretch to
      // ~30s; 120s timeout absorbs that.
      step("lich up --no-browser (dev:fast — api + web boot ~3-5s warm)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
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
      // Wait for the proxy to answer at least once with a 200. The
      // routing table is rebuilt by the daemon's state-directory watcher
      // (100ms debounce post LEV-405) when `lich up` writes state.json,
      // but the observed delay between `lich up` returning and the route
      // being usable can stretch to ~20s on macOS — likely fs.watch
      // event coalescing + the daemon's reload pass + the routing
      // table's atomic swap not landing in the proxy's view immediately.
      // 60s is generous headroom; iterations are cheap (~5ms each) so
      // there's no cost to padding the deadline.
      const apiHost = `api.${worktreeName}.lich.localhost:${proxyPort}`;
      step(`probing ${apiHost}/health via proxy`);
      await waitForProxy200(proxyPort, apiHost, "/health", {
        timeoutMs: 60_000,
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
      // dev:fast: api reports db: "stub". Verify before doing the body
      // equality check so a silent profile drift (default flips back to
      // "dev" somehow) fails with a clear "did this test forget to pass
      // 'dev'?" hint instead of an opaque body mismatch.
      await expectDbMode(`http://127.0.0.1:${apiPort}`, "stub");
      const apiViaRaw = await fetch(`http://127.0.0.1:${apiPort}/health`);
      expect(apiViaRaw.status).toBe(200);
      const apiRawBody = await apiViaRaw.text();

      // The /health endpoint returns deterministic JSON, so the proxy
      // body must equal the raw body exactly. This is THE test that
      // proves the proxy forwards correctly — a routing bug or a
      // body-mangling bug (transfer-encoding mishandling, charset issues)
      // would fail this equality. Under dev:fast the JSON body is
      // `{"status":"ok","db":"stub"}` — still fully deterministic.
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
    // Per-test override: 180s. dev:fast (LEV-470) brings up in ~3-5s
    // warm; the dominant cost is Next dev cold-compile (~3-30s on first
    // request under fork-pool contention) and the routing-table settle
    // (~20-30s from `lich up` returning to the first friendly URL
    // 200). Generous headroom for parallel-fork CPU competition.
    180_000,
  );
});
