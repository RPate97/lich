import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  waitForDaemonRunning,
  waitForDaemonStopped,
  readDaemonUrl,
} from "./daemon.js";

let lichHome: string;

beforeEach(() => {
  lichHome = mkdtempSync(join(tmpdir(), "lich-daemon-helper-test-"));
});

afterEach(() => {
  rmSync(lichHome, { recursive: true, force: true });
});

/**
 * A PID guaranteed not to map to a live process. Linux's default
 * pid_max is ~4M but in practice we never see live PIDs near 999999
 * on test machines. If this ever becomes flaky, swap to a fork-and-
 * immediately-wait pattern that returns a known-dead PID.
 */
const DEAD_PID = 999999;

function writePid(home: string, pid: number): void {
  writeFileSync(join(home, "daemon.pid"), `${pid}\n`, "utf8");
}

function writeUrl(home: string, url: string): void {
  writeFileSync(join(home, "daemon.url"), url, "utf8");
}

describe("waitForDaemonRunning", () => {
  it("resolves with pid + url when both files are written before timeout", async () => {
    // Write files asynchronously after a short delay so we exercise the
    // poll loop (not the first iteration).
    setTimeout(() => {
      writePid(lichHome, process.pid);
      writeUrl(lichHome, "http://127.0.0.1:54321");
    }, 50);

    const info = await waitForDaemonRunning(lichHome, { timeoutMs: 1000 });
    expect(info.pid).toBe(process.pid);
    expect(info.url).toBe("http://127.0.0.1:54321");
  });

  it("rejects on timeout when files are never written", async () => {
    await expect(
      waitForDaemonRunning(lichHome, { timeoutMs: 300 }),
    ).rejects.toThrow(/timeout/i);
  });

  it("rejects on timeout when PID file exists but PID is dead", async () => {
    writePid(lichHome, DEAD_PID);
    writeUrl(lichHome, "http://127.0.0.1:54321");

    await expect(
      waitForDaemonRunning(lichHome, { timeoutMs: 300 }),
    ).rejects.toThrow(/timeout/i);
  });

  it("rejects on timeout when only PID is written (URL missing)", async () => {
    writePid(lichHome, process.pid);

    await expect(
      waitForDaemonRunning(lichHome, { timeoutMs: 300 }),
    ).rejects.toThrow(/timeout/i);
  });

  it("rejects on timeout when only URL is written (PID missing)", async () => {
    writeUrl(lichHome, "http://127.0.0.1:54321");

    await expect(
      waitForDaemonRunning(lichHome, { timeoutMs: 300 }),
    ).rejects.toThrow(/timeout/i);
  });
});

describe("waitForDaemonStopped", () => {
  it("resolves when PID file is removed", async () => {
    writePid(lichHome, process.pid);

    setTimeout(() => {
      unlinkSync(join(lichHome, "daemon.pid"));
    }, 50);

    await expect(
      waitForDaemonStopped(lichHome, { timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("resolves immediately when PID file never existed", async () => {
    await expect(
      waitForDaemonStopped(lichHome, { timeoutMs: 500 }),
    ).resolves.toBeUndefined();
  });

  it("resolves when PID file exists but PID is dead", async () => {
    writePid(lichHome, DEAD_PID);

    await expect(
      waitForDaemonStopped(lichHome, { timeoutMs: 500 }),
    ).resolves.toBeUndefined();
  });

  it("rejects on timeout when PID file persists with a live PID", async () => {
    writePid(lichHome, process.pid);

    await expect(
      waitForDaemonStopped(lichHome, { timeoutMs: 300 }),
    ).rejects.toThrow(/timeout/i);
  });
});

describe("readDaemonUrl", () => {
  it("returns the URL when daemon.url exists", () => {
    writeUrl(lichHome, "http://127.0.0.1:12345");
    expect(readDaemonUrl(lichHome)).toBe("http://127.0.0.1:12345");
  });

  it("returns null when daemon.url is absent", () => {
    expect(readDaemonUrl(lichHome)).toBeNull();
  });

  it("returns null when daemon.url is empty/whitespace-only", () => {
    writeUrl(lichHome, "   \n");
    expect(readDaemonUrl(lichHome)).toBeNull();
  });

  it("strips trailing whitespace", () => {
    writeUrl(lichHome, "http://127.0.0.1:12345\n");
    expect(readDaemonUrl(lichHome)).toBe("http://127.0.0.1:12345");
  });
});
