/**
 * Unit tests for `lich up`.
 *
 * Strategy: spin up real owned services (no docker) under a fresh
 * LICH_HOME so port allocation + state directory layout exercise the real
 * code paths without leaking outside the tmpdir. Each fixture stack uses
 * a tiny node one-liner so tests stay fast (<5s total).
 *
 * Coverage:
 *   - happy path with two trivial owned services
 *   - lifecycle: before_up + after_up touch sentinel files
 *   - failure: owned cmd exits non-zero
 *   - failure: owned cmd never becomes ready, aborted via signal
 *   - depends_on ordering: B only starts after A's ready sentinel exists
 *   - multi-port owned: both ports injected into the env
 *   - cycle in depends_on
 *   - missing depends_on target
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runUp } from "../../../src/commands/up.js";
import {
  readSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { listAllocations, release } from "../../../src/ports/allocator.js";

// ---------------------------------------------------------------------------
// Per-test isolation: a fresh LICH_HOME tmpdir, a fresh project tmpdir.
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-home-"));
  // Worktree detection walks up looking for lich.yaml; using `prefix-stack-`
  // makes the worktree name predictable for assertions.
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
});

afterEach(async () => {
  // Release any port allocations the test created so the registry is clean
  // between tests (we're tearing down LICH_HOME anyway, but explicit cleanup
  // matches what `lich down` will do for real).
  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  // Restore env first so the tmpdir-rm doesn't race with a parallel test.
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

/**
 * Build a tiny shell command that prints READY (so log_match works), then
 * writes a sentinel file (so test assertions can verify ordering and env
 * injection), then sleeps forever.
 *
 * Using `node -e` with backslash-escaping inside YAML strings is fragile,
 * so we keep it to plain `sh` constructs: `echo READY`, `touch <sentinel>`,
 * `sleep`. Run inside `sh -c` by the supervisor.
 */
function readyServiceCmd(sentinelPath: string, extraSleep = 30): string {
  return `echo READY; touch ${shellQuote(sentinelPath)}; sleep ${extraSleep}`;
}

function shellQuote(p: string): string {
  // Path is a tmpdir under our control — no need for full POSIX quoting.
  // Just guard against spaces.
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function captureStdout(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, chunks };
}

async function loadSnapshot(stackId: string): Promise<StackSnapshot> {
  const snap = await readSnapshot(stackId);
  if (!snap) throw new Error(`no snapshot for ${stackId}`);
  return snap;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runUp — happy path", () => {
  it("starts two trivial owned services and writes status:up snapshot", async () => {
    const sentinelA = join(projectDir, "a.ready");
    const sentinelB = join(projectDir, "b.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  a:
    cmd: ${JSON.stringify(readyServiceCmd(sentinelA))}
    ready_when:
      log_match: "READY"
  b:
    cmd: ${JSON.stringify(readyServiceCmd(sentinelB))}
    ready_when:
      log_match: "READY"
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    expect(result.stackId).toBeDefined();
    expect(result.services?.find((s) => s.name === "a")?.state).toBe("ready");
    expect(result.services?.find((s) => s.name === "b")?.state).toBe("ready");

    // State.json on disk reflects status:up.
    const snap = await loadSnapshot(result.stackId!);
    expect(snap.status).toBe("up");
    expect(snap.services.find((s) => s.name === "a")?.state).toBe("ready");
    expect(snap.services.find((s) => s.name === "b")?.state).toBe("ready");

    // The sentinel files were written by the services — confirms each cmd
    // actually ran with the injected env.
    expect(existsSync(sentinelA)).toBe(true);
    expect(existsSync(sentinelB)).toBe(true);

    // Some JSON events were emitted.
    const out = Buffer.concat(chunks).toString("utf8");
    expect(out).toContain("phase_begin");
    expect(out).toContain("summary");
  }, 15_000);
});

