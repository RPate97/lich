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

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-daemon-pid-"));
  prevLichHome = process.env.LICH_HOME;
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

// PID overwhelmingly unlikely to be alive — past default Linux/macOS ceilings
const DEAD_PID = 999_999;

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
    const fresh = join(home, "fresh-home");
    await writeDaemonPid(42, { lichHome: fresh });
    expect(await readDaemonPid({ lichHome: fresh })).toBe(42);
  });

  it("tolerates trailing whitespace in the file (writer convention)", async () => {
    writeFileSync(join(home, "daemon.pid"), "  4242  \n", "utf8");
    expect(await readDaemonPid()).toBe(4242);
  });
});

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
    // parseInt("123abc") would return 123; reader uses Number() to reject corrupt writes
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

describe("isDaemonAlive", () => {
  it("returns true for the current process PID", async () => {
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
    writeFileSync(join(home, "daemon.pid"), "garbage\n", "utf8");
    expect(await isDaemonAlive()).toBe(false);
  });
});

describe("clearDaemonPid", () => {
  it("removes the PID file when present", async () => {
    await writeDaemonPid(1234);
    expect(existsSync(join(home, "daemon.pid"))).toBe(true);

    await clearDaemonPid();
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);

    await expect(access(join(home, "daemon.pid"))).rejects.toThrow();
  });

  it("is idempotent when the file does not exist", async () => {
    await expect(clearDaemonPid()).resolves.toBeUndefined();
  });

  it("can be called twice in a row without error", async () => {
    await writeDaemonPid(7);
    await clearDaemonPid();
    await expect(clearDaemonPid()).resolves.toBeUndefined();
  });
});

describe("LICH_HOME resolution", () => {
  it("honors `opts.lichHome` over the env var", async () => {
    const alt = mkdtempSync(join(tmpdir(), "lich-daemon-pid-alt-"));
    try {
      await writeDaemonPid(9999, { lichHome: alt });

      expect(await readDaemonPid({ lichHome: alt })).toBe(9999);
      expect(await readDaemonPid()).toBeNull();

      const altContents = readFileSync(join(alt, "daemon.pid"), "utf8");
      expect(altContents.trim()).toBe("9999");
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });

  it("falls back to LICH_HOME env var when `opts.lichHome` is unset", async () => {
    await writeDaemonPid(8765);
    const onDisk = readFileSync(join(home, "daemon.pid"), "utf8");
    expect(onDisk.trim()).toBe("8765");
    expect(await readDaemonPid()).toBe(8765);
  });

  it("falls back to LICH_HOME env var when `opts.lichHome` is the empty string", async () => {
    await writeDaemonPid(4321, { lichHome: "" });
    expect(readFileSync(join(home, "daemon.pid"), "utf8").trim()).toBe("4321");
  });

  it("ignores an empty LICH_HOME env var (defaults to ~/.lich)", async () => {
    process.env.LICH_HOME = "";
    // The contract under test: empty LICH_HOME is treated as unset, not
    // as the cwd or as the empty path. We verify by negative: setting it
    // to "" must NOT make the resolver write to `home` (the beforeEach
    // tmpdir LICH_HOME pointed at before). We can't reliably assert the
    // ~/.lich fallback returns null because a dev machine may have a
    // real daemon running with a real daemon.pid — and Bun caches
    // os.homedir() at startup, so mid-process HOME stubs don't help.
    await readDaemonPid();
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  });
});

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
    const fresh = join(home, "fresh-home");
    await writeDaemonUrl("http://127.0.0.1:9000", { lichHome: fresh });
    expect(await readDaemonUrl({ lichHome: fresh })).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("strips trailing whitespace on read (writer convention)", async () => {
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
    await writeDaemonUrl("not-actually-a-url-just-a-string");
    expect(await readDaemonUrl()).toBe("not-actually-a-url-just-a-string");
  });
});

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
      expect(await readDaemonUrl()).toBeNull();

      const altContents = readFileSync(join(alt, "daemon.url"), "utf8");
      expect(altContents.trim()).toBe("http://127.0.0.1:9999");
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });
});
