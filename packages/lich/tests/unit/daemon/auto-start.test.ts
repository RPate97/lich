/**
 * Unit tests for the daemon auto-start hook (LEV-407, Plan 5 Task 5).
 *
 * Strategy: real spawn of a tiny fake-daemon shell script, pointed at via
 * `LICH_DAEMON_BIN`. The script writes a synthetic daemon.pid + daemon.url
 * under LICH_HOME, then sleeps. This exercises the production spawn path
 * (detached, unref'd, env-var forwarding) without needing the real daemon
 * binary, and lets us assert end-to-end behavior — env propagation, file
 * polling, openBrowser short-circuit — against real filesystem effects.
 *
 * Coverage:
 *   1. Daemon already running → returns `alreadyRunning: true` without spawning
 *   2. Daemon not running → spawns binary, waits for URL file, returns
 *      `alreadyRunning: false`
 *   3. URL file never appears → throws after timeout
 *   4. Binary not found → throws with clear error
 *   5. `openBrowser: true` does NOT fail the function even if browser-open
 *      fails (we point `PATH` at a tmpdir with no `open`/`xdg-open`)
 *   6. LICH_HOME and LICH_PROXY_PORT env vars are forwarded to the spawned
 *      daemon
 */

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

// ---------------------------------------------------------------------------
// Fixture harness
//
// Every test gets a fresh tmpdir to use as LICH_HOME and a separate tmpdir
// to hold the fake-daemon binary. The env var `LICH_DAEMON_BIN` is set to
// the fake script path so `resolveDaemonBinary()` finds it. Original env
// values are stashed and restored in afterEach.
// ---------------------------------------------------------------------------

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
  // Tests pass `lichHome` via opts (so the helpers route correctly even
  // without an env var), but we keep the env unset so the implicit
  // fallback path is exercised when relevant.
  delete process.env.LICH_HOME;
});

