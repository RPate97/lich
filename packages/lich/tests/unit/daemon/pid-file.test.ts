import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearDaemonPid,
  clearDaemonUrl,
  isDaemonAlive,
  readDaemonPid,
  readDaemonUrl,
  writeDaemonPid,
  writeDaemonUrl,
} from "../../../src/daemon/pid-file.js";

// ---------------------------------------------------------------------------
// Fixture harness
//
// Every test points LICH_HOME at a fresh tmpdir so reads and writes are
// hermetic — the real `~/.lich/daemon.pid` is never touched. We also
// stash and restore the original `process.env.LICH_HOME` so the env-var
// fallback test can manipulate it directly.
// ---------------------------------------------------------------------------

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-daemon-pid-"));
  prevLichHome = process.env.LICH_HOME;
  // Default: route through env var. Tests that want to verify `opts.lichHome`
  // takes precedence pass a separate tmpdir explicitly.
  process.env.LICH_HOME = home;
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
});

// A PID that is overwhelmingly unlikely to ever be alive on any system.
// PIDs typically wrap below 100k on Linux/macOS — 999999 is safely past
// the default ceilings. The test that uses this asserts the dead-PID
// branch of isDaemonAlive without picking a number that might collide
// with a real process.
const DEAD_PID = 999_999;

// ---------------------------------------------------------------------------
// writeDaemonPid + readDaemonPid: round-trip
// ---------------------------------------------------------------------------

describe("writeDaemonPid + readDaemonPid", () => {
  it("round-trips a PID through the file", async () => {
    await writeDaemonPid(12345);
    expect(await readDaemonPid()).toBe(12345);
  });

  it("overwrites a prior PID on subsequent writes", async () => {
    await writeDaemonPid(1111);
    await writeDaemonPid(2222);
    expect(await readDaemonPid()).toBe(2222);
  });

  it("creates the LICH_HOME parent directory if it does not yet exist", async () => {
    // Point at a subdirectory of `home` that doesn't exist yet — a
    // fresh machine that has never run lich won't have `~/.lich/` until
    // someone creates it.
    const fresh = join(home, "fresh-home");
    await writeDaemonPid(42, { lichHome: fresh });
    expect(await readDaemonPid({ lichHome: fresh })).toBe(42);
  });

  it("tolerates trailing whitespace in the file (writer convention)", async () => {
    // writeDaemonPid intentionally appends a trailing newline; the read
    // path must strip it. Belt-and-suspenders: also tolerate extra junk
    // whitespace a manual `echo > daemon.pid` would produce.
    writeFileSync(join(home, "daemon.pid"), "  4242  \n", "utf8");
    expect(await readDaemonPid()).toBe(4242);
  });
});

// ---------------------------------------------------------------------------
// readDaemonPid: absence + corruption
// ---------------------------------------------------------------------------

