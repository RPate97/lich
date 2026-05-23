import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { runLogs } from "../../../src/commands/logs.js";
import { ensureStackDir, serviceLogPath } from "../../../src/state/directory.js";
import {
  writeSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { detectWorktree } from "../../../src/worktree/detect.js";

// ---------------------------------------------------------------------------
// Test sink that captures bytes written by runLogs.
// ---------------------------------------------------------------------------

class StringWritable extends Writable {
  chunks: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (e?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// Fixture: fake worktree (lich.yaml + LICH_HOME-scoped state dir).
// ---------------------------------------------------------------------------

let home: string;
let wtRoot: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-logs-home-"));
  wtRoot = mkdtempSync(join(tmpdir(), "lich-logs-wt-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;
  // detectWorktree walks up looking for lich.yaml. Plant an empty file
  // so the walk terminates at wtRoot.
  writeFileSync(join(wtRoot, "lich.yaml"), 'version: "1"\n', "utf8");
});

afterEach(() => {
  if (prevLichHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevLichHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

/**
 * Compute the stack id detectWorktree would derive for wtRoot, write a
 * minimal snapshot with the given service names, and create empty log
 * files under <stackDir>/logs/. Returns the stack id and a writer that
 * appends to a service's log file.
 */
async function plantStack(serviceNames: string[]): Promise<{
  stackId: string;
  appendLog: (name: string, text: string) => void;
}> {
  const wt = detectWorktree(wtRoot);
  const stackId = wt.stack_id;
  await ensureStackDir(stackId);

  const snapshot: StackSnapshot = {
    stack_id: stackId,
    worktree_name: wt.name,
    worktree_path: wt.path,
    status: "up",
    started_at: new Date().toISOString(),
    services: serviceNames.map((name) => ({
      name,
      kind: "owned" as const,
      state: "ready" as const,
    })),
  };
  await writeSnapshot(snapshot);

  // Create empty log files so the supervisor analogue is set up.
  for (const name of serviceNames) {
    writeFileSync(serviceLogPath(stackId, name), "", "utf8");
  }

  return {
    stackId,
    appendLog: (name, text) => {
      appendFileSync(serviceLogPath(stackId, name), text, "utf8");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLogs — no stack present", () => {
  it("exits 1 and prints 'no stack found for this worktree' when state.json is missing", async () => {
    // No plantStack call — directory has a lich.yaml but no state.
    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      tail: 200,
      cwd: wtRoot,
      out,
    });
    await result.done;
    expect(result.exitCode).toBe(1);
    expect(out.text()).toContain("no stack found for this worktree");
  });

  it("exits 1 with the same message when no lich.yaml is anywhere up the tree", async () => {
    // Remove the lich.yaml planted in beforeEach. detectWorktree will
    // throw; runLogs should surface that as "no stack found".
    rmSync(join(wtRoot, "lich.yaml"));
    // Also create a nested dir that's not under any lich.yaml.
    const deeper = join(wtRoot, "nested");
    mkdirSync(deeper);

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      tail: 200,
      cwd: deeper,
      out,
    });
    await result.done;
    expect(result.exitCode).toBe(1);
    expect(out.text()).toContain("no stack found for this worktree");
  });
});

describe("runLogs — aggregate (no service arg)", () => {
  it("prints every line from a single service with [svc] prefix", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "boot\nready\nrequest 1\n");

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      tail: 200,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    // Single service still gets prefixed when no service arg is supplied?
    // Spec: "Suppress prefix when only one service is being tailed."
    // With aggregate mode + only one service, only one service is being
    // tailed → no prefix.
    const text = out.text();
    expect(text).toContain("boot");
    expect(text).toContain("ready");
    expect(text).toContain("request 1");
    expect(text).not.toContain("[api]");
  });

  it("prefixes every line with [name] when multiple services are aggregated", async () => {
    const { appendLog } = await plantStack(["api", "web"]);
    appendLog("api", "api line 1\napi line 2\n");
    appendLog("web", "web line 1\nweb line 2\n");

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      tail: 200,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("[api] api line 1");
    expect(text).toContain("[api] api line 2");
    expect(text).toContain("[web] web line 1");
    expect(text).toContain("[web] web line 2");
  });

  it("limits initial output to tail N lines per service", async () => {
    const { appendLog } = await plantStack(["api", "web"]);
    appendLog(
      "api",
      ["a1", "a2", "a3", "a4", "a5"].map((l) => l + "\n").join(""),
    );
    appendLog(
      "web",
      ["w1", "w2", "w3", "w4", "w5"].map((l) => l + "\n").join(""),
    );

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      tail: 3,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    // Last 3 from each.
    expect(text).toContain("[api] a3");
    expect(text).toContain("[api] a4");
    expect(text).toContain("[api] a5");
    expect(text).toContain("[web] w3");
    expect(text).toContain("[web] w4");
    expect(text).toContain("[web] w5");
    // First two from each must be dropped.
    expect(text).not.toContain("[api] a1");
    expect(text).not.toContain("[api] a2");
    expect(text).not.toContain("[web] w1");
    expect(text).not.toContain("[web] w2");
  });
});

describe("runLogs — service filter", () => {
  it("with a valid name, streams only that service and omits the prefix", async () => {
    const { appendLog } = await plantStack(["api", "web"]);
    appendLog("api", "api line\n");
    appendLog("web", "web line\n");

    const out = new StringWritable();
    const result = runLogs({
      service: "api",
      follow: false,
      tail: 200,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("api line");
    expect(text).not.toContain("web line");
    expect(text).not.toContain("[api]");
    expect(text).not.toContain("[web]");
  });

  it("with an unknown name, exits 1 and lists the available services", async () => {
    await plantStack(["api", "web", "postgres"]);

    const out = new StringWritable();
    const result = runLogs({
      service: "nope",
      follow: false,
      tail: 200,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(1);
    const text = out.text();
    expect(text).toMatch(/unknown service "nope"/);
    expect(text).toContain("api");
    expect(text).toContain("web");
    expect(text).toContain("postgres");
  });
});

describe("runLogs — follow mode", () => {
  it("emits bytes appended after the initial dump and stops when aborted", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "initial\n");

    const out = new StringWritable();
    const ac = new AbortController();
    const result = runLogs({
      service: "api",
      follow: true,
      tail: 50,
      cwd: wtRoot,
      out,
      signal: ac.signal,
    });

    // Append a few new lines after a brief delay so the poll loop picks
    // them up.
    setTimeout(() => appendLog("api", "appended-1\nappended-2\n"), 50);

    // Give the loop time to read the appended bytes, then abort.
    await new Promise<void>((r) => setTimeout(r, 400));
    ac.abort();

    // done resolves once the loop sees the abort.
    await result.done;

    const text = out.text();
    expect(text).toContain("initial");
    expect(text).toContain("appended-1");
    expect(text).toContain("appended-2");
    // exitCode 0 on a clean abort — follow mode "exits" normally on Ctrl-C.
    expect(result.exitCode).toBe(0);
  });

  it("uses tail N for the initial dump even in follow mode", async () => {
    const { appendLog } = await plantStack(["api"]);
    const seed = Array.from({ length: 10 }, (_, i) => `seed-${i + 1}`)
      .map((l) => l + "\n")
      .join("");
    appendLog("api", seed);

    const out = new StringWritable();
    const ac = new AbortController();
    const result = runLogs({
      service: "api",
      follow: true,
      tail: 3,
      cwd: wtRoot,
      out,
      signal: ac.signal,
    });

    // Abort almost immediately — we only care about the initial dump.
    await new Promise<void>((r) => setTimeout(r, 50));
    ac.abort();
    await result.done;

    const text = out.text();
    expect(text).toContain("seed-8");
    expect(text).toContain("seed-9");
    expect(text).toContain("seed-10");
    expect(text).not.toContain("seed-1\n");
    expect(text).not.toContain("seed-2\n");
    expect(text).not.toContain("seed-7\n");
  });

  it("emits new bytes from multiple services interleaved with prefixes in aggregate follow mode", async () => {
    const { appendLog } = await plantStack(["api", "web"]);
    // Start with empty logs.

    const out = new StringWritable();
    const ac = new AbortController();
    const result = runLogs({
      follow: true,
      tail: 50,
      cwd: wtRoot,
      out,
      signal: ac.signal,
    });

    setTimeout(() => appendLog("api", "from-api\n"), 50);
    setTimeout(() => appendLog("web", "from-web\n"), 80);

    await new Promise<void>((r) => setTimeout(r, 400));
    ac.abort();
    await result.done;

    const text = out.text();
    expect(text).toContain("[api] from-api");
    expect(text).toContain("[web] from-web");
  });
});
