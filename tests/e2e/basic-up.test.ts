import { describe, it, expect, afterEach } from "vitest";
import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich, spawnLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";
import type { ChildProcess } from "node:child_process";

let cleanup: (() => void) | null = null;
let lichProc: ChildProcess | null = null;

afterEach(async () => {
  if (lichProc) {
    lichProc.kill("SIGINT");
    await new Promise<void>((r) => setTimeout(r, 1000));
    lichProc = null;
  }
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

describe("lich up against dogfood-stack (THE failing test case)", () => {
  it("brings the stack up and serves the web app", async () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    cleanup = cleanupFn;

    // Validate first
    const validateResult = runLich(["validate"], { cwd: path });
    expect(validateResult.exitCode).toBe(0);

    // Bring it up in the background
    lichProc = spawnLich(["up"], { cwd: path });

    // Wait for web service to respond (lich should print the URL)
    // The friendly URL pattern is http://<service>.<worktree>.lich.localhost:3300/
    // Until proxy is implemented, this test will fail. That's expected.
    await waitForHttp200("http://web.dogfood-stack.lich.localhost:3300/", {
      timeoutMs: 120_000,
    });
  });

  it("lich validate succeeds against the target yaml", () => {
    const { path, cleanup: cleanupFn } = copyExampleToTmpdir("dogfood-stack");
    cleanup = cleanupFn;

    const result = runLich(["validate"], { cwd: path });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
