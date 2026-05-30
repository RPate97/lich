import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RUN_MARKER_PATTERN,
  writeRunMarker,
} from "../../../src/logs/run-marker.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-run-marker-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tmpDirs = [];
});

describe("writeRunMarker", () => {
  it("creates the log file and writes a marker when none exists", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");

    const { offset, runId } = await writeRunMarker(logPath);

    const contents = readFileSync(logPath, "utf8");
    const markerLine = contents.split("\n").find((l) => RUN_MARKER_PATTERN.test(l));
    expect(markerLine).toBeDefined();
    expect(contents).toContain(`[run: ${runId}]`);
    expect(contents.endsWith("\n")).toBe(true);
    expect(offset).toBe(statSync(logPath).size);
  });

  it("appends to an existing log file without losing prior content", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    const prior = "prior-line-1\nprior-line-2\n";
    writeFileSync(logPath, prior);

    const { offset } = await writeRunMarker(logPath);

    const contents = readFileSync(logPath, "utf8");
    expect(contents.startsWith(prior)).toBe(true);
    expect(contents.slice(prior.length)).toMatch(/^=== lich up at .* \[run: .*\] ===\n$/u);
    expect(offset).toBe(statSync(logPath).size);
  });

  it("injects a leading newline if the prior content is missing a trailing newline", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "no-trailing-newline");

    await writeRunMarker(logPath);

    const contents = readFileSync(logPath, "utf8");
    // After append: "no-trailing-newline\n=== lich up ... ===\n"
    expect(contents.startsWith("no-trailing-newline\n")).toBe(true);
    const lines = contents.split("\n");
    // Find the marker line; it must be on its own line.
    const markerLine = lines.find((l) => RUN_MARKER_PATTERN.test(l));
    expect(markerLine).toBeDefined();
  });

  it("returns a stable runId that appears in the marker line", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");

    const { runId } = await writeRunMarker(logPath, { runId: "abc-123-deadbeef" });

    const contents = readFileSync(logPath, "utf8");
    expect(runId).toBe("abc-123-deadbeef");
    expect(contents).toContain("[run: abc-123-deadbeef]");
  });

  it("uses the supplied timestamp", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    const fixed = new Date("2026-05-30T12:34:56.789Z");

    await writeRunMarker(logPath, { now: fixed });

    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("at 2026-05-30T12:34:56.789Z");
  });

  it("offset points past the marker so a LogTail starting there sees only NEW content", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "STALE_SENTINEL prior run\n");

    const { offset } = await writeRunMarker(logPath);

    // Simulate the supervised process appending new lines AFTER the marker.
    appendFileSync(logPath, "new-line-1\nnew-line-2\n");

    const fullContents = readFileSync(logPath, "utf8");
    // What a LogTail starting at `offset` would read.
    const afterOffset = fullContents.slice(offset);
    expect(afterOffset).toBe("new-line-1\nnew-line-2\n");
    expect(afterOffset).not.toContain("STALE_SENTINEL");
    expect(afterOffset).not.toContain("lich up at");
  });

  it("creates parent directories that don't exist", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "nested", "deeper", "svc.log");

    await writeRunMarker(logPath);

    const contents = readFileSync(logPath, "utf8");
    const markerLine = contents.split("\n").find((l) => RUN_MARKER_PATTERN.test(l));
    expect(markerLine).toBeDefined();
  });

  it("each call gets a distinct runId by default", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");

    const a = await writeRunMarker(logPath);
    const b = await writeRunMarker(logPath);
    const c = await writeRunMarker(logPath);

    const ids = new Set([a.runId, b.runId, c.runId]);
    expect(ids.size).toBe(3);
  });

  it("offset equals the file size after the marker is written", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "x".repeat(100) + "\n");

    const { offset } = await writeRunMarker(logPath);
    expect(offset).toBe(statSync(logPath).size);
  });
});

describe("RUN_MARKER_PATTERN", () => {
  it("matches a freshly-written marker line", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    await writeRunMarker(logPath);

    const contents = readFileSync(logPath, "utf8");
    const lines = contents.split("\n");
    const markerLine = lines.find((l) => RUN_MARKER_PATTERN.test(l));
    expect(markerLine).toBeDefined();
  });

  it("does NOT match unrelated content", () => {
    expect(RUN_MARKER_PATTERN.test("=== something else ===")).toBe(false);
    expect(RUN_MARKER_PATTERN.test("lich up at xyz")).toBe(false);
    expect(RUN_MARKER_PATTERN.test("")).toBe(false);
    expect(RUN_MARKER_PATTERN.test("=== lich up at  [run: ] ===")).toBe(false);
  });
});
