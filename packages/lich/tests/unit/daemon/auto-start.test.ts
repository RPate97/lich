import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { ensureDaemonRunning } from "../../../src/daemon/auto-start.js";
import {
  writeDaemonPid,
  writeDaemonUrl,
} from "../../../src/daemon/pid-file.js";

let home: string;
let binDir: string;
let fakeDaemonPath: string;
let prevDaemonBin: string | undefined;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-auto-start-home-"));
  binDir = mkdtempSync(join(tmpdir(), "lich-auto-start-bin-"));
  fakeDaemonPath = join(binDir, "lich-daemon");
  prevDaemonBin = process.env.LICH_DAEMON_BIN;
  prevLichHome = process.env.LICH_HOME;
  delete process.env.LICH_HOME;
});

afterEach(() => {
  if (prevDaemonBin === undefined) {
    delete process.env.LICH_DAEMON_BIN;
  } else {
    process.env.LICH_DAEMON_BIN = prevDaemonBin;
  }
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

function captureOut(): {
  stream: PassThrough;
  text: () => string;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function writeFakeDaemon(opts: {
  urlContents?: string;
  delayMs?: number;
  omitUrl?: boolean;
}): void {
  const urlContents = opts.urlContents ?? "http://127.0.0.1:12345";
  const delayMs = opts.delayMs ?? 50;
  const omitUrl = opts.omitUrl ?? false;

  const script = [
    "#!/bin/sh",
    'echo "$$" > "$LICH_HOME/daemon.pid"',
    `sleep ${(delayMs / 1000).toFixed(3)}`,
    omitUrl
      ? '# url omitted by test'
      : `printf '%s\\n' '${urlContents}' > "$LICH_HOME/daemon.url"`,
    "sleep 60",
  ].join("\n");

  writeFileSync(fakeDaemonPath, script + "\n", "utf8");
  chmodSync(fakeDaemonPath, 0o755);
  process.env.LICH_DAEMON_BIN = fakeDaemonPath;
}

function killFakeDaemon(): void {
  const pidPath = join(home, "daemon.pid");
  if (!existsSync(pidPath)) return;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  } catch {
    /* file gone or unreadable */
  }
}

describe("ensureDaemonRunning — already-running short-circuit", () => {
  it("returns alreadyRunning: true when daemon PID is alive and URL is present", async () => {
    await writeDaemonPid(process.pid, { lichHome: home });
    await writeDaemonUrl("http://127.0.0.1:7777", { lichHome: home });

    // LICH_DAEMON_BIN deliberately unset — a spawn attempt would throw
    const result = await ensureDaemonRunning({ lichHome: home });

    expect(result).toEqual({
      url: "http://127.0.0.1:7777",
      alreadyRunning: true,
    });
  });

  it("does not invoke openBrowser when daemon already running", async () => {
    await writeDaemonPid(process.pid, { lichHome: home });
    await writeDaemonUrl("http://127.0.0.1:8888", { lichHome: home });
    const { stream, text } = captureOut();

    const result = await ensureDaemonRunning({
      lichHome: home,
      openBrowser: true,
      out: stream,
    });

    expect(result.alreadyRunning).toBe(true);
    expect(text()).toBe("");
  });
});

describe("ensureDaemonRunning — spawn path", () => {
  it("spawns the daemon binary, waits for URL file, returns alreadyRunning: false", async () => {
    writeFakeDaemon({ urlContents: "http://127.0.0.1:9999", delayMs: 80 });

    try {
      const result = await ensureDaemonRunning({
        lichHome: home,
        timeoutMs: 5_000,
      });

      expect(result.url).toBe("http://127.0.0.1:9999");
      expect(result.alreadyRunning).toBe(false);
      expect(existsSync(join(home, "daemon.url"))).toBe(true);
      expect(existsSync(join(home, "daemon.pid"))).toBe(true);
    } finally {
      killFakeDaemon();
    }
  });

  it("returns the exact URL the spawned daemon wrote (no normalization)", async () => {
    const arbitrary = "https://localhost:65432/some/path";
    writeFakeDaemon({ urlContents: arbitrary, delayMs: 30 });

    try {
      const result = await ensureDaemonRunning({
        lichHome: home,
        timeoutMs: 5_000,
      });
      expect(result.url).toBe(arbitrary);
    } finally {
      killFakeDaemon();
    }
  });
});

describe("ensureDaemonRunning — URL file timeout", () => {
  it("throws after timeoutMs when the URL file never appears", async () => {
    writeFakeDaemon({ omitUrl: true, delayMs: 0 });

    try {
      await expect(
        ensureDaemonRunning({
          lichHome: home,
          timeoutMs: 200,
          pollIntervalMs: 25,
        }),
      ).rejects.toThrow(/timeout waiting for lich daemon URL file/);
    } finally {
      killFakeDaemon();
    }
  });

  it("includes the elapsed time and home path in the timeout error", async () => {
    writeFakeDaemon({ omitUrl: true, delayMs: 0 });

    try {
      await expect(
        ensureDaemonRunning({
          lichHome: home,
          timeoutMs: 150,
          pollIntervalMs: 25,
        }),
      ).rejects.toThrow(new RegExp(`${home}.*after 150ms`));
    } finally {
      killFakeDaemon();
    }
  });
});

describe("ensureDaemonRunning — binary not found", () => {
  it("throws when LICH_DAEMON_BIN points at a missing path", async () => {
    process.env.LICH_DAEMON_BIN = join(binDir, "does-not-exist");
    await expect(
      ensureDaemonRunning({ lichHome: home, timeoutMs: 500 }),
    ).rejects.toThrow(/lich-daemon binary not found at .*does-not-exist/);
  });

  it("throws with both expected paths in the message when no env var", async () => {
    delete process.env.LICH_DAEMON_BIN;
    await expect(
      ensureDaemonRunning({ lichHome: home, timeoutMs: 500 }),
    ).rejects.toThrow(/lich-daemon binary not found at .*\/lich-daemon/);
  });
});

describe("ensureDaemonRunning — openBrowser is best-effort", () => {
  it("does NOT throw when the browser-open call fails", async () => {
    // malformed URL: `open` exits non-zero but doesn't propagate up due to unref
    writeFakeDaemon({
      urlContents: "definitely-not-a-real-url://blah",
      delayMs: 20,
    });
    const { stream } = captureOut();

    try {
      const result = await ensureDaemonRunning({
        lichHome: home,
        openBrowser: true,
        out: stream,
        timeoutMs: 5_000,
      });
      expect(result.alreadyRunning).toBe(false);
    } finally {
      killFakeDaemon();
    }
  });
});

describe("ensureDaemonRunning — env var forwarding", () => {
  it("forwards LICH_HOME to the spawned daemon", async () => {
    writeFakeDaemon({ urlContents: "http://127.0.0.1:5555", delayMs: 30 });

    try {
      const result = await ensureDaemonRunning({
        lichHome: home,
        timeoutMs: 5_000,
      });
      expect(result.alreadyRunning).toBe(false);
      expect(existsSync(join(home, "daemon.pid"))).toBe(true);
      expect(existsSync(join(home, "daemon.url"))).toBe(true);
    } finally {
      killFakeDaemon();
    }
  });

  it("forwards LICH_PROXY_PORT as a string to the spawned daemon", async () => {
    const portFile = join(home, "proxy-port.txt");
    const script = [
      "#!/bin/sh",
      'echo "$$" > "$LICH_HOME/daemon.pid"',
      `printf '%s' "$LICH_PROXY_PORT" > '${portFile}'`,
      `printf '%s\\n' 'http://127.0.0.1:4321' > "$LICH_HOME/daemon.url"`,
      "sleep 60",
    ].join("\n");
    writeFileSync(fakeDaemonPath, script + "\n", "utf8");
    chmodSync(fakeDaemonPath, 0o755);
    process.env.LICH_DAEMON_BIN = fakeDaemonPath;

    try {
      const result = await ensureDaemonRunning({
        lichHome: home,
        proxyPort: 3300,
        timeoutMs: 5_000,
      });
      expect(result.url).toBe("http://127.0.0.1:4321");
      expect(readFileSync(portFile, "utf8")).toBe("3300");
    } finally {
      killFakeDaemon();
    }
  });

  it("does NOT forward LICH_PROXY_PORT when proxyPort is unset", async () => {
    delete process.env.LICH_PROXY_PORT;
    const portFile = join(home, "proxy-port.txt");
    const script = [
      "#!/bin/sh",
      'echo "$$" > "$LICH_HOME/daemon.pid"',
      `printf '%s' "$LICH_PROXY_PORT" > '${portFile}'`,
      `printf '%s\\n' 'http://127.0.0.1:4321' > "$LICH_HOME/daemon.url"`,
      "sleep 60",
    ].join("\n");
    writeFileSync(fakeDaemonPath, script + "\n", "utf8");
    chmodSync(fakeDaemonPath, 0o755);
    process.env.LICH_DAEMON_BIN = fakeDaemonPath;

    try {
      await ensureDaemonRunning({ lichHome: home, timeoutMs: 5_000 });
      expect(readFileSync(portFile, "utf8")).toBe("");
    } finally {
      killFakeDaemon();
    }
  });
});

describe("ensureDaemonRunning — alive PID, URL pending", () => {
  it("polls for URL when PID is alive but URL not yet written", async () => {
    // alive PID + missing URL: another `lich up` is spawning the daemon —
    // we MUST wait, not spawn a second
    await writeDaemonPid(process.pid, { lichHome: home });

    // no LICH_DAEMON_BIN — a spawn attempt would throw
    const promise = ensureDaemonRunning({
      lichHome: home,
      timeoutMs: 2_000,
      pollIntervalMs: 25,
    });

    setTimeout(() => {
      void writeDaemonUrl("http://127.0.0.1:6789", { lichHome: home });
    }, 75);

    const result = await promise;
    expect(result).toEqual({
      url: "http://127.0.0.1:6789",
      alreadyRunning: true,
    });
  });
});
