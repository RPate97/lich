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
import { ensureStackDir, serviceLogPath, phaseLogPath } from "../../../src/state/directory.js";
import {
  writeSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { detectWorktree } from "../../../src/worktree/detect.js";

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

let home: string;
let wtRoot: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-logs-home-"));
  wtRoot = mkdtempSync(join(tmpdir(), "lich-logs-wt-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;
  writeFileSync(join(wtRoot, "lich.yaml"), 'version: "1"\n', "utf8");
});

afterEach(() => {
  if (prevLichHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevLichHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
});

async function plantStack(serviceNames: string[]): Promise<{
  stackId: string;
  appendLog: (name: string, text: string) => void;
  appendPhaseLog: (phase: string, text: string) => void;
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

  for (const name of serviceNames) {
    writeFileSync(serviceLogPath(stackId, name), "", "utf8");
  }

  return {
    stackId,
    appendLog: (name, text) => {
      appendFileSync(serviceLogPath(stackId, name), text, "utf8");
    },
    appendPhaseLog: (phase, text) => {
      const logPath = join(home, "stacks", stackId, "logs", `${phase}.log`);
      mkdirSync(join(home, "stacks", stackId, "logs"), { recursive: true });
      appendFileSync(logPath, text, "utf8");
    },
  };
}

describe("runLogs — no stack present", () => {
  it("exits 1 and prints 'no stack found for this worktree' when state.json is missing", async () => {
    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 200,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;
    expect(result.exitCode).toBe(1);
    expect(out.text()).toContain("no stack found for this worktree");
  });

  it("exits 1 with the same message when no lich.yaml is anywhere up the tree", async () => {
    rmSync(join(wtRoot, "lich.yaml"));
    const deeper = join(wtRoot, "nested");
    mkdirSync(deeper);

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 200,
      all: false,
      json: false,
      cwd: deeper,
      out,
    });
    await result.done;
    expect(result.exitCode).toBe(1);
    expect(out.text()).toContain("no stack found for this worktree");
  });
});

describe("runLogs — default mode (last 100 lines, exits)", () => {
  it("prints last count lines from all services without prefix when single service", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "boot\nready\nrequest 1\n");

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 200,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("boot");
    expect(text).toContain("ready");
    expect(text).toContain("request 1");
    expect(text).not.toContain("[api]");
  });

  it("prefixes every line with [name] when multiple services aggregated", async () => {
    const { appendLog } = await plantStack(["api", "web"]);
    appendLog("api", "api line 1\napi line 2\n");
    appendLog("web", "web line 1\nweb line 2\n");

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 200,
      all: false,
      json: false,
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

  it("respects --count N to limit output", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog(
      "api",
      ["a1", "a2", "a3", "a4", "a5"].map((l) => l + "\n").join(""),
    );

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 3,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("a3");
    expect(text).toContain("a4");
    expect(text).toContain("a5");
    expect(text).not.toContain("\na1\n");
    expect(text).not.toContain("\na2\n");
  });
});

