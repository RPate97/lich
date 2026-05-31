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
import { detectWorktree } from "../../../src/worktree/detect.js";
import { ensureStackDir } from "../../../src/state/directory.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
});

afterEach(async () => {
  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function readyServiceCmd(sentinelPath: string, extraSleep = 30): string {
  return `echo READY; touch ${shellQuote(sentinelPath)}; sleep ${extraSleep}`;
}

function shellQuote(p: string): string {
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

    expect(existsSync(sentinelA)).toBe(true);
    expect(existsSync(sentinelB)).toBe(true);

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

    // before_up runs first by design
    const beforeMtime = readFileMtime(beforeSentinel);
    const svcMtime = readFileMtime(svcSentinel);
    expect(beforeMtime).toBeLessThanOrEqual(svcMtime);
  }, 15_000);

  it("long-form lifecycle entries resolve env_group via groups resolver", async () => {
    const marker = join(projectDir, "after.marker");
    const svcSentinel = join(projectDir, "svc.ready");

    // top-level env.VAR collides with env_groups.demo.env.VAR; marker tells
    // which path won. printf %s avoids a trailing newline for exact match.
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
  }, 10_000);
});

describe("runUp — dependency ordering", () => {
  it("waits for A's ready before starting B (depends_on)", async () => {
    const aSentinel = join(projectDir, "a.ready");
    const bStartSentinel = join(projectDir, "b.started");

    // A: ~300ms before READY then sentinel; B: sentinel as first action.
    // depends_on means B can only start after A's ready_when matches.
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

    // B's touch must trail A's by ≥ the 300ms ready-emit window
    const aMtime = readFileMtimeNs(aSentinel);
    const bMtime = readFileMtimeNs(bStartSentinel);
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
      a: { published_env: PORT_A }
      b: { published_env: PORT_B }
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
    const m = dumped.match(/^A=(\d+) B=(\d+)$/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(19200);
    expect(Number(m![2])).toBeGreaterThanOrEqual(19200);
    expect(m![1]).not.toBe(m![2]);

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

describe("runUp — profile argument", () => {
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
    const evt = expectErrorEvent(chunks, "no profile named");
    expect(evt.detail).toContain("does-not-exist");
    expect(evt.detail).toContain("primary");

    // unknown-profile bails before any state mutation
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

describe("runUp — refuse-mid-flight switch", () => {
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

    // pre-seed state.json: stack is already up under "dev"
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

    // refuse-switch fires before any state mutation
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
    // same-profile re-up: simpler "already up" message, not cross-profile switch
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

describe("runUp — profile filters the start set", () => {
  it("starts only services in the active profile", async () => {
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

    const snap = await loadSnapshot(result.stackId!);
    const names = snap.services.map((s) => s.name).sort();
    expect(names).toEqual(["a", "b"]);
    expect(snap.services.find((s) => s.name === "a")?.state).toBe("ready");
    expect(snap.services.find((s) => s.name === "b")?.state).toBe("ready");

    // c's cmd never ran
    expect(existsSync(sentinelA)).toBe(true);
    expect(existsSync(sentinelB)).toBe(true);
    expect(existsSync(sentinelC)).toBe(false);

    const returnedNames = (result.services ?? []).map((s) => s.name).sort();
    expect(returnedNames).toEqual(["a", "b"]);
  }, 20_000);

  it("errors when a profile service depends_on a non-profile service", async () => {
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
    const evt = expectErrorEvent(chunks, "depends_on");
    expect(evt.title).toBe("invalid dependency graph");
    expect(evt.detail).toContain("'a'");
    expect(evt.detail).toContain("'just-a'");
    expect(evt.detail).toContain("'b'");
    expect(evt.detail).toContain("not in the profile");

    const snap = await readSnapshot(result.stackId!);
    expect(snap?.status).toBe("failed");
  }, 10_000);

  it("profile with empty services and owned lists still completes the up (no-op)", async () => {
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

    expect(existsSync(beforeSentinel)).toBe(true);
    expect(existsSync(afterSentinel)).toBe(true);

    const snap = await loadSnapshot(result.stackId!);
    expect(snap.status).toBe("up");
    expect(snap.services).toEqual([]);
  }, 10_000);
});

describe("runUp — lifecycle composition + profile env", () => {
  it("runs top-level before_up first, then profile before_up", async () => {
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
    expect(snap.active_profile).toBe("dev");
  }, 15_000);

  it("snapshot omits active_profile when no profile is in play", async () => {
    // catches regressions writing `active_profile: null` or `""`
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
    // LICH_PROFILE unset → :- fallback fires → <<MISSING>>;
    // `<<>>` would mean we injected an empty string instead
    expect(readFileSync(marker, "utf8")).toBe("<<MISSING>>");
  }, 15_000);
});

describe("runUp — lifecycle hooks see per-owned-service port env vars", () => {
  it("before_up env carries singular-port env var (port: { published_env: NAME })", async () => {
    const sentinel = join(projectDir, "before-port.dump");
    writeYaml(`
version: "1"
runtime:
  port_range: [19500, 19600]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    port: { published_env: MY_SVC_PORT }
    ready_when:
      log_match: "READY"
lifecycle:
  before_up:
    - cmd: ${JSON.stringify(`printf %s "$MY_SVC_PORT" > ${sentinel}`)}
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
    const dumped = readFileSync(sentinel, "utf8");
    expect(dumped).toMatch(/^\d+$/);
    const port = Number(dumped);
    expect(port).toBeGreaterThanOrEqual(19500);
    expect(port).toBeLessThanOrEqual(19600);
  }, 15_000);

  it("after_up env carries singular-port env var (port: { published_env: NAME })", async () => {
    const sentinel = join(projectDir, "after-port.dump");
    writeYaml(`
version: "1"
runtime:
  port_range: [19500, 19600]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    port: { published_env: MY_SVC_PORT }
    ready_when:
      log_match: "READY"
lifecycle:
  after_up:
    - cmd: ${JSON.stringify(`printf %s "$MY_SVC_PORT" > ${sentinel}`)}
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
    const dumped = readFileSync(sentinel, "utf8");
    expect(dumped).toMatch(/^\d+$/);
    const port = Number(dumped);
    expect(port).toBeGreaterThanOrEqual(19500);
    expect(port).toBeLessThanOrEqual(19600);
  }, 15_000);

  it("before_up + after_up envs carry multi-port env vars (ports: { key: { published_env: NAME } })", async () => {
    const beforeDump = join(projectDir, "before-multi.dump");
    const afterDump = join(projectDir, "after-multi.dump");
    writeYaml(`
version: "1"
runtime:
  port_range: [19700, 19800]
owned:
  multi:
    cmd: "echo READY; sleep 30"
    ports:
      api: { published_env: API_PORT }
      db: { published_env: DB_PORT }
    ready_when:
      log_match: "READY"
lifecycle:
  before_up:
    - cmd: ${JSON.stringify(`printf "API=%s DB=%s" "$API_PORT" "$DB_PORT" > ${beforeDump}`)}
  after_up:
    - cmd: ${JSON.stringify(`printf "API=%s DB=%s" "$API_PORT" "$DB_PORT" > ${afterDump}`)}
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);

    for (const sentinel of [beforeDump, afterDump]) {
      expect(existsSync(sentinel)).toBe(true);
      const dumped = readFileSync(sentinel, "utf8");
      const m = dumped.match(/^API=(\d+) DB=(\d+)$/);
      expect(m, `sentinel ${sentinel} contents: ${JSON.stringify(dumped)}`).not.toBeNull();
      const api = Number(m![1]);
      const db = Number(m![2]);
      expect(api).toBeGreaterThanOrEqual(19700);
      expect(api).toBeLessThanOrEqual(19800);
      expect(db).toBeGreaterThanOrEqual(19700);
      expect(db).toBeLessThanOrEqual(19800);
      expect(api).not.toBe(db);
    }
  }, 15_000);

  it("lifecycle env merges port vars across multiple owned services", async () => {
    const sentinel = join(projectDir, "merge.dump");
    writeYaml(`
version: "1"
runtime:
  port_range: [19900, 19999]
owned:
  alpha:
    cmd: "echo READY; sleep 30"
    port: { published_env: ALPHA_PORT }
    ready_when:
      log_match: "READY"
  beta:
    cmd: "echo READY; sleep 30"
    port: { published_env: BETA_PORT }
    ready_when:
      log_match: "READY"
lifecycle:
  after_up:
    - cmd: ${JSON.stringify(`printf "A=%s B=%s" "$ALPHA_PORT" "$BETA_PORT" > ${sentinel}`)}
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
    const dumped = readFileSync(sentinel, "utf8");
    const m = dumped.match(/^A=(\d+) B=(\d+)$/);
    expect(m, `sentinel contents: ${JSON.stringify(dumped)}`).not.toBeNull();
    const a = Number(m![1]);
    const b = Number(m![2]);
    expect(a).toBeGreaterThanOrEqual(19900);
    expect(a).toBeLessThanOrEqual(19999);
    expect(b).toBeGreaterThanOrEqual(19900);
    expect(b).toBeLessThanOrEqual(19999);
    expect(a).not.toBe(b);
  }, 15_000);
});

describe("runUp — lifecycle env_group resolves with active profile", () => {
  it("long-form lifecycle entry with `env_group: stack` sees profile-scoped env override", async () => {
    const marker = join(projectDir, "after_up.marker");
    const svcSentinel = join(projectDir, "svc.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
env:
  VAR: "from-top-level"
owned:
  svc:
    cmd: ${JSON.stringify(readyServiceCmd(svcSentinel))}
    ready_when:
      log_match: "READY"
profiles:
  dev:
    default: true
    owned: [svc]
    env:
      VAR: "from-profile"
lifecycle:
  after_up:
    - cmd: ${JSON.stringify(`printf %s "$VAR" > ${marker}`)}
      env_group: "stack"
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
    expect(readFileSync(marker, "utf8")).toBe("from-profile");
  }, 15_000);

  it("LICH_PROFILE is set in long-form lifecycle entries using `env_group: stack`", async () => {
    const marker = join(projectDir, "lich_profile.marker");
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
    - cmd: ${JSON.stringify(`printf %s "$LICH_PROFILE" > ${marker}`)}
      env_group: "stack"
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
});

describe("runUp — ownedSnapshotOverrides (LEV-527)", () => {
  it("uses override env / cmd / cwd / stop_cmd for matching owned service and ignores yaml-defined env", async () => {
    const sentinel = join(projectDir, "svc.ready");
    const envMarker = join(projectDir, "env.marker");
    // yaml says SECRET=from-yaml. Override says SECRET=from-snapshot.
    // The override must win; the marker file contains "from-snapshot".
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
env:
  SECRET: "from-yaml"
owned:
  svc:
    cmd: ${JSON.stringify(`echo from-yaml-cmd > ${envMarker}; sleep 30`)}
`);

    // Override cmd writes the env value to disk so the test can prove the override path ran.
    const overrideCmd = `printf %s "$SECRET" > ${envMarker}; echo READY; touch ${shellQuote(sentinel)}; sleep 30`;
    const overrides = new Map([
      [
        "svc",
        {
          env: { PATH: process.env.PATH ?? "/usr/bin", SECRET: "from-snapshot" },
          cmd: overrideCmd,
          cwd: projectDir,
        },
      ],
    ]);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      ownedSnapshotOverrides: overrides,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    // marker proves the override cmd (not the yaml cmd) ran AND override SECRET (not yaml SECRET) was in env
    expect(existsSync(envMarker)).toBe(true);
    expect(readFileSync(envMarker, "utf8")).toBe("from-snapshot");
  }, 15_000);

  it("falls back to yaml resolution for services NOT present in the overrides map", async () => {
    const sentinelA = join(projectDir, "a.ready");
    const sentinelB = join(projectDir, "b.ready");
    const aMarker = join(projectDir, "a.env.marker");
    const bMarker = join(projectDir, "b.env.marker");

    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
env:
  SHARED: "from-yaml"
owned:
  a:
    cmd: ${JSON.stringify(`printf %s "$SHARED" > ${aMarker}; echo READY; touch ${shellQuote(sentinelA)}; sleep 30`)}
    ready_when:
      log_match: "READY"
  b:
    cmd: ${JSON.stringify(`printf %s "$SHARED" > ${bMarker}; echo READY; touch ${shellQuote(sentinelB)}; sleep 30`)}
    ready_when:
      log_match: "READY"
`);

    // Override only "a"; "b" should re-resolve from yaml.
    const overrides = new Map([
      [
        "a",
        {
          env: { PATH: process.env.PATH ?? "/usr/bin", SHARED: "override-for-a" },
          cmd: `printf %s "$SHARED" > ${aMarker}; echo READY; touch ${shellQuote(sentinelA)}; sleep 30`,
          cwd: projectDir,
        },
      ],
    ]);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      ownedSnapshotOverrides: overrides,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(aMarker, "utf8")).toBe("override-for-a");
    expect(readFileSync(bMarker, "utf8")).toBe("from-yaml");
  }, 15_000);

  it("writes the snapshot resolved_env back as it was passed in (override env preserved)", async () => {
    const sentinel = join(projectDir, "svc.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [19000, 19100]
owned:
  svc:
    cmd: ${JSON.stringify(`echo READY; touch ${shellQuote(sentinel)}; sleep 30`)}
    ready_when:
      log_match: "READY"
`);

    const overrides = new Map([
      [
        "svc",
        {
          env: { PATH: process.env.PATH ?? "/usr/bin", PINNED: "from-override" },
          cmd: `echo READY; touch ${shellQuote(sentinel)}; sleep 30`,
          cwd: projectDir,
        },
      ],
    ]);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      ownedSnapshotOverrides: overrides,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);
    const snap = await loadSnapshot(result.stackId!);
    const svcSnap = snap.services.find((s) => s.name === "svc");
    expect(svcSnap?.resolved_env?.PINNED).toBe("from-override");
  }, 15_000);
});

function readFileMtime(path: string): number {
  return Math.floor(readFileMtimeNs(path) / 1_000_000);
}

function readFileMtimeNs(path: string): number {
  const { statSync } = require("node:fs") as typeof import("node:fs");
  const st = statSync(path);
  return Math.floor(st.mtimeMs * 1_000_000);
}

// suppress unused-import warning
void mkdirSync;
