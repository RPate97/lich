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
 *   3. `serves the web app over its friendly URL` — TODO (Plan 5)
 *      Gated with `it.todo(...)`. The friendly URL
 *      `http://web.<worktree>.lich.localhost:3300/` requires the daemon +
 *      reverse proxy from Plan 5. Until then, Plan 1's raw URLs (test 2)
 *      are the lich-up acceptance bar.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one).
 *   - LICH_HOME pointed at a per-test tmp directory so the real ~/.lich
 *     stays untouched (no collisions with the user's own runs).
 *   - lich binary built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich down` runs in `afterEach` even when the test body throws.
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

      // ---- lich up ------------------------------------------------------
      // Run synchronously: `lich up` returns once the stack is fully ready
      // (services are detached — owned services run in their own process
      // groups, compose runs `-d`). Generous timeout: first run pulls the
      // supabase images, which can take a couple of minutes on a cold host.
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

      // ---- state.json: status:up ---------------------------------------
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");
      const serviceNames = snap.services.map((s) => s.name).sort();
      // The dogfood stack defines exactly these three services.
      expect(serviceNames).toEqual(["api", "supabase", "web"]);

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
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      const health = await fetch(`${apiUrl}/health`).then((r) => r.json());
      expect(health).toMatchObject({ status: "ok" });

      // web: single-port → "default"; verify root returns 200 HTML.
      const webUrl = urls.web?.default;
      expect(webUrl, `expected web url in: ${urlsResult.stdout}`).toBeTruthy();
      // Next.js dev cold compile on first request usually ~3-8s.
      await waitForHttp200(webUrl!, { timeoutMs: 20_000 });
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

  // Friendly URL — gated on Plan 5 (daemon + reverse proxy).
  // The pattern `http://<service>.<worktree>.lich.localhost:3300/` lives in
  // the spec under section 5; until the proxy is up, there's nothing to
  // resolve that hostname or terminate that port.
  // TODO(Plan 5): unskip and assert HTTP 200 + same HTML body as raw URL.
  it.todo(
    "serves the web app over http://web.<worktree>.lich.localhost:3300/ (pending Plan 5 daemon + proxy)",
  );
});
