/**
 * Plan 4 Task 23 — port-already-in-use is detected and surfaced (LEV-372).
 *
 * What this exercises
 * -------------------
 * The full "host port conflict" detection chain: the user pins a host port in
 * `owned.<name>.port.host_port`, lich's allocator tries to reserve it before
 * any service spawns, and the bind-probe in `ports/allocator.ts#isPortFree`
 * trips because the test process is already holding that port via a stub
 * server. The orchestrator's catch-all then renders the error through
 * `output.error(...)` with the port number + the "in use" phrase so the user
 * can grep their `lich up` output and know exactly which port collided.
 *
 * Why this is the right detection layer to assert on
 * --------------------------------------------------
 * The Plan 4 spec note suggests the `fail_when.log_match: "EADDRINUSE|..."`
 * watcher could ALSO catch this — and it can, IF the framework actually
 * spawns and prints `EADDRINUSE`. But on a pinned port the allocator's
 * pre-check (`allocate()` Pass 1 in `packages/lich/src/ports/allocator.ts`
 * lines 166-192) fires FIRST: it does a real `net.createServer().listen()`
 * probe with `host: "0.0.0.0", exclusive: true` and throws
 * `"lich: pinned port <X> for <stack>.<svc> is in use by another process on
 * the host"` before any owned service is spawned. So in practice the
 * orchestrator never reaches the `fail_when` watcher for this scenario —
 * which is the correct UX: failing at allocation is fast, deterministic, and
 * the error message already names the port + the conflict. The fail_when
 * chain is exercised independently by Task 20's
 * `failure-fail-when.test.ts` (LEV-369), where a service emits the matching
 * line on its own without a port conflict.
 *
 * Test arrangement (matches the acceptance criteria in LEV-372)
 * -------------------------------------------------------------
 *   1. Bind a trivial HTTP stub to a free OS-assigned port (port 0 → real
 *      port allocated by the kernel). Listen on `0.0.0.0` so the allocator's
 *      `host: "0.0.0.0", exclusive: true` probe collides at the kernel level
 *      regardless of which interface the test stub thinks it grabbed.
 *   2. Copy dogfood-stack to a fresh tmpdir.
 *   3. Mutate the tmpdir's `lich.yaml`: rewrite the `api` block's
 *      `port: { env: PORT }` line to `port: { env: PORT, host_port: <X> }`.
 *      Anchored on the api block's two-line prefix so the same shape on
 *      the `web` block is not affected — no YAML parser needed (the e2e
 *      package intentionally stays dependency-free; same pattern as the
 *      static fixtures in `failure-validate-bad-regex.test.ts`).
 *   4. Run `lich up`. Expect:
 *        - exit code != 0 within ~30s (the allocator probe is sync; in
 *          practice this finishes in seconds, but we budget generously to
 *          absorb cold-start binary load on CI).
 *        - the error output names the conflicted port (the literal `<X>`).
 *        - the error output names the conflict ("in use" / "EADDRINUSE" /
 *          the allocator's "is in use by another process" string — we
 *          accept any of the well-known phrases so the test doesn't pin
 *          itself to one error-message wording).
 *
 * Cleanup contract
 * ----------------
 * `afterEach` ALWAYS runs (matches testing-standards §"Resource cleanup
 * contract"):
 *   - Stub server is closed and awaited (so the OS-released port is freed
 *     before the next test runs).
 *   - `lich down` is best-effort invoked on the tmpdir; the allocator-pre-
 *     check path means no services were spawned, but if the failure mode
 *     ever shifts to a later phase (e.g. the framework's EADDRINUSE path),
 *     we still want services / containers cleaned up.
 *   - tmpdir + LICH_HOME removed.
 *
 * Speed
 * -----
 * Allocator pre-check is microseconds; the whole test should finish in well
 * under 10 seconds excluding the binary build (which is cached after the
 * first test runs).
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail loudly on a missing/broken build rather
// than skipping — the binary IS the system-under-test. Same pattern as
// basic-up.test.ts / failure-validate-bad-regex.test.ts.
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
// Per-test fixture state
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
  stub: Server | null;
  stubPort: number | null;
}

let fixture: Fixture | null = null;

/**
 * Listen on an OS-assigned free port (port 0). Bind to `0.0.0.0` so the
 * allocator's `host: "0.0.0.0", exclusive: true` probe collides at the
 * kernel level regardless of which interface it tries. Resolves with the
 * assigned port number once the server is actually listening.
 */
function startStubOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolveFn, rejectFn) => {
    const server = createServer((sock) => {
      // Trivial echo-and-close — the test never sends traffic here, but if a
      // confused process ever does, we don't want to hang the connection.
      sock.end();
    });
    server.once("error", rejectFn);
    server.listen({ port: 0, host: "0.0.0.0", exclusive: true }, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        rejectFn(
          new Error(`unexpected server.address() shape: ${JSON.stringify(addr)}`),
        );
        return;
      }
      resolveFn({ server, port: addr.port });
    });
  });
}