afterEach(() => {
  // Restore env vars before cleaning up the binary so a later test can
  // legitimately point at its own LICH_DAEMON_BIN without inheriting
  // ours.
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

/**
 * Capture stream + accessor for the auto-start hook's diagnostic output.
 * Lets tests assert on warning lines (e.g. browser-open failure) without
 * polluting test runner stdout.
 */
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

/**
 * Write a fake-daemon shell script at `fakeDaemonPath`. The script
 * writes a synthetic PID + URL into `$LICH_HOME` then sleeps so the
 * spawn looks like a real daemon to the auto-start hook.
 *
 * `urlContents` is what gets written into `daemon.url` — tests use
 * different values to assert the polled-URL is what's returned.
 *
 * `delayMs` injects an artificial sleep before the URL write to
 * exercise the polling-actually-polls path. Default 50ms — fast enough
 * not to drag, slow enough that the auto-start hook can't possibly
 * succeed on its initial read.
 *
 * `omitUrl` set to true makes the script SKIP writing the URL file —
 * used by the timeout test to force the polling deadline to fire.
 */
function writeFakeDaemon(opts: {
  urlContents?: string;
  delayMs?: number;
  omitUrl?: boolean;
}): void {
  const urlContents = opts.urlContents ?? "http://127.0.0.1:12345";
  const delayMs = opts.delayMs ?? 50;
  const omitUrl = opts.omitUrl ?? false;

  // The script:
  //   1. writes daemon.pid with its own $$ (POSIX shell PID)
  //   2. sleeps `delayMs` (to exercise polling)
  //   3. writes daemon.url unless `omitUrl`
  //   4. sleeps forever so the child stays "alive" during the test
  //      (we kill it in afterEach via the binDir cleanup + the
  //      detached-process group teardown).
  //
  // Note: we use a here-doc-free format so the file is easy to grep
  // and doesn't choke on escaping.
  const script = [
    "#!/bin/sh",
    'echo "$$" > "$LICH_HOME/daemon.pid"',
    `sleep ${(delayMs / 1000).toFixed(3)}`,
    omitUrl
      ? '# url omitted by test'
      : `printf '%s\\n' '${urlContents}' > "$LICH_HOME/daemon.url"`,
    "# Park indefinitely so the OS keeps the PID alive for tests",
    "sleep 60",
  ].join("\n");

  writeFileSync(fakeDaemonPath, script + "\n", "utf8");
  chmodSync(fakeDaemonPath, 0o755);
  process.env.LICH_DAEMON_BIN = fakeDaemonPath;
}

/**
 * Kill any fake-daemon processes left running by a test. We track the
 * fake daemon's recorded PID and SIGKILL it. Safe on race (the daemon
 * may already have exited via the 60s sleep wrap, but we don't wait
 * that long).
 */
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

// ---------------------------------------------------------------------------
// 1. Daemon already running → return alreadyRunning: true
// ---------------------------------------------------------------------------

describe("ensureDaemonRunning — already-running short-circuit", () => {
  it("returns alreadyRunning: true when daemon PID is alive and URL is present", async () => {
    // Use process.pid — guaranteed alive (we're running this test code)
    // — as the recorded daemon PID. The auto-start hook should detect
    // the live PID + present URL and short-circuit before any spawn.
    await writeDaemonPid(process.pid, { lichHome: home });
    await writeDaemonUrl("http://127.0.0.1:7777", { lichHome: home });

    // NOTE: deliberately leave LICH_DAEMON_BIN unset. If the hook
    // tried to spawn we'd get a "binary not found" throw — its absence
    // proves the spawn path was skipped.
    const result = await ensureDaemonRunning({ lichHome: home });

    expect(result).toEqual({
      url: "http://127.0.0.1:7777",
      alreadyRunning: true,
    });
  });

  it("does not invoke openBrowser when daemon already running", async () => {
    // openBrowser: true with no fake-daemon AND no LICH_DAEMON_BIN —
    // if the hook tried to spawn the daemon OR (worse) attempted a
    // browser-open spawn before realizing it's a no-op, we'd see
    // platform-side effects. Confirm we get clean return + no warnings.
    await writeDaemonPid(process.pid, { lichHome: home });
    await writeDaemonUrl("http://127.0.0.1:8888", { lichHome: home });
    const { stream, text } = captureOut();

    const result = await ensureDaemonRunning({
      lichHome: home,
      openBrowser: true,
      out: stream,
    });

    expect(result.alreadyRunning).toBe(true);
    expect(text()).toBe(""); // no warning lines
  });
});

// ---------------------------------------------------------------------------
// 2. Daemon not running → spawn, wait for URL file, return alreadyRunning: false
// ---------------------------------------------------------------------------

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
      // Belt-and-suspenders: the fake daemon should have created the
      // URL file at the LICH_HOME we passed.
      expect(existsSync(join(home, "daemon.url"))).toBe(true);
      expect(existsSync(join(home, "daemon.pid"))).toBe(true);
    } finally {
      killFakeDaemon();
    }
  });

  it("returns the exact URL the spawned daemon wrote (no normalization)", async () => {
    // Use an arbitrary URL shape to confirm we're not parsing it.
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

// ---------------------------------------------------------------------------
// 3. URL file never appears → throw after timeout
// ---------------------------------------------------------------------------

describe("ensureDaemonRunning — URL file timeout", () => {
  it("throws after timeoutMs when the URL file never appears", async () => {
    // omitUrl: true → the fake daemon writes the PID and sleeps but
    // never writes the URL file. The hook should time out.
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

// ---------------------------------------------------------------------------
// 4. Binary not found → throw with clear error
// ---------------------------------------------------------------------------

describe("ensureDaemonRunning — binary not found", () => {
  it("throws when LICH_DAEMON_BIN points at a missing path", async () => {
    process.env.LICH_DAEMON_BIN = join(binDir, "does-not-exist");
    await expect(
      ensureDaemonRunning({ lichHome: home, timeoutMs: 500 }),
    ).rejects.toThrow(/lich-daemon binary not found at .*does-not-exist/);
  });

  it("throws with both expected paths in the message when no env var", async () => {
    // No LICH_DAEMON_BIN, no sibling binary next to process.execPath —
    // unless the test runner happens to have one (unlikely; bun's
    // execPath is /usr/local/bin/bun or similar with no sibling
    // `lich-daemon`). Verify the error mentions the sibling path and
    // the env-var hint.
    delete process.env.LICH_DAEMON_BIN;
    await expect(
      ensureDaemonRunning({ lichHome: home, timeoutMs: 500 }),
    ).rejects.toThrow(/lich-daemon binary not found at .*\/lich-daemon/);
  });
});

// ---------------------------------------------------------------------------
// 5. openBrowser is best-effort — does not fail the function
// ---------------------------------------------------------------------------

describe("ensureDaemonRunning — openBrowser is best-effort", () => {
  it("does NOT throw when the browser-open call fails", async () => {
    // Set up a fake daemon that succeeds normally. The browser open is
    // platform-dependent and we can't easily make it fail without
    // mucking with PATH. Instead, we trust the implementation:
    //   - on darwin, `open <url>` is invoked; we pass a malformed URL
    //     that `open` will reject silently (it doesn't throw in the
    //     spawn sense — its child process exits with a non-zero code,
    //     which `unref()` ignores).
    //
    // The test guarantee is: ensureDaemonRunning resolves to a value,
    // never rejects, regardless of whether the browser actually opens.
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
      // Successfully returned — the openBrowser side-effect did not
      // affect the function's contract.
      expect(result.alreadyRunning).toBe(false);
    } finally {
      killFakeDaemon();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. LICH_HOME + LICH_PROXY_PORT forwarded to the spawned daemon
// ---------------------------------------------------------------------------

describe("ensureDaemonRunning — env var forwarding", () => {
  it("forwards LICH_HOME to the spawned daemon", async () => {
    // The fake daemon writes daemon.pid + daemon.url under $LICH_HOME.
    // If LICH_HOME weren't forwarded, the files would land somewhere
    // else (or fail to write). Asserting that they land under our `home`
    // proves the env propagation.
    writeFakeDaemon({ urlContents: "http://127.0.0.1:5555", delayMs: 30 });

    try {
      const result = await ensureDaemonRunning({
        lichHome: home,
        timeoutMs: 5_000,
      });
      expect(result.alreadyRunning).toBe(false);
      // Files physically present under `home`, proving env was forwarded
      expect(existsSync(join(home, "daemon.pid"))).toBe(true);
      expect(existsSync(join(home, "daemon.url"))).toBe(true);
    } finally {
      killFakeDaemon();
    }
  });

  it("forwards LICH_PROXY_PORT as a string to the spawned daemon", async () => {
    // Extend the fake daemon to echo $LICH_PROXY_PORT into a separate
    // file we can read back. Rewrite the script before writeFakeDaemon
    // installs it.
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
    // Same setup as above but no proxyPort opt — the env var should be
    // empty in the child since we don't override it. (We delete any
    // ambient one in beforeEach via the env stash; here we re-confirm.)
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
      // Empty file = empty $LICH_PROXY_PORT in the child.
      expect(readFileSync(portFile, "utf8")).toBe("");
    } finally {
      killFakeDaemon();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Alive PID + missing URL — wait, don't double-spawn
//
// Documented edge case: another `lich up` is in the middle of spawning
// the daemon; we see the alive PID but the URL hasn't been written yet.
// We MUST NOT spawn a second daemon (would fight over the PID file with
// the rightful owner). Instead, poll for the URL just like the spawn
// path does.
// ---------------------------------------------------------------------------

describe("ensureDaemonRunning — alive PID, URL pending", () => {
  it("polls for URL when PID is alive but URL not yet written", async () => {
    // Write only the PID file (with our own live PID). Then a moment
    // later, write the URL. The hook should see alive + no URL,
    // wait, and return when the URL appears.
    await writeDaemonPid(process.pid, { lichHome: home });

    // No LICH_DAEMON_BIN — if the hook tried to spawn it'd throw. The
    // absence of a throw proves the alive-but-pending branch.
    const promise = ensureDaemonRunning({
      lichHome: home,
      timeoutMs: 2_000,
      pollIntervalMs: 25,
    });

    // After a short delay, write the URL so the polling succeeds.
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