describe("runUp — lifecycle hooks", () => {
  it("runs before_up and after_up; both touch sentinel files", async () => {
    const beforeSentinel = join(projectDir, "before.ran");
    const afterSentinel = join(projectDir, "after.ran");
    const svcSentinel = join(projectDir, "svc.ready");

    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: ${JSON.stringify(readyServiceCmd(svcSentinel))}
    ready_when:
      log_match: "READY"
lifecycle:
  before_up:
    - touch ${shellQuote(beforeSentinel)}
  after_up:
    - touch ${shellQuote(afterSentinel)}
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    expect(existsSync(beforeSentinel)).toBe(true);
    expect(existsSync(afterSentinel)).toBe(true);

    // The before sentinel must have been written BEFORE the service one
    // (lifecycle.before_up runs first by design).
    const beforeMtime = readFileMtime(beforeSentinel);
    const svcMtime = readFileMtime(svcSentinel);
    expect(beforeMtime).toBeLessThanOrEqual(svcMtime);
  }, 15_000);

  /**
   * Plan 2 Task 13 (LEV-333): the lifecycle executor's `resolveEnvGroup`
   * seam (left as throw-if-undefined in Plan 1) must now resolve real
   * env_groups. Long-form lifecycle entries with `env_group:` ran against
   * the named group's env, not `topLevelEnv`.
   *
   * Load-bearing assertion: an `after_up` entry that prints `$VAR` produces
   * the env_group's value, not the top-level env's value. Before this task
   * shipped, the executor threw "env_group not supported in Plan 1".
   */
  it("long-form lifecycle entries resolve env_group via groups resolver", async () => {
    const marker = join(projectDir, "after.marker");
    const svcSentinel = join(projectDir, "svc.ready");

    // The top-level `env: { VAR: "from-top-level" }` deliberately collides
    // with the env_group's `VAR: "from-demo-group"`. If the long-form
    // entry's env_group wiring is missing, the executor falls back to
    // topLevelEnv and the marker contains "from-top-level". With wiring
    // in place, the marker contains "from-demo-group".
    //
    // The shell pattern `printf %s "$VAR" > <marker>` writes exactly the
    // VAR contents with no trailing newline, so the test can assert on an
    // exact string match.
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
env:
  VAR: "from-top-level"
env_groups:
  demo:
    env:
      VAR: "from-demo-group"
owned:
  svc:
    cmd: ${JSON.stringify(readyServiceCmd(svcSentinel))}
    ready_when:
      log_match: "READY"
lifecycle:
  after_up:
    - cmd: ${JSON.stringify(`printf %s "$VAR" > ${marker}`)}
      env_group: "demo"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("from-demo-group");
  }, 15_000);
});

describe("runUp — failures", () => {
  it("returns exit 1 and marks state failed when an owned cmd exits non-zero", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  broken:
    cmd: "exit 1"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    expect(result.stackId).toBeDefined();

    const snap = await loadSnapshot(result.stackId!);
    expect(snap.status).toBe("failed");
    expect(snap.services.find((s) => s.name === "broken")?.state).toBe("failed");
  }, 10_000);

  it("returns exit 1 when an owned cmd starts but never becomes ready (abort via signal)", async () => {
    // Service that runs forever but never emits READY. We abort after 200ms.
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  stuck:
    cmd: "sleep 60"
    ready_when:
      log_match: "READY"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    const snap = await loadSnapshot(result.stackId!);
    expect(snap.status).toBe("failed");
    expect(snap.services.find((s) => s.name === "stuck")?.state).toBe("failed");

    // The spawned process should be cleaned up by orchestrator failure path
    // — but startOwnedService doesn't auto-kill on failure (that's Plan 4
    // rollback). Best-effort: send SIGTERM to anything left over so this
    // test's sleep child doesn't linger. The supervisor doesn't expose a
    // killer to us here; the OS will clean up when the test process exits.
  }, 10_000);
});

