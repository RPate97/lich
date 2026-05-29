import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  withFileLock,
  LockTimeoutError,
  isPidAlive,
} from "../../../src/ports/file-lock.js";

let workDir: string;
let lockPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "lich-file-lock-"));
  lockPath = join(workDir, "test.lock");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a definitely-dead PID", () => {
    // PID 999999 is virtually never assigned on a developer machine;
    // platform max defaults to 32768 or low six figures.
    expect(isPidAlive(999_999)).toBe(false);
  });
});

describe("withFileLock", () => {
  it("returns the value produced by the critical section", async () => {
    const result = await withFileLock(lockPath, async () => 42);
    expect(result).toBe(42);
  });

  it("releases the lock on success (file is unlinked)", async () => {
    await withFileLock(lockPath, async () => {
      expect(existsSync(lockPath)).toBe(true);
      return "ok";
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("serializes concurrent invocations — counter file ends at expected value", async () => {
    const counterPath = join(workDir, "counter.txt");
    await writeFile(counterPath, "0", "utf8");

    const increment = async () => {
      await withFileLock(lockPath, async () => {
        const current = Number((await readFile(counterPath, "utf8")).trim());
        // Yield to the event loop so a non-serialized implementation
        // would race here and lose an increment.
        await new Promise((r) => setTimeout(r, 20));
        await writeFile(counterPath, String(current + 1), "utf8");
      });
    };

    await Promise.all([increment(), increment()]);

    const final = Number((await readFile(counterPath, "utf8")).trim());
    expect(final).toBe(2);
  });

  it("serializes many concurrent invocations correctly", async () => {
    const counterPath = join(workDir, "counter.txt");
    await writeFile(counterPath, "0", "utf8");

    const N = 10;
    const ops = Array.from({ length: N }, () =>
      withFileLock(lockPath, async () => {
        const current = Number((await readFile(counterPath, "utf8")).trim());
        await new Promise((r) => setTimeout(r, 5));
        await writeFile(counterPath, String(current + 1), "utf8");
      }),
    );
    await Promise.all(ops);

    const final = Number((await readFile(counterPath, "utf8")).trim());
    expect(final).toBe(N);
  });

  it("reclaims a stale lock left by a dead PID", async () => {
    // Pre-create the lockfile referencing a definitely-dead PID.
    await mkdir(workDir, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, acquiredAtMs: Date.now() }),
      "utf8",
    );
    expect(existsSync(lockPath)).toBe(true);

    const result = await withFileLock(
      lockPath,
      async () => "reclaimed",
      { timeoutMs: 2_000 },
    );
    expect(result).toBe("reclaimed");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a lockfile written in the old plain-PID format", async () => {
    await mkdir(workDir, { recursive: true });
    await writeFile(lockPath, "999999", "utf8");
    const result = await withFileLock(
      lockPath,
      async () => "ok",
      { timeoutMs: 2_000 },
    );
    expect(result).toBe("ok");
  });

  it("does NOT instantly reclaim an empty lockfile (settle window required)", async () => {
    // Regression for the race that motivated the link(2) acquisition
    // strategy: prior implementation observed an empty lockfile and
    // immediately unlinked it, which let a concurrent winner of the
    // EEXIST race steal a lock that was about to receive its metadata.
    // The reclaim path for empty/unreadable lockfiles must now require
    // observing emptiness twice across a settle window — so a waiter
    // that briefly sees an empty file (e.g. from another tool mid-write)
    // does not steal it.
    await mkdir(workDir, { recursive: true });
    await writeFile(lockPath, "", "utf8");

    // While the waiter is in its 100ms settle window, "fix" the lockfile
    // by writing live-PID metadata. The waiter must observe the second
    // read, see live content, and refuse to reclaim — then time out
    // because the (live, current-process-owned) lock is unreclaimable.
    setTimeout(() => {
      writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }),
        "utf8",
      ).catch(() => {});
    }, 30);

    await expect(
      withFileLock(lockPath, async () => "should not run", {
        timeoutMs: 400,
        pollMs: 20,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    // Cleanup so afterEach can rm the workDir without worrying about
    // whatever state we left.
  });

  it("times out when the lock is held by an alive PID", async () => {
    // Hold the lock for longer than the timeout in a separate call.
    let release!: () => void;
    const holding = new Promise<void>((res) => {
      release = res;
    });

    const holder = withFileLock(lockPath, async () => {
      await holding;
    });

    // Give the holder a moment to actually acquire the lock.
    await new Promise((r) => setTimeout(r, 50));

    await expect(
      withFileLock(lockPath, async () => "should not run", {
        timeoutMs: 200,
        pollMs: 20,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    release();
    await holder;
  });
});
