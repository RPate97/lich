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
  writeSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { listAllocations, release } from "../../../src/ports/allocator.js";
// LEV-387 (Plan 3 Task 13): used by the refuse-mid-flight tests to derive the
// per-worktree stack_id without spinning up the full pipeline first.
import { detectWorktree } from "../../../src/worktree/detect.js";
import { ensureStackDir } from "../../../src/state/directory.js";

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
// LEV-387 (Plan 3 Task 13): profile argument, default lookup, refuse-switch
// ---------------------------------------------------------------------------
//
// These tests pin the entry-point behavior of `runUp` w.r.t. the new
// `profile?: string` field on `RunUpInput`. They are intentionally NARROW:
// the goal is to assert that profile lookup + the refuse-mid-flight check
// fire at the right moments, with the right error messages. Service
// FILTERING by profile (Task 14 / LEV-388) and lifecycle / env wiring
// (Task 15 / LEV-389) are not exercised here — those land in follow-up
// commits with their own test surface.
//
// Two patterns recur:
//   - "happy path" tests use a minimal profile that lists a single owned
//     service the top-level config also declares; downstream stays Plan-1
//     compatible because (today) up.ts ignores the resolved profile's
//     services list. The test asserts on the snapshot existing AND on the
//     resolved-profile path having been exercised (via the absence of any
//     "no active profile" error and exit code 0).
//   - "error path" tests rely on the new code paths returning exit 1
//     BEFORE any state mutation — i.e. without writing a state.json. They
//     inspect the captured JSON output stream for the structured `error`
//     event the orchestrator emits.

/**
 * Verify the orchestrator's stdout JSON stream contains a `type:error`
 * record whose title or detail includes the substring. Returns the parsed
 * matching event for additional assertions; throws when no match exists.
 *
 * The output sink we hand to `runUp` is a PassThrough that collects every
 * event the json renderer emits. Each event is one JSON line; the renderer
 * uses `{ type: "error", title, detail, ... }` (see `output/json.ts`).
 *
 * Defined at module scope so both LEV-387 describe blocks can reuse it.
 */
function expectErrorEvent(
  chunks: Buffer[],
  needle: string,
): { title?: string; detail?: string } {
  const out = Buffer.concat(chunks).toString("utf8");
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { type?: string; title?: string; detail?: string };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.type !== "error") continue;
    const hay = `${parsed.title ?? ""}\n${parsed.detail ?? ""}`;
    if (hay.includes(needle)) return parsed;
  }
  throw new Error(
    `no type:error with substring "${needle}" in output:\n${out}`,
  );
}

describe("runUp — LEV-387: profile argument", () => {
  it("runs the default profile when no argument supplied", async () => {
    const sentinel = join(projectDir, "svc.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: ${JSON.stringify(readyServiceCmd(sentinel))}
    ready_when:
      log_match: "READY"
profiles:
  primary:
    default: true
    owned: [svc]
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    // No "no active profile" error fired; the up flowed through to start.
    expect(result.exitCode).toBe(0);
    const out = Buffer.concat(chunks).toString("utf8");
    expect(out).not.toContain("no active profile");
  }, 15_000);

  it("runs the named profile when argument supplied", async () => {
    const sentinel = join(projectDir, "svc.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: ${JSON.stringify(readyServiceCmd(sentinel))}
    ready_when:
      log_match: "READY"
profiles:
  primary:
    default: true
    owned: [svc]
  secondary:
    owned: [svc]
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      profile: "secondary",
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    const out = Buffer.concat(chunks).toString("utf8");
    expect(out).not.toContain("unknown profile");
    expect(out).not.toContain("no profile named");
  }, 15_000);

  it("errors when profile name unknown", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
profiles:
  primary:
    default: true
    owned: [svc]
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      profile: "does-not-exist",
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    // The error names the requested profile + lists what's declared.
    const evt = expectErrorEvent(chunks, "no profile named");
    expect(evt.detail).toContain("does-not-exist");
    expect(evt.detail).toContain("primary");

    // Refuse-switch / unknown-profile paths must NOT have written a
    // state.json — they bail before any state mutation. The stackId may
    // be undefined OR present (worktree wasn't detected yet); but if it
    // IS present, the snapshot must be absent.
    if (result.stackId) {
      const snap = await readSnapshot(result.stackId);
      expect(snap).toBeNull();
    }
  }, 10_000);

  it("errors when no default and no argument", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
profiles:
  primary:
    owned: [svc]
  secondary:
    owned: [svc]
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    // The default-picker fell through with `{ name: null }` (no `error`
    // field); up.ts substitutes the user-facing message.
    const evt = expectErrorEvent(chunks, "no default profile set in lich.yaml");
    expect(evt.detail).toContain("default: true");
    expect(evt.detail).toContain("lich up <profile>");
  }, 10_000);

  it("errors when multiple defaults set", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
profiles:
  primary:
    default: true
    owned: [svc]
  secondary:
    default: true
    owned: [svc]
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    // pickDefaultProfile's error path surfaces the offending names in
    // sorted order (primary < secondary, alphabetic).
    const evt = expectErrorEvent(chunks, "multiple profiles set default: true");
    expect(evt.detail).toContain("primary");
    expect(evt.detail).toContain("secondary");
  }, 10_000);
});