describe("runUp — dependency ordering", () => {
  it("waits for A's ready before starting B (depends_on)", async () => {
    // A writes a sentinel after READY. B writes its OWN sentinel as the
    // first thing it does. After up succeeds, compare mtimes: B's must be
    // >= A's, because the orchestrator must wait for A's ready_when
    // (which triggers after A's touch + echo READY) before spawning B.
    const aSentinel = join(projectDir, "a.ready");
    const bStartSentinel = join(projectDir, "b.started");

    // A takes ~300ms before emitting READY, then touches its sentinel.
    // B touches its sentinel as its very first action. Without depends_on
    // ordering, B would touch first; with it, A's READY → A's touch must
    // precede B's spawn → B's touch.
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  a:
    cmd: "touch ${aSentinel}; sleep 0.3; echo READY; sleep 30"
    ready_when:
      log_match: "READY"
  b:
    cmd: "touch ${bStartSentinel}; echo READY; sleep 30"
    depends_on: [a]
    ready_when:
      log_match: "READY"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    expect(existsSync(aSentinel)).toBe(true);
    expect(existsSync(bStartSentinel)).toBe(true);

    // B's first action runs strictly after A is ready (since A emits READY
    // first, then sleeps, then touches its sentinel — A's sentinel mtime
    // therefore reflects "ready" + a tick of margin). The depends_on edge
    // means B can't have spawned until A's ready_when resolved, so B's
    // sentinel must be >= A's sentinel within filesystem mtime precision.
    const aMtime = readFileMtimeNs(aSentinel);
    const bMtime = readFileMtimeNs(bStartSentinel);
    // A touches at t=0, sleeps 300ms, then emits READY. B can only spawn
    // after A's ready_when matches READY — so B's touch must trail A's by
    // at least the 300ms sleep window.
    expect(bMtime).toBeGreaterThan(aMtime + 200_000_000);
  }, 15_000);
});

describe("runUp — multi-port owned", () => {
  it("allocates and injects both ports into the service env", async () => {
    const sentinel = join(projectDir, "ports.dump");
    writeYaml(`
version: "1"
runtime:
  port_range: [19200, 19300]
owned:
  multi:
    cmd: "echo \\"A=$PORT_A B=$PORT_B\\" > ${sentinel}; echo READY; sleep 30"
    ports:
      a: { env: PORT_A }
      b: { env: PORT_B }
    ready_when:
      log_match: "READY"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    expect(existsSync(sentinel)).toBe(true);

    const dumped = readFileSync(sentinel, "utf8").trim();
    // Should be `A=<port> B=<port>` with non-empty numeric values.
    const m = dumped.match(/^A=(\d+) B=(\d+)$/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(19200);
    expect(Number(m![2])).toBeGreaterThanOrEqual(19200);
    expect(m![1]).not.toBe(m![2]);

    // The allocator registry recorded both ports under this stack.
    const allAllocations = await listAllocations();
    const our = allAllocations[result.stackId!];
    expect(our).toBeDefined();
    expect(Object.keys(our!)).toHaveLength(2);
  }, 15_000);
});

describe("runUp — graph errors", () => {
  it("detects depends_on cycles and exits 1", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  a:
    cmd: "sleep 30"
    depends_on: [b]
  b:
    cmd: "sleep 30"
    depends_on: [a]
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
  }, 5_000);

  it("detects missing depends_on targets and exits 1", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  a:
    cmd: "sleep 30"
    depends_on: [nonexistent]
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function readFileMtime(path: string): number {
  return Math.floor(readFileMtimeNs(path) / 1_000_000);
}

function readFileMtimeNs(path: string): number {
  // Use the file's modification time. Node's fs.statSync returns mtimeMs
  // with sub-ms precision; multiply to nanoseconds for the unit our other
  // helpers compare against.
  const { statSync } = require("node:fs") as typeof import("node:fs");
  const st = statSync(path);
  return Math.floor(st.mtimeMs * 1_000_000);
}

// Suppress unused-import warnings for utilities that aren't yet exercised
// but exist for ergonomic test setup.
void mkdirSync;