describe("runLogs — source filter", () => {
  it("with a valid service name, streams only that service without prefix", async () => {
    const { appendLog } = await plantStack(["api", "web"]);
    appendLog("api", "api line\n");
    appendLog("web", "web line\n");

    const out = new StringWritable();
    const result = runLogs({
      sources: ["api"],
      follow: false,
      count: 200,
      all: false,
      json: false,
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

  it("with an unknown source, exits 1 and lists available sources", async () => {
    await plantStack(["api", "web"]);

    const out = new StringWritable();
    const result = runLogs({
      sources: ["nope"],
      follow: false,
      count: 200,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(1);
    const text = out.text();
    expect(text).toMatch(/unknown source "nope"/);
    expect(text).toContain("api");
    expect(text).toContain("web");
  });

  it("with a phase name, reads from the phase log file", async () => {
    const { appendPhaseLog } = await plantStack(["api"]);
    appendPhaseLog("before_up", "[08:00:00] $ before_up[0]: echo hello\nhello\n");

    const out = new StringWritable();
    const result = runLogs({
      sources: ["before_up"],
      follow: false,
      count: 200,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("before_up[0]");
    expect(text).toContain("hello");
  });

  it("multi-source with mix of service and phase shows both with prefix", async () => {
    const { appendLog, appendPhaseLog } = await plantStack(["api"]);
    appendLog("api", "api-line\n");
    appendPhaseLog("after_up", "hook-line\n");

    const out = new StringWritable();
    const result = runLogs({
      sources: ["api", "after_up"],
      follow: false,
      count: 200,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("[api] api-line");
    expect(text).toContain("[after_up] hook-line");
  });
});

describe("runLogs — cursor pagination", () => {
  it("--before cursor returns lines before the cursor (older)", async () => {
    const { appendLog } = await plantStack(["api"]);
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    appendLog("api", lines.map((l) => l + "\n").join(""));

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 3,
      before: 7,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("line-4");
    expect(text).toContain("line-5");
    expect(text).toContain("line-6");
    expect(text).not.toContain("line-7");
    expect(text).not.toContain("line-3");
  });

  it("--after cursor returns only lines after the cursor (newer)", async () => {
    const { appendLog } = await plantStack(["api"]);
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    appendLog("api", lines.map((l) => l + "\n").join(""));

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 100,
      after: 8,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("line-9");
    expect(text).toContain("line-10");
    expect(text).not.toContain("line-8\n");
    expect(text).not.toContain("\nline-7\n");
  });

  it("cursor line numbers are stable after appending new lines", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "a\nb\nc\n");

    const out1 = new StringWritable();
    const result1 = runLogs({
      follow: false,
      count: 100,
      all: false,
      json: true,
      cwd: wtRoot,
      out: out1,
    });
    await result1.done;

    const page1 = JSON.parse(out1.text()) as { lines: Array<{ n: number; text: string }>; cursor: { after: number } };
    const cursorAfter = page1.cursor.after;
    expect(page1.lines.map((l) => l.n)).toEqual([1, 2, 3]);

    // Append more lines AFTER reading the first page.
    appendLog("api", "d\ne\n");

    const out2 = new StringWritable();
    const result2 = runLogs({
      follow: false,
      count: 100,
      after: cursorAfter,
      all: false,
      json: true,
      cwd: wtRoot,
      out: out2,
    });
    await result2.done;

    const page2 = JSON.parse(out2.text()) as { lines: Array<{ n: number; text: string }> };
    // Lines 4 and 5 are new; their line numbers are stable.
    expect(page2.lines.map((l) => l.n)).toEqual([4, 5]);
    expect(page2.lines.map((l) => l.text)).toEqual(["d", "e"]);
  });
});

describe("runLogs — --grep filter", () => {
  it("filters lines matching the regex", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "GET /health 200\nPOST /login 401\nGET /data 200\n");

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 100,
      grep: "200",
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("GET /health 200");
    expect(text).toContain("GET /data 200");
    expect(text).not.toContain("POST /login 401");
  });

  it("--grep with invalid regex exits 1", async () => {
    await plantStack(["api"]);

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 100,
      grep: "[invalid",
      all: false,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(1);
    expect(out.text()).toContain("invalid --grep pattern");
  });
});

describe("runLogs — --all flag", () => {
  it("emits all lines without pagination footer", async () => {
    const { appendLog } = await plantStack(["api"]);
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    appendLog("api", lines.map((l) => l + "\n").join(""));

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 5,
      all: true,
      json: false,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const text = out.text();
    expect(text).toContain("line-1");
    expect(text).toContain("line-50");
    expect(text).not.toContain("Showing lines");
  });
});

describe("runLogs — --json output", () => {
  it("returns valid JSON with lines, cursor, and total_lines", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "line1\nline2\nline3\n");

    const out = new StringWritable();
    const result = runLogs({
      follow: false,
      count: 2,
      all: false,
      json: true,
      cwd: wtRoot,
      out,
    });
    await result.done;

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed).toHaveProperty("lines");
    expect(parsed).toHaveProperty("cursor");
    expect(parsed).toHaveProperty("total_lines", 3);
    expect(parsed.has_more_before).toBe(true);
    expect(parsed.has_more_after).toBe(false);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toHaveProperty("source", "api");
    expect(parsed.lines[0]).toHaveProperty("n");
    expect(parsed.lines[0]).toHaveProperty("text");
  });

  it("--after with --json includes new_since_after_cursor count", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "a\nb\nc\n");

    const out1 = new StringWritable();
    const r1 = runLogs({ follow: false, count: 100, all: false, json: true, cwd: wtRoot, out: out1 });
    await r1.done;
    const p1 = JSON.parse(out1.text()) as { cursor: { after: number } };

    appendLog("api", "d\ne\n");

    const out2 = new StringWritable();
    const r2 = runLogs({ follow: false, count: 100, after: p1.cursor.after, all: false, json: true, cwd: wtRoot, out: out2 });
    await r2.done;

    const p2 = JSON.parse(out2.text());
    expect(p2.new_since_after_cursor).toBe(2);
    expect(p2.lines).toHaveLength(2);
  });
});

describe("runLogs — --follow mode", () => {
  it("emits bytes appended after the initial dump and stops when aborted", async () => {
    const { appendLog } = await plantStack(["api"]);
    appendLog("api", "initial\n");

    const out = new StringWritable();
    const ac = new AbortController();
    const result = runLogs({
      sources: ["api"],
      follow: true,
      count: 50,
      all: false,
      json: false,
      cwd: wtRoot,
      out,
      signal: ac.signal,
    });

    setTimeout(() => appendLog("api", "appended-1\nappended-2\n"), 50);

    await new Promise<void>((r) => setTimeout(r, 400));
    ac.abort();

    await result.done;

    const text = out.text();
    expect(text).toContain("initial");
    expect(text).toContain("appended-1");
    expect(text).toContain("appended-2");
    expect(result.exitCode).toBe(0);
  });

  it("emits new bytes from multiple services in aggregate follow mode", async () => {
    const { appendLog } = await plantStack(["api", "web"]);

    const out = new StringWritable();
    const ac = new AbortController();
    const result = runLogs({
      follow: true,
      count: 50,
      all: false,
      json: false,
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
