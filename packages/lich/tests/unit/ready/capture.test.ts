import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTail } from "../../../src/logs/tail.js";
import {
  CaptureMissError,
  runCapture,
} from "../../../src/ready/capture.js";

// Track tmpdirs + tails per test so afterEach can tear them all down.
let tmpDirs: string[] = [];
let tails: LogTail[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-capture-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Construct a LogTail tracked for afterEach cleanup. Tests should call
 * this rather than `new LogTail(...)` directly so a thrown assertion
 * doesn't leak a running interval.
 */
function makeTail(
  opts: ConstructorParameters<typeof LogTail>[0],
): LogTail {
  const tail = new LogTail(opts);
  tails.push(tail);
  return tail;
}

/** Sleep helper for waiting on the LogTail poll loop to ingest content. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll a predicate until it returns true or the timeout elapses. Faster
 * than fixed sleeps and more reliable than waiting on a single tick.
 */
async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const intervalMs = opts.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(
    `waitFor: predicate did not become true within ${timeoutMs}ms`,
  );
}

/**
 * Seed a log file with `content` and construct a started LogTail that has
 * ingested all of it. Returns the tail with `.buffer` already populated.
 *
 * Uses a tight `intervalMs: 10` to keep test runtime small. The wait
 * predicate watches the buffer's `length`, which is the most reliable
 * signal the poll loop has caught up.
 */
