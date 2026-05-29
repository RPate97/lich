import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogTail } from "../../../src/logs/tail.js";
import {
  FailWhenMatchedError,
  watchFailWhen,
} from "../../../src/failure/fail-when.js";

// trackers for afterEach cleanup — leaked poll intervals hang the test process on exit
let tmpDirs: string[] = [];
let tails: LogTail[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-fail-when-"));
  tmpDirs.push(dir);
  return dir;
}

async function makeStartedTail(logPath: string): Promise<LogTail> {
  const tail = new LogTail({ logPath, intervalMs: 10 });
  tails.push(tail);
  await tail.start();
  return tail;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(async () => {
  for (const tail of tails) {
    try {
      await tail.stop();
    } catch {
      // ignore
    }
  }
  tails = [];

  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

describe("watchFailWhen", () => {
  it("rejects with FailWhenMatchedError on first matching line", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\nlistening on 8080\n");

    const tail = await makeStartedTail(logPath);
    // one tick to read seed into buffer — isolates the forward path from retroactive
    await sleep(30);

    const waiter = watchFailWhen({
      tail,
      pattern: /EADDRINUSE/,
    });

    setTimeout(() => {
      appendFileSync(logPath, "EADDRINUSE port 8080 already in use\n");
    }, 30);

    await expect(waiter).rejects.toThrow(FailWhenMatchedError);
    try {
      await waiter;
    } catch (err) {
      expect(err).toBeInstanceOf(FailWhenMatchedError);
      expect((err as FailWhenMatchedError).matchedLine).toBe(
        "EADDRINUSE port 8080 already in use",
      );
    }
  });

  it("never resolves on its own (stays pending until match, signal, or stop)", async () => {
    // fail_when is a SENTINEL, not a state — stale resolution would mislead the orchestrator
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(
      logPath,
      "starting\nhealthy\nstill healthy\nnothing matching here\n",
    );

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /WILL-NEVER-APPEAR/,
      signal: controller.signal,
    });

    const sentinel = sleep(200).then(() => "sentinel-won" as const);

    const winner = await Promise.race([
      waiter.then(() => "watcher-resolved" as const).catch(
        () => "watcher-rejected" as const,
      ),
      sentinel,
    ]);

    expect(winner).toBe("sentinel-won");

    controller.abort();
    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("can race against a Promise.resolve and lose", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /WONT-MATCH/,
      signal: controller.signal,
    });

    const winner = await Promise.race([
      Promise.resolve("ready"),
      waiter,
    ]);

    expect(winner).toBe("ready");

    // caller-cleanup: orchestrator MUST abort the loser to avoid late unhandled rejection
    controller.abort();
    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("races against another rejection and wins if it matches first", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /FATAL/,
      signal: controller.signal,
    });

    setTimeout(() => {
      appendFileSync(logPath, "FATAL boom\n");
    }, 20);

    const slowReject = sleep(300).then(() => {
      throw new Error("slow-peer");
    });

    await expect(Promise.race([waiter, slowReject])).rejects.toThrow(
      FailWhenMatchedError,
    );

    // suppress slow rejection so it doesn't surface as unhandled
    slowReject.catch(() => {});

    controller.abort();
  });

  it("cleans up the subscription when signal aborts", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /MATCH/,
      signal: controller.signal,
    });

    const rejections: unknown[] = [];
    waiter.catch((err) => rejections.push(err));

    controller.abort();
    await sleep(20);

    for (let i = 0; i < 50; i++) {
      appendFileSync(logPath, `MATCH line ${i}\n`);
    }
    await sleep(100);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toBeInstanceOf(Error);
    expect((rejections[0] as Error).message).toMatch(/abort/i);
  });

  it("matches a line already in the LogTail buffer before subscription", async () => {
    // retroactive sweep: catches matches that arrived before subscription
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\nEADDRINUSE port 5432\nmore noise\n");

    const tail = await makeStartedTail(logPath);
    await sleep(40);

    expect(tail.buffer).toContain("EADDRINUSE");

    const waiter = watchFailWhen({
      tail,
      pattern: /EADDRINUSE/,
    });

    await expect(waiter).rejects.toThrow(FailWhenMatchedError);
    try {
      await waiter;
    } catch (err) {
      expect((err as FailWhenMatchedError).matchedLine).toBe(
        "EADDRINUSE port 5432",
      );
    }
  });

  it("rejects immediately when signal is already aborted at call time", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "EADDRINUSE here\n");
    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    controller.abort();

    const waiter = watchFailWhen({
      tail,
      pattern: /EADDRINUSE/,
      signal: controller.signal,
    });

    await expect(waiter).rejects.toThrow(/abort/i);
    // abort beats buffer sweep — rejection is abort error, not FailWhenMatchedError
    try {
      await waiter;
    } catch (err) {
      expect(err).not.toBeInstanceOf(FailWhenMatchedError);
    }
  });

  it("rejects only once even when multiple matching lines arrive in the same tick", async () => {
    // settled guard: cleanup runs before the next callback in a burst
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const waiter = watchFailWhen({
      tail,
      pattern: /BOOM/,
    });

    const rejections: FailWhenMatchedError[] = [];
    waiter.catch((err) => rejections.push(err as FailWhenMatchedError));

    appendFileSync(
      logPath,
      "BOOM 1\nBOOM 2\nBOOM 3\nBOOM 4\nBOOM 5\n",
    );

    await sleep(80);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.matchedLine).toBe("BOOM 1");
  });
});

describe("FailWhenMatchedError", () => {
  it("carries the matched line as a public field", () => {
    const err = new FailWhenMatchedError("EADDRINUSE port 8080");
    expect(err.matchedLine).toBe("EADDRINUSE port 8080");
    expect(err.message).toContain("EADDRINUSE port 8080");
  });

  it("has a stable .name for cross-realm discrimination", () => {
    // formatter discriminates on err.name so cross-realm errors (instanceof fails) still work
    const err = new FailWhenMatchedError("anything");
    expect(err.name).toBe("FailWhenMatchedError");
  });

  it("is an instance of Error so generic catch handlers work", () => {
    const err = new FailWhenMatchedError("anything");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FailWhenMatchedError);
  });
});
