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
  // terminate detectWorktree's upward walk at wtRoot
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
  };
}

describe("runLogs — no stack present", () => {
  it("exits 1 and prints 'no stack found for this worktree' when state.json is missing", async () => {
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
    rmSync(join(wtRoot, "lich.yaml"));
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
    // single-service aggregate mode → no prefix (spec: "Suppress prefix
    // when only one service is being tailed.")
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
    expect(text).toContain("[api] a3");
    expect(text).toContain("[api] a4");
    expect(text).toContain("[api] a5");
    expect(text).toContain("[web] w3");
    expect(text).toContain("[web] w4");
    expect(text).toContain("[web] w5");
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

    setTimeout(() => appendLog("api", "appended-1\nappended-2\n"), 50);

    await new Promise<void>((r) => setTimeout(r, 400));
    ac.abort();

    await result.done;

    const text = out.text();
    expect(text).toContain("initial");
    expect(text).toContain("appended-1");
    expect(text).toContain("appended-2");
    // follow mode "exits" normally on Ctrl-C
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