describe("readDaemonPid (missing / malformed)", () => {
  it("returns null when the PID file does not exist", async () => {
    expect(await readDaemonPid()).toBeNull();
  });

  it("returns null when the file is empty", async () => {
    writeFileSync(join(home, "daemon.pid"), "", "utf8");
    expect(await readDaemonPid()).toBeNull();
  });

  it("returns null when the file is whitespace only", async () => {
    writeFileSync(join(home, "daemon.pid"), "  \n\t\n", "utf8");
    expect(await readDaemonPid()).toBeNull();
  });

  it("returns null when the contents are not parseable as a number", async () => {
    writeFileSync(join(home, "daemon.pid"), "not-a-number\n", "utf8");
    expect(await readDaemonPid()).toBeNull();
  });

  it("returns null on a partially-numeric string (rejects parseInt-style coercion)", async () => {
    // parseInt("123abc") would return 123; we use Number() to reject
    // this case because a corrupt write should not be silently accepted.
    writeFileSync(join(home, "daemon.pid"), "123abc\n", "utf8");
    expect(await readDaemonPid()).toBeNull();
  });

  it("returns null when the PID is negative or zero", async () => {
    writeFileSync(join(home, "daemon.pid"), "-1\n", "utf8");
    expect(await readDaemonPid()).toBeNull();
    writeFileSync(join(home, "daemon.pid"), "0\n", "utf8");
    expect(await readDaemonPid()).toBeNull();
  });

  it("returns null when the PID is not an integer", async () => {
    writeFileSync(join(home, "daemon.pid"), "3.14\n", "utf8");
    expect(await readDaemonPid()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isDaemonAlive
// ---------------------------------------------------------------------------

describe("isDaemonAlive", () => {
  it("returns true for the current process PID", async () => {
    // process.pid is by definition alive — running this test code.
    await writeDaemonPid(process.pid);
    expect(await isDaemonAlive()).toBe(true);
  });

  it("returns false for a definitely-dead PID", async () => {
    await writeDaemonPid(DEAD_PID);
    expect(await isDaemonAlive()).toBe(false);
  });

  it("returns false when no PID file exists", async () => {
    expect(await isDaemonAlive()).toBe(false);
  });

  it("returns false when the PID file is malformed", async () => {
    // Malformed file → readDaemonPid returns null → isDaemonAlive false.
    writeFileSync(join(home, "daemon.pid"), "garbage\n", "utf8");
    expect(await isDaemonAlive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearDaemonPid
// ---------------------------------------------------------------------------

describe("clearDaemonPid", () => {
  it("removes the PID file when present", async () => {
    await writeDaemonPid(1234);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    await clearDaemonPid();
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    // Belt-and-suspenders: fs.access throws on missing file.
    await expect(access(join(home, "daemon.pid"))).rejects.toThrow();
  });

  it("is idempotent when the file does not exist", async () => {
    // No write first — file is absent. Clear should not throw.
    await expect(clearDaemonPid()).resolves.toBeUndefined();
  });

  it("can be called twice in a row without error", async () => {
    await writeDaemonPid(7);
    await clearDaemonPid();
    await expect(clearDaemonPid()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LICH_HOME resolution: opts.lichHome takes precedence over env
// ---------------------------------------------------------------------------

describe("LICH_HOME resolution", () => {
  it("honors `opts.lichHome` over the env var", async () => {
    // The harness pointed LICH_HOME at `home`. Use a different tmpdir
    // for `opts.lichHome` and verify the file lands there, not in `home`.
    const alt = mkdtempSync(join(tmpdir(), "lich-daemon-pid-alt-"));
    try {
      await writeDaemonPid(9999, { lichHome: alt });

      // Read with the same opts: 9999.
      expect(await readDaemonPid({ lichHome: alt })).toBe(9999);

      // Read with the env-var path (no opts): no file.
      expect(await readDaemonPid()).toBeNull();

      // File physically lives at the opts path.
      const altContents = readFileSync(join(alt, "daemon.pid"), "utf8");
      expect(altContents.trim()).toBe("9999");
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });

  it("falls back to LICH_HOME env var when `opts.lichHome` is unset", async () => {
    // Default behavior — the harness already set LICH_HOME = home. The
    // write should land at <home>/daemon.pid; explicitly read it back via
    // node:fs to prove it.
    await writeDaemonPid(8765);
    const onDisk = readFileSync(join(home, "daemon.pid"), "utf8");
    expect(onDisk.trim()).toBe("8765");
    expect(await readDaemonPid()).toBe(8765);
  });

  it("falls back to LICH_HOME env var when `opts.lichHome` is the empty string", async () => {
    // Empty-string opts.lichHome should not be treated as a valid override.
    // The harness's env var (`home`) wins.
    await writeDaemonPid(4321, { lichHome: "" });
    expect(readFileSync(join(home, "daemon.pid"), "utf8").trim()).toBe("4321");
  });

  it("ignores an empty LICH_HOME env var (defaults to ~/.lich)", async () => {
    // When both opts.lichHome and the env var are empty, the resolver
    // falls through to homedir() + .lich — we don't actually write to
    // ~/.lich (that would dirty the real home), but the resolver's
    // path string must NOT point inside our tmpdir.
    process.env.LICH_HOME = "";
    // Use a read against a missing file to exercise the path resolver
    // without writing anywhere on disk. We can't easily assert the path
    // directly without exposing it, so we verify behavior by ensuring no
    // file shows up in `home`.
    const pid = await readDaemonPid();
    expect(pid).toBeNull();
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL file — writeDaemonUrl + readDaemonUrl round-trip
//
// The URL file mirrors the PID file's contract (LICH_HOME resolution,
// atomic writes, idempotent clear). These tests cover the URL-specific
// shape: any string the caller hands in is what `readDaemonUrl` gives
// back, modulo surrounding whitespace.
// ---------------------------------------------------------------------------

describe("writeDaemonUrl + readDaemonUrl", () => {
  it("round-trips a URL through the file", async () => {
    await writeDaemonUrl("http://127.0.0.1:54321");
    expect(await readDaemonUrl()).toBe("http://127.0.0.1:54321");
  });

  it("overwrites a prior URL on subsequent writes", async () => {
    await writeDaemonUrl("http://127.0.0.1:1111");
    await writeDaemonUrl("http://127.0.0.1:2222");
    expect(await readDaemonUrl()).toBe("http://127.0.0.1:2222");
  });

  it("creates the LICH_HOME parent directory if it does not yet exist", async () => {
    // Mirror the PID-file test: a fresh machine lacks `~/.lich`.
    const fresh = join(home, "fresh-home");
    await writeDaemonUrl("http://127.0.0.1:9000", { lichHome: fresh });
    expect(await readDaemonUrl({ lichHome: fresh })).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("strips trailing whitespace on read (writer convention)", async () => {
    // writeDaemonUrl intentionally appends a trailing newline; the read
    // path must strip it.
    writeFileSync(
      join(home, "daemon.url"),
      "  http://127.0.0.1:7777  \n",
      "utf8",
    );
    expect(await readDaemonUrl()).toBe("http://127.0.0.1:7777");
  });

  it("returns null when the URL file does not exist", async () => {
    expect(await readDaemonUrl()).toBeNull();
  });

  it("returns null when the URL file is empty", async () => {
    writeFileSync(join(home, "daemon.url"), "", "utf8");
    expect(await readDaemonUrl()).toBeNull();
  });

  it("returns null when the URL file is whitespace only", async () => {
    writeFileSync(join(home, "daemon.url"), "  \n\t\n", "utf8");
    expect(await readDaemonUrl()).toBeNull();
  });

  it("does not validate URL shape — round-trips arbitrary strings", async () => {
    // We deliberately don't parse the URL on write/read. A caller that
    // writes garbage gets garbage back. Documented behavior.
    await writeDaemonUrl("not-actually-a-url-just-a-string");
    expect(await readDaemonUrl()).toBe("not-actually-a-url-just-a-string");
  });
});

// ---------------------------------------------------------------------------
// clearDaemonUrl
// ---------------------------------------------------------------------------

describe("clearDaemonUrl", () => {
  it("removes the URL file when present", async () => {
    await writeDaemonUrl("http://127.0.0.1:1234");
    expect(existsSync(join(home, "daemon.url"))).toBe(true);

    await clearDaemonUrl();
    expect(existsSync(join(home, "daemon.url"))).toBe(false);
  });

  it("is idempotent when the file does not exist", async () => {
    await expect(clearDaemonUrl()).resolves.toBeUndefined();
  });

  it("can be called twice in a row without error", async () => {
    await writeDaemonUrl("http://127.0.0.1:7");
    await clearDaemonUrl();
    await expect(clearDaemonUrl()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// URL + PID file independence
//
// The two files have separate lifecycles — clearing one must NOT clear
// the other. This matters because the daemon's startup writes the PID
// file first, then the URL file once `Bun.serve` binds; the auto-start
// hook polls for the URL file independently of the PID file.
// ---------------------------------------------------------------------------

describe("URL + PID file independence", () => {
  it("clearing the PID file leaves the URL file untouched", async () => {
    await writeDaemonPid(1234);
    await writeDaemonUrl("http://127.0.0.1:5678");

    await clearDaemonPid();

    expect(await readDaemonPid()).toBeNull();
    expect(await readDaemonUrl()).toBe("http://127.0.0.1:5678");
  });

  it("clearing the URL file leaves the PID file untouched", async () => {
    await writeDaemonPid(1234);
    await writeDaemonUrl("http://127.0.0.1:5678");

    await clearDaemonUrl();

    expect(await readDaemonUrl()).toBeNull();
    expect(await readDaemonPid()).toBe(1234);
  });

  it("URL file honors opts.lichHome over env (mirrors PID)", async () => {
    const alt = mkdtempSync(join(tmpdir(), "lich-daemon-url-alt-"));
    try {
      await writeDaemonUrl("http://127.0.0.1:9999", { lichHome: alt });

      expect(await readDaemonUrl({ lichHome: alt })).toBe(
        "http://127.0.0.1:9999",
      );
      // env-var path (no opts) has no file.
      expect(await readDaemonUrl()).toBeNull();

      const altContents = readFileSync(join(alt, "daemon.url"), "utf8");
      expect(altContents.trim()).toBe("http://127.0.0.1:9999");
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });
});
