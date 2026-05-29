import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureStackDir,
  serviceLogPath,
} from "../../../src/state/directory.js";
import { startOwnedService } from "../../../src/owned/supervisor.js";
import { LogTail } from "../../../src/logs/tail.js";

const STACK_ID = "test-stack";

let homeDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "lich-tail-integration-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  await ensureStackDir(STACK_ID);
});

afterEach(async () => {
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  await rm(homeDir, { recursive: true, force: true });
});

describe("LogTail × supervisor integration", () => {
  it("reads lines from a real supervisor-spawned service's log", async () => {
    const name = "tick-svc";
    const logPath = serviceLogPath(STACK_ID, name);

    // construct + start BEFORE supervisor spawn — mirrors up.ts ordering
    const tail = new LogTail({ logPath, intervalMs: 10 });

    const received: string[] = [];
    const fifthTickDeferred = makeDeferred<void>();
    tail.onLine((line) => {
      if (/^tick \d+$/.test(line)) {
        received.push(line);
        if (received.length === 5) fifthTickDeferred.resolve();
      }
    });
    await tail.start();

    const handle = await startOwnedService({
      name,
      cmd: 'for i in 1 2 3 4 5; do echo "tick $i"; sleep 0.05; done',
      cwd: homeDir,
      env: {},
      logPath,
    });

    try {
      await withTimeout(
        fifthTickDeferred.promise,
        2000,
        "fifth tick never arrived within 2s",
      );

      expect(received).toEqual([
        "tick 1",
        "tick 2",
        "tick 3",
        "tick 4",
        "tick 5",
      ]);

      const result = await handle.exited;
      expect(result.code).toBe(0);
    } finally {
      await tail.stop();
    }
  });

  it("closes cleanly when the supervised service is stopped mid-stream", async () => {
    const name = "long-lived-svc";
    const logPath = serviceLogPath(STACK_ID, name);

    const tail = new LogTail({ logPath, intervalMs: 10 });

    let firstLineSeen = false;
    const firstLine = makeDeferred<void>();
    tail.onLine((line) => {
      if (line === "ready") {
        firstLineSeen = true;
        firstLine.resolve();
      }
    });
    await tail.start();

    const handle = await startOwnedService({
      name,
      cmd: 'echo ready; while true; do echo "still-alive"; sleep 1; done',
      cwd: homeDir,
      env: {},
      logPath,
    });

    try {
      await withTimeout(
        firstLine.promise,
        2000,
        "service never emitted 'ready' within 2s",
      );
      expect(firstLineSeen).toBe(true);

      await handle.stop();

      await expect(tail.stop()).resolves.toBeUndefined();
      await expect(tail.stop()).resolves.toBeUndefined();
    } finally {
      await handle.stop().catch(() => {});
      await tail.stop().catch(() => {});
    }
  });
});

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
