import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForLogMatch } from "../../../src/ready/log-match.js";

// Track tmpdirs per test so afterEach can tear them all down.
let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-log-match-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

describe("waitForLogMatch", () => {
  it("resolves quickly when the log file already contains a matching line", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting...\nready: listening on 5432\nmore\n");

    const start = Date.now();
    await waitForLogMatch({
      logPath,
      pattern: /listening on \d+/,
      intervalMs: 25,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it("resolves once a matching line is appended after the wait begins", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    // File exists but no match yet.
    writeFileSync(logPath, "booting...\n");

    const waiter = waitForLogMatch({
      logPath,
      pattern: /server ready/,
      intervalMs: 25,
    });

    setTimeout(() => {
      appendFileSync(logPath, "still booting\nserver ready now\n");
    }, 75);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
  });

  it("waits for the log file to appear and resolves once it contains a match", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "not-yet.log");

    const waiter = waitForLogMatch({
      logPath,
      pattern: /hello/,
      intervalMs: 25,
    });

    setTimeout(() => {
      writeFileSync(logPath, "hello world\n");
    }, 75);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
  });

  it("never resolves when the log never contains a match; abort terminates", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "nothing interesting\nstill nothing\n");

    const controller = new AbortController();
    const waiter = waitForLogMatch({
      logPath,
      pattern: /will-never-appear/,
      intervalMs: 25,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 80);

    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("resolves on the specific matching line in a multi-line file (mid-file match)", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const waiter = waitForLogMatch({
      logPath,
      pattern: /TARGET/,
      intervalMs: 25,
    });

    setTimeout(() => {
      appendFileSync(
        logPath,
        "line 1\nline 2\nthis is the TARGET line\nline 4\n"
      );
    }, 50);

    await waiter;
  });

  it("does not match against a partial last line; only resolves once the line completes", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const waiter = waitForLogMatch({
      logPath,
      pattern: /^FULL-LINE$/,
      intervalMs: 25,
    });

    // First write a partial fragment that LOOKS like it could match but
    // has no terminating newline. Then later finish the line. The
    // matcher must NOT resolve on the partial — only on the completed
    // line.
    setTimeout(() => {
      // "FULL-LIN" — no newline; partial only.
      appendFileSync(logPath, "FULL-LIN");
    }, 40);

    // The partial sits there for a while. If the implementation
    // incorrectly tests partials, this would falsely resolve in the
    // window before the completing write.
    setTimeout(() => {
      // Complete the line so that ^FULL-LINE$ matches.
      appendFileSync(logPath, "E\n");
    }, 150);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    // Must have waited until after the completion write at t=150ms.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(500);
  });

  it("resolves on the FIRST matching line when multiple matches exist", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(
      logPath,
      "noise\nMATCH first\nMATCH second\nMATCH third\n"
    );

    // We don't have a hook to introspect which line matched, but we can
    // assert resolution itself and that it completes quickly (i.e. the
    // function returns after the first match without scanning the
    // remainder forever).
    const start = Date.now();
    await waitForLogMatch({
      logPath,
      pattern: /MATCH/,
      intervalMs: 25,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it("rejects with aborted when the signal fires during polling", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "noise only\n");

    const controller = new AbortController();
    const waiter = waitForLogMatch({
      logPath,
      pattern: /never/,
      intervalMs: 25,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("rejects with aborted when the signal is already aborted before the call", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "anything\n");

    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForLogMatch({
        logPath,
        pattern: /anything/,
        intervalMs: 25,
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);
  });
});