async function seededTail(content: string): Promise<LogTail> {
  const dir = makeTmpDir();
  const logPath = join(dir, "svc.log");
  writeFileSync(logPath, content);

  const tail = makeTail({ logPath, intervalMs: 10 });
  await tail.start();
  // Wait for the poll loop to read the file. The buffer is populated only
  // after the first growth-detection tick, so we can't just `await start()`
  // and call it done.
  await waitFor(() => tail.buffer.length >= content.length, { timeoutMs: 500 });
  return tail;
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

describe("runCapture", () => {
  it("captures named values from the LogTail buffer when patterns match", async () => {
    // The canonical use case from the design spec: a service emits a
    // tunnel URL once on startup; capture extracts it for downstream
    // env interpolation as ${owned.X.captured.url}.
    const tail = await seededTail(
      "https://abc-def.trycloudflare.com is ready\n",
    );

    const result = runCapture({
      tail,
      // Backslashes are double-escaped here because this is a JS string
      // literal — the regex engine sees `https://[a-z-]+\.trycloudflare\.com`.
      patterns: { url: "https://[a-z-]+\\.trycloudflare\\.com" },
    });

    expect(result).toEqual({ url: "https://abc-def.trycloudflare.com" });
  });

  it("uses match group 1 if the regex defines a capture group", async () => {
    // When the user wraps part of the pattern in `(...)`, the extractor
    // returns just that group. This is the "extract the port number out
    // of `Listening on port 8080`" case.
    const tail = await seededTail("Listening on port 8080\n");

    const result = runCapture({
      tail,
      patterns: { port: "Listening on port (\\d+)" },
    });

    expect(result).toEqual({ port: "8080" });
  });

  it("returns the full match (group 0) when the pattern has no capture group", async () => {
    // Sibling case to the previous test — confirms the group-0 fallback
    // explicitly so the two behaviors are independently locked in.
    const tail = await seededTail("Server listening on 127.0.0.1:5432\n");

    const result = runCapture({
      tail,
      patterns: { addr: "\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+" },
    });

    expect(result).toEqual({ addr: "127.0.0.1:5432" });
  });

  it("captures multiple named values from the same buffer when all match", async () => {
    // The extractor handles N independent patterns in one call. Each runs
    // against the same buffer; they don't share state. This proves the
    // multi-key path before we test the multi-key-miss path below.
    const tail = await seededTail(
      "Listening on port 8080\nReady at https://abc-def.trycloudflare.com\n",
    );

    const result = runCapture({
      tail,
      patterns: {
        port: "Listening on port (\\d+)",
        url: "https://[a-z-]+\\.trycloudflare\\.com",
      },
    });

    expect(result).toEqual({
      port: "8080",
      url: "https://abc-def.trycloudflare.com",
    });
  });

  it("throws CaptureMissError naming the missing key when no match found", async () => {
    // Per the plan-4 spec: a missing capture aborts the service. The error
    // names the key first because that's what the user typed in their yaml.
    const tail = await seededTail("nothing interesting here\n");

    expect(() =>
      runCapture({
        tail,
        patterns: { url: "https://[a-z-]+\\.trycloudflare\\.com" },
      }),
    ).toThrow(CaptureMissError);

    // Re-throw to inspect the error shape — `.toThrow` doesn't expose the
    // thrown value, so we run it again and catch.
    let err: unknown;
    try {
      runCapture({
        tail,
        patterns: { url: "https://[a-z-]+\\.trycloudflare\\.com" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CaptureMissError);
    const cm = err as CaptureMissError;
    expect(cm.key).toBe("url");
    expect(cm.pattern).toBe("https://[a-z-]+\\.trycloudflare\\.com");
    expect(cm.message).toContain('"url"');
  });

  it("fails on the FIRST missing key (does not collect all misses)", async () => {
    // Per the spec discussion in the plan: a missing capture fails the
    // service. We intentionally do NOT aggregate misses — surfacing the
    // first miss in declaration order gives users a stable error to fix
    // and re-run, rather than a list to chase symptom-by-symptom.
    const tail = await seededTail("port 8080 ready\n");

    let err: unknown;
    try {
      runCapture({
        tail,
        patterns: {
          // Declaration order: missing_first declared before port, which
          // would match. The extractor should bail on missing_first
          // without ever attempting `port` — otherwise the test below
          // would name the wrong key.
          missing_first: "will-never-match-this",
          port: "port (\\d+)",
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CaptureMissError);
    expect((err as CaptureMissError).key).toBe("missing_first");
  });

  it("returns an empty object when patterns is empty", async () => {
    // Defensive: the user could declare `capture: {}` (or, more realistically,
    // the orchestrator could pass an empty patterns map after stripping a
    // disabled section). The extractor should treat that as a no-op and
    // return an empty record, NOT throw.
    const tail = await seededTail("any content\n");
    const result = runCapture({ tail, patterns: {} });
    expect(result).toEqual({});
  });

  it("matches across line boundaries (buffer is searched as one string)", async () => {
    // The buffer is NOT line-split — capture sees the raw concatenated
    // byte stream. This means a pattern like `(?s)...` or a pattern with
    // `\n` in it could span multiple lines if a user really wanted to.
    // We assert the more common case: the buffer is searched start-to-end,
    // so the first occurrence anywhere wins regardless of position.
    const tail = await seededTail(
      "noise line 1\nnoise line 2\nTARGET=42\nnoise line 4\n",
    );

    const result = runCapture({
      tail,
      patterns: { target: "TARGET=(\\d+)" },
    });
    expect(result).toEqual({ target: "42" });
  });

  it("uses only the FIRST match when the pattern appears multiple times", async () => {
    // First-match semantics: the orchestrator wants the moment-of-readiness
    // snapshot. A service printing the same URL on every request still
    // surfaces the first one.
    const tail = await seededTail(
      "url=https://first.example.com\nurl=https://second.example.com\n",
    );

    const result = runCapture({
      tail,
      patterns: { url: "https://[a-z.]+" },
    });
    expect(result).toEqual({ url: "https://first.example.com" });
  });
});

describe("CaptureMissError", () => {
  it("exposes the key and pattern on the error instance", () => {
    // Test the error class directly so consumers (the formatter, the
    // dashboard) can rely on the field shape independently of when an
    // actual miss happens.
    const err = new CaptureMissError({ key: "url", pattern: "abc" });
    expect(err.name).toBe("CaptureMissError");
    expect(err.key).toBe("url");
    expect(err.pattern).toBe("abc");
    expect(err.message).toContain('"url"');
    expect(err.message).toContain("abc");
  });

  it("is an Error subclass (catchable via instanceof Error)", () => {
    // Important for the orchestrator's catch-all error handling — promise
    // rejections that aren't instanceof Error get logged differently.
    const err = new CaptureMissError({ key: "k", pattern: "p" });
    expect(err).toBeInstanceOf(Error);
  });
});