function stopStub(server: Server): Promise<void> {
  return new Promise((resolveFn) => {
    server.close(() => resolveFn());
  });
}

afterEach(async () => {
  if (!fixture) return;
  const fix = fixture;
  fixture = null;

  // Stop the stub first so the OS releases the port before subsequent tests.
  if (fix.stub) {
    try {
      await stopStub(fix.stub);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`afterEach stub close failed:`, err);
    }
  }

  // Best-effort lich down. The allocator-pre-check path means no services
  // were spawned, but `lich down` is idempotent and the safety net catches
  // any future scenario where the failure mode shifts to a later phase.
  //
  // LEV-465: timeout tightened from 60s → 20s. afterEach is fast-cleanup
  // territory; vitest's hookTimeout caps at 60s anyway, so the old value
  // could never fire — it just masked teardown hangs as the wrong error.
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich up — port already in use on a pinned owned port", () => {
  it(
    "fails fast and names the conflicted port",
    async () => {
      // ---- 1. Start the stub on a free OS-assigned port ------------------
      const { server: stub, port: stubPort } = await startStubOnFreePort();

      // ---- 2. Copy dogfood-stack to a fresh tmpdir -----------------------
      // install: false — the failure fires at allocate-ports (before any
      // owned service spawns), so we don't need `next` in node_modules/.bin.
      // Keeping the install off makes the test ~30s faster.
      const stack = copyExampleToTmpdir("dogfood-stack");
      const lichHome = mkdtempSync(
        join(tmpdir(), "lich-e2e-port-in-use-home-"),
      );
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome,
        stub,
        stubPort,
      };

      // ---- 3. Mutate lich.yaml: pin api's port to the stub's port ---------
      // Scoped single-occurrence rewrite. Both `api` and `web` carry the
      // same `port: { env: PORT }` shape in the dogfood yaml, so a plain
      // text replace would clobber web too. Anchoring on the api block's
      // unique two-line prefix (`cwd: apps/api\n    port: ...`) targets
      // exactly the api descriptor without depending on a YAML parser
      // (the e2e package stays dependency-free; same pattern as the static
      // fixtures in `failure-validate-bad-regex.test.ts`). If a future
      // refactor changes the api block's formatting, the occurrence
      // assertion fails loudly with a clear message rather than silently
      // mis-replacing or mutating the wrong service's port.
      const lichYamlPath = join(stack.path, "lich.yaml");
      const original = readFileSync(lichYamlPath, "utf8");
      const needle = "cwd: apps/api\n    port: { env: PORT }";
      const occurrences = original.split(needle).length - 1;
      expect(
        occurrences,
        `expected exactly one occurrence of the api block's port descriptor ` +
          `(\`${needle.replace("\n", "\\n")}\`) in dogfood-stack/lich.yaml; ` +
          `got ${occurrences}. Did the api block's formatting change? ` +
          `Update this test's mutation to match.`,
      ).toBe(1);
      const mutated = original.replace(
        needle,
        `cwd: apps/api\n    port: { env: PORT, host_port: ${stubPort} }`,
      );
      writeFileSync(lichYamlPath, mutated, "utf8");

      // ---- 4. Run `lich up` and expect a fast failure --------------------
      // 30s budget per the acceptance criteria; in practice the allocator
      // probe fires in milliseconds — the budget is for cold binary load
      // + filesystem setup on the slowest CI machine.
      //
      // `--no-browser` is defensive: `up` fails at the allocator pre-check
      // before any service starts, so the daemon never spawns either way.
      // Matches the fast-pool convention.
      const result = runLich(["up", "--no-browser"], {
        cwd: stack.path,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });

      // Non-zero exit is the load-bearing assertion. On success the test
      // failed to provoke the conflict; surface stdout/stderr so the
      // mutation/probe interaction can be diagnosed.
      if (result.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("unexpected lich up success — stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("unexpected lich up success — stderr:", result.stderr);
      }
      expect(
        result.exitCode,
        `lich up should fail when port ${stubPort} is held by another process`,
      ).not.toBe(0);

      // The combined output must name the conflicted port AND the conflict.
      // We accept the allocator's "is in use" phrase OR the framework's
      // "EADDRINUSE" phrase (in case a future change shifts the failure
      // mode to the fail_when chain — the test's contract is "user can find
      // the port number and learn there's a conflict", not "the message is
      // this exact string").
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(
        combined,
        `expected output to mention the conflicted port ${stubPort}; got:\n${combined}`,
      ).toContain(String(stubPort));

      const conflictPhrase = /in use|EADDRINUSE|already (?:reserved|held|in use)/i;
      expect(
        conflictPhrase.test(combined),
        `expected output to mention a port conflict (one of: "in use" / "EADDRINUSE" / ` +
          `"already reserved|held|in use"); got:\n${combined}`,
      ).toBe(true);
    },
    // Per-test override: 45s — generous bound over the 30s acceptance
    // criterion to absorb cold binary load + tmpdir copy + the
    // best-effort lich down in afterEach.
    45_000,
  );
});