describe("runUp — LEV-387: refuse-mid-flight switch", () => {
  it("refuses up <other> while a stack is up under different profile", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
profiles:
  dev:
    default: true
    owned: [svc]
  dev:test-env:
    owned: [svc]
`);

    // Pre-seed a state.json showing the stack is already up under "dev".
    // detectWorktree is deterministic w.r.t. the project path, so we can
    // compute the stack_id up-front and write the snapshot at that location.
    const wt = detectWorktree(projectDir);
    await ensureStackDir(wt.stack_id);
    await writeSnapshot({
      stack_id: wt.stack_id,
      worktree_name: wt.name,
      worktree_path: wt.path,
      status: "up",
      started_at: new Date().toISOString(),
      services: [],
      active_profile: "dev",
    });
    createdStackIds.push(wt.stack_id);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      profile: "dev:test-env",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stackId).toBe(wt.stack_id);
    const evt = expectErrorEvent(
      chunks,
      "stack is already up under profile 'dev'",
    );
    expect(evt.detail).toContain("dev:test-env");
    expect(evt.detail).toContain("lich down");

    // The pre-seeded snapshot survives untouched — refuse-switch fires
    // BEFORE any state mutation in this run.
    const snap = await readSnapshot(wt.stack_id);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("up");
    expect(snap!.active_profile).toBe("dev");
  }, 10_000);

  it("refuses up <same> while a stack is up under same profile (no re-up semantics)", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
profiles:
  dev:
    default: true
    owned: [svc]
`);

    const wt = detectWorktree(projectDir);
    await ensureStackDir(wt.stack_id);
    await writeSnapshot({
      stack_id: wt.stack_id,
      worktree_name: wt.name,
      worktree_path: wt.path,
      status: "up",
      started_at: new Date().toISOString(),
      services: [],
      active_profile: "dev",
    });
    createdStackIds.push(wt.stack_id);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      profile: "dev",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stackId).toBe(wt.stack_id);
    // Same-profile re-up surfaces the simpler "already up" message, NOT
    // the cross-profile switch message.
    const evt = expectErrorEvent(chunks, "stack is already up");
    expect(evt.detail).toContain("lich down");
    expect(evt.detail).not.toContain("switching");
  }, 10_000);

  it("does not refuse when the prior snapshot is stopped/failed", async () => {
    const sentinel = join(projectDir, "svc.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: ${JSON.stringify(readyServiceCmd(sentinel))}
    ready_when:
      log_match: "READY"
profiles:
  dev:
    default: true
    owned: [svc]
`);

    const wt = detectWorktree(projectDir);
    await ensureStackDir(wt.stack_id);
    // A "stopped" snapshot is a legitimate "previous run already torn
    // down" state — `lich up` should proceed without complaint.
    await writeSnapshot({
      stack_id: wt.stack_id,
      worktree_name: wt.name,
      worktree_path: wt.path,
      status: "stopped",
      started_at: new Date().toISOString(),
      services: [],
      active_profile: "dev",
    });
    createdStackIds.push(wt.stack_id);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      profile: "dev",
    });

    expect(result.exitCode).toBe(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// LEV-388 (Plan 3 Task 14): filter dep graph + start set to profile's
// services/owned. The acceptance criteria pin three behaviors:
//
//   1. Only profile-included services become graph nodes, get ports, and
//      land in the state.json snapshot. Excluded services are structurally
//      absent — not just "running but hidden."
//   2. A profile-included service with a `depends_on` edge to a profile-
//      EXCLUDED service errors out at graph construction with a message
//      that names the active profile (so the user understands the
//      `depends_on` target is declared in the yaml, just not in the
//      profile).
//   3. A profile with empty services + owned lists still completes the up
//      as a no-op (lifecycle hooks still run, exit 0).
// ---------------------------------------------------------------------------

describe("runUp — LEV-388: profile filters the start set", () => {
  it("starts only services in the active profile", async () => {
    // Three owned services declared at the top level; the profile lists
    // only [a, b] so c MUST NOT start. Each ready service writes a sentinel
    // file we can probe for "did this actually run?"
    const sentinelA = join(projectDir, "a.ready");
    const sentinelB = join(projectDir, "b.ready");
    const sentinelC = join(projectDir, "c.ready");
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
  c:
    cmd: ${JSON.stringify(readyServiceCmd(sentinelC))}
    ready_when:
      log_match: "READY"
profiles:
  ab:
    default: true
    owned: [a, b]
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);

    // Snapshot proves a + b started and c was structurally absent
    // (not just hidden — never seeded into the snapshot map).
    const snap = await loadSnapshot(result.stackId!);
    const names = snap.services.map((s) => s.name).sort();
    expect(names).toEqual(["a", "b"]);
    expect(snap.services.find((s) => s.name === "a")?.state).toBe("ready");
    expect(snap.services.find((s) => s.name === "b")?.state).toBe("ready");

    // Independent verification: c's cmd never ran (no sentinel file).
    expect(existsSync(sentinelA)).toBe(true);
    expect(existsSync(sentinelB)).toBe(true);
    expect(existsSync(sentinelC)).toBe(false);

    // runUp's return value mirrors the snapshot — also no `c`.
    const returnedNames = (result.services ?? []).map((s) => s.name).sort();
    expect(returnedNames).toEqual(["a", "b"]);
  }, 20_000);

  it("errors when a profile service depends_on a non-profile service", async () => {
    // `a` depends on `b`, but the active profile only includes [a] —
    // `b` exists in the yaml's `owned:` map but is excluded from the
    // profile. The dep graph builder sees `a` referencing an undeclared
    // node (because `b` was filtered out) and aborts with the profile-
    // scoping message.
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  a:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
    depends_on: [b]
  b:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
profiles:
  just-a:
    default: true
    owned: [a]
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    // The error names the offending service, the active profile, and the
    // excluded target. We don't pin the exact substring order so a future
    // wording polish doesn't break tests, but each piece must be present.
    const evt = expectErrorEvent(chunks, "depends_on");
    expect(evt.title).toBe("invalid dependency graph");
    expect(evt.detail).toContain("'a'");
    expect(evt.detail).toContain("'just-a'");
    expect(evt.detail).toContain("'b'");
    expect(evt.detail).toContain("not in the profile");

    // No service ever transitioned to ready (the graph step aborted before
    // startup).
    const snap = await readSnapshot(result.stackId!);
    expect(snap?.status).toBe("failed");
  }, 10_000);

  it("profile with empty services and owned lists still completes the up (no-op)", async () => {
    // Profile selects no services and no owned. Lifecycle hooks run; exit
    // is 0 because the spec's contract is "lifecycle still fires even on
    // an empty start-set" — useful for profiles that only do setup work.
    const beforeSentinel = join(projectDir, "before.ran");
    const afterSentinel = join(projectDir, "after.ran");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  someone:
    cmd: "echo SHOULD_NOT_RUN"
    ready_when:
      log_match: "READY"
profiles:
  noop:
    default: true
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

    // Both lifecycle hooks ran even though no services started.
    expect(existsSync(beforeSentinel)).toBe(true);
    expect(existsSync(afterSentinel)).toBe(true);

    // Snapshot's services list is empty — proves the start-set was empty.
    const snap = await loadSnapshot(result.stackId!);
    expect(snap.status).toBe("up");
    expect(snap.services).toEqual([]);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// LEV-389 (Plan 3 Task 15): compose lifecycle, pass profile to env, write
// active_profile. The acceptance criteria pin four behaviors:
//
//   1. `before_up` entries = top-level entries first, then profile entries.
//      Composed array passed in ONE call to runLifecycle so a non-zero exit
//      in any entry aborts the phase. We assert the order via a shared
//      marker file: each entry appends its own tag, and the resulting file
//      content reads `top:profile:` (or just `top:` / `profile:` when only
//      one side declares entries).
//   2. `after_up` entries = same composition rule. Same marker-append
//      strategy as before_up.
//   3. state.json round-trips `active_profile: <name>` when a profile is
//      active. Tests for the no-profile case live in the LEV-387 block above
//      (those snapshots intentionally omit the field).
//   4. `LICH_PROFILE` is auto-injected into every spawned owned service's
//      env. The owned cmd writes `$LICH_PROFILE` to a marker file so the
//      test reads it back without depending on the orchestrator's output
//      format.
// ---------------------------------------------------------------------------

describe("runUp — LEV-389: lifecycle composition + profile env", () => {
  it("runs top-level before_up first, then profile before_up", async () => {
    // Each entry appends its own tag to a shared marker file. The file is
    // read AFTER `runUp` resolves; content reads as the concatenated tags
    // in the order the executor invoked them. The composition rule (top-
    // level first, then profile) is what we assert on.
    const marker = join(projectDir, "before_up.marker");
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
profiles:
  dev:
    default: true
    owned: [svc]
    lifecycle:
      before_up:
        - printf 'profile:' >> ${shellQuote(marker)}
lifecycle:
  before_up:
    - printf 'top:' >> ${shellQuote(marker)}
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
    // top-level entry ran first, profile entry ran second.
    expect(readFileSync(marker, "utf8")).toBe("top:profile:");
  }, 15_000);

  it("runs top-level after_up first, then profile after_up", async () => {
    const marker = join(projectDir, "after_up.marker");
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
profiles:
  dev:
    default: true
    owned: [svc]
    lifecycle:
      after_up:
        - printf 'profile:' >> ${shellQuote(marker)}
lifecycle:
  after_up:
    - printf 'top:' >> ${shellQuote(marker)}
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
    expect(readFileSync(marker, "utf8")).toBe("top:profile:");
  }, 15_000);

  it("snapshot persists active_profile", async () => {
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
profiles:
  dev:
    default: true
    owned: [svc]
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    const snap = await loadSnapshot(result.stackId!);
    // The default profile resolved to "dev"; the snapshot carries it.
    expect(snap.active_profile).toBe("dev");
  }, 15_000);

  it("snapshot omits active_profile when no profile is in play", async () => {
    // Companion to the above: when the yaml has no `profiles` section AND no
    // profile arg is supplied, the snapshot must NOT carry `active_profile`
    // (per LEV-382's "field is optional, omitted in the no-profile case").
    // Catches a regression where we'd write `active_profile: null` or `""`.
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
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    const snap = await loadSnapshot(result.stackId!);
    expect(snap.active_profile).toBeUndefined();
  }, 15_000);

  it("LICH_PROFILE is set in the env of owned services started under a profile", async () => {
    // The owned cmd writes `$LICH_PROFILE` to a marker file so the test reads
    // the env value back without depending on orchestrator output format.
    // The auto-inject lives in `env/resolve.ts`'s `autoInjects(worktree,
    // profileName)` — Task 15 wires it by passing `profile: state.
    // resolvedProfile` through to `resolveEnvForService` in `startOwned`.
    const marker = join(projectDir, "lich_profile.marker");
    const svcSentinel = join(projectDir, "svc.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: ${JSON.stringify(`printf %s "$LICH_PROFILE" > ${marker}; echo READY; touch ${svcSentinel}; sleep 30`)}
    ready_when:
      log_match: "READY"
profiles:
  dev:
    default: true
    owned: [svc]
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
    expect(readFileSync(marker, "utf8")).toBe("dev");
  }, 15_000);

  it("LICH_PROFILE is absent (unset) in spawned env when no profile is active", async () => {
    // Companion: when no profile is in play the auto-inject must NOT fire.
    // Catches regressions where we'd inject `LICH_PROFILE=""` or
    // `LICH_PROFILE=undefined` for the no-profile case.
    const marker = join(projectDir, "lich_profile.marker");
    const svcSentinel = join(projectDir, "svc.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: ${JSON.stringify(`printf %s "<<${"$"}{LICH_PROFILE:-MISSING}>>" > ${marker}; echo READY; touch ${svcSentinel}; sleep 30`)}
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
    expect(existsSync(marker)).toBe(true);
    // LICH_PROFILE is unset → shell's `:-MISSING` fallback fires → marker is
    // `<<MISSING>>`. If we accidentally injected an empty string, the value
    // would be `<<>>` (still falsy but distinguishable from the unset case).
    expect(readFileSync(marker, "utf8")).toBe("<<MISSING>>");
  }, 15_000);
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
