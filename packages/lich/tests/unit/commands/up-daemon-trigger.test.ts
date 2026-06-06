import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// hoisted mock — vitest moves vi.mock above the SUT import
const ensureDaemonRunningSpy = vi.fn(async () => ({
  url: "http://127.0.0.1:54321",
  alreadyRunning: false,
}));
vi.mock("../../../src/daemon/auto-start.js", () => ({
  ensureDaemonRunning: (
    ...args: Parameters<typeof ensureDaemonRunningSpy>
  ) => ensureDaemonRunningSpy(...args),
}));

// imports MUST come after vi.mock for the substitution to take effect
// eslint-disable-next-line import/first
import { runUp } from "../../../src/commands/up.js";
// eslint-disable-next-line import/first
import { release } from "../../../src/ports/allocator.js";
// eslint-disable-next-line import/first
import { detectWorktree } from "../../../src/worktree/detect.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-daemon-trigger-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
  // mockClear (not mockReset) — keep the impl, drop call history
  ensureDaemonRunningSpy.mockClear();
  ensureDaemonRunningSpy.mockImplementation(async () => ({
    url: "http://127.0.0.1:54321",
    alreadyRunning: false,
  }));
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

function writeMinimalYaml(): void {
  writeYaml(`
version: "1"
runtime:
  port_range: [21100, 21120]
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
`);
}

function writeYamlWithProxyPort(port: number): void {
  writeYaml(`
version: "1"
runtime:
  port_range: [21130, 21150]
  proxy_port: ${port}
owned:
  svc:
    cmd: "echo READY; sleep 30"
    ready_when:
      log_match: "READY"
`);
}

function writeFailingYaml(): void {
  writeYaml(`
version: "1"
runtime:
  port_range: [21160, 21180]
owned:
  svc:
    cmd: "exit 1"
    ready_when:
      log_match: "NEVER"
      timeout: 500ms
`);
}

function captureOut(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("runUp — daemon trigger fired after status:up", () => {
  it("calls ensureDaemonRunning with openBrowser: false by default (no auto-open)", async () => {
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(ensureDaemonRunningSpy).toHaveBeenCalledTimes(1);
    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      openBrowser?: boolean;
      lichHome?: string;
    };
    expect(callArgs.openBrowser).toBe(false);
    expect(callArgs.lichHome).toBe(homeDir);
  });

  it("openBrowser: true → openBrowser: true in the hook call (explicit opt-in)", async () => {
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
      openBrowser: true,
    });

    expect(result.exitCode).toBe(0);
    expect(ensureDaemonRunningSpy).toHaveBeenCalledTimes(1);
    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      openBrowser?: boolean;
    };
    expect(callArgs.openBrowser).toBe(true);
  });

  it("LICH_NO_BROWSER=1 forces openBrowser: false even when openBrowser: true is passed", async () => {
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const prev = process.env.LICH_NO_BROWSER;
    process.env.LICH_NO_BROWSER = "1";
    try {
      const { stream } = captureOut();
      await runUp({
        cwd: projectDir,
        outputMode: "pretty",
        out: stream,
        openBrowser: true,
      });

      const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
        openBrowser?: boolean;
      };
      expect(callArgs.openBrowser).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.LICH_NO_BROWSER;
      } else {
        process.env.LICH_NO_BROWSER = prev;
      }
    }
  });
});

describe("runUp — daemon trigger skipped on failure paths", () => {
  it("does NOT call ensureDaemonRunning when the up fails before status:up", async () => {
    writeFailingYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).not.toBe(0);
    expect(ensureDaemonRunningSpy).not.toHaveBeenCalled();
  });
});

describe("runUp — daemon trigger failure is non-fatal", () => {
  it("ensureDaemonRunning throwing does NOT fail runUp (exit code stays 0)", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => {
      throw new Error("simulated: lich-daemon binary not found");
    });
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(ensureDaemonRunningSpy).toHaveBeenCalledTimes(1);
    const out = text();
    expect(out).toMatch(/daemon auto-start failed/);
    expect(out).toMatch(/simulated: lich-daemon binary not found/);
  });

  it("ensureDaemonRunning rejecting on timeout is also tolerated", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => {
      throw new Error(
        "timeout waiting for lich daemon URL file in /tmp/lich after 10000ms",
      );
    });
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(text()).toMatch(/daemon auto-start failed/);
  });
});

describe("runUp — Dashboard URL surfaced in output", () => {
  // displayed URL is the friendly apex http://lich.localhost:<proxy-port>/,
  // proxied to the ephemeral 127.0.0.1 URL returned by ensureDaemonRunning
  it("pretty output contains 'Dashboard: http://lich.localhost:<proxy-port>/' after a successful up", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:12345",
      alreadyRunning: false,
    }));
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const out = text();
    // no proxy port pinned → default 3300
    expect(out).toMatch(/Dashboard: http:\/\/lich\.localhost:3300\//);
    expect(out).not.toMatch(/127\.0\.0\.1:12345/);
    expect(out).not.toMatch(/daemon was already running/);
  });

  it("alreadyRunning: true adds the '(daemon was already running)' suffix", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:54321",
      alreadyRunning: true,
    }));
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const out = text();
    expect(out).toMatch(
      /Dashboard: http:\/\/lich\.localhost:3300\/ \(daemon was already running\)/,
    );
  });

  it("uses runtime.proxy_port in the friendly dashboard URL when pinned", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:12345",
      alreadyRunning: false,
    }));
    writeYamlWithProxyPort(34567);
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    expect(text()).toMatch(/Dashboard: http:\/\/lich\.localhost:34567\//);
  });

  it("json output emits an info event carrying the friendly dashboard URL", async () => {
    ensureDaemonRunningSpy.mockImplementation(async () => ({
      url: "http://127.0.0.1:8000",
      alreadyRunning: false,
    }));
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream, text } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const lines = text().split("\n").filter((l) => l.length > 0);
    const infoEvents = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string; message?: string };
        } catch {
          return { type: undefined } as { type?: string; message?: string };
        }
      })
      .filter((e) => e.type === "info");
    const dashboardInfo = infoEvents.find((e) =>
      typeof e.message === "string" && e.message.startsWith("Dashboard:"),
    );
    expect(dashboardInfo).toBeDefined();
    expect(dashboardInfo!.message).toBe(
      "Dashboard: http://lich.localhost:3300/",
    );
  });
});

describe("runUp — config.runtime.proxy_port forwarding", () => {
  it("forwards runtime.proxy_port as `proxyPort` to ensureDaemonRunning", async () => {
    writeYamlWithProxyPort(33001);
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    expect(result.exitCode).toBe(0);
    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      proxyPort?: number;
    };
    expect(callArgs.proxyPort).toBe(33001);
  });

  it("omits proxyPort when runtime.proxy_port is unset", async () => {
    // default-proxy-port resolution lives in the daemon hook — trigger
    // doesn't synthesize 3300 up front
    writeMinimalYaml();
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureOut();
    await runUp({
      cwd: projectDir,
      outputMode: "pretty",
      out: stream,
    });

    const callArgs = ensureDaemonRunningSpy.mock.calls[0][0] as {
      proxyPort?: number;
    };
    expect(callArgs.proxyPort).toBeUndefined();
  });
});
