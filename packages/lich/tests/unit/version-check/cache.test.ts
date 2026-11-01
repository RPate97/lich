import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCache,
  writeCache,
  isCacheStale,
  defaultCachePath,
} from "../../../src/version-check/cache.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-version-cache-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readCache", () => {
  it("returns null when the file does not exist", () => {
    expect(readCache(join(tmp, "nope.json"))).toBeNull();
  });

  it("reads a valid cache entry", () => {
    const path = join(tmp, "cache.json");
    writeFileSync(
      path,
      JSON.stringify({
        checked_at: "2026-11-01T00:00:00Z",
        latest_version: "0.6.2",
      }),
    );
    expect(readCache(path)).toEqual({
      checked_at: "2026-11-01T00:00:00Z",
      latest_version: "0.6.2",
    });
  });

  it("returns null on malformed JSON (best-effort)", () => {
    const path = join(tmp, "cache.json");
    writeFileSync(path, "not-json{");
    expect(readCache(path)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const path = join(tmp, "cache.json");
    writeFileSync(path, JSON.stringify({ checked_at: "x" }));
    expect(readCache(path)).toBeNull();
  });
});

describe("writeCache", () => {
  it("writes JSON that round-trips through readCache", () => {
    const path = join(tmp, "cache.json");
    writeCache(path, {
      checked_at: "2026-11-01T00:00:00Z",
      latest_version: "0.6.2",
    });
    expect(readCache(path)).toEqual({
      checked_at: "2026-11-01T00:00:00Z",
      latest_version: "0.6.2",
    });
  });

  it("creates the parent directory if missing", () => {
    const path = join(tmp, "nested", "deeper", "cache.json");
    writeCache(path, {
      checked_at: "2026-11-01T00:00:00Z",
      latest_version: "0.6.2",
    });
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw).latest_version).toBe("0.6.2");
  });
});

describe("isCacheStale", () => {
  const entry = {
    checked_at: "2026-11-01T00:00:00Z",
    latest_version: "0.6.2",
  };

  it("is false when the cache was checked within maxAgeMs", () => {
    const checkedMs = Date.parse(entry.checked_at);
    expect(isCacheStale(entry, 6 * 60 * 60 * 1000, checkedMs + 60_000)).toBe(false);
  });

  it("is true when the cache is older than maxAgeMs", () => {
    const checkedMs = Date.parse(entry.checked_at);
    expect(isCacheStale(entry, 6 * 60 * 60 * 1000, checkedMs + 7 * 60 * 60 * 1000)).toBe(true);
  });

  it("is true when checked_at is unparseable (treat as stale)", () => {
    expect(isCacheStale({ checked_at: "garbage", latest_version: "0.6.2" }, 1000, Date.now())).toBe(true);
  });
});

describe("defaultCachePath", () => {
  it("places the cache under LICH_HOME when set", () => {
    expect(defaultCachePath({ LICH_HOME: "/tmp/foo" })).toBe("/tmp/foo/latest-check.json");
  });

  it("falls back to ~/.lich when LICH_HOME is unset", () => {
    const got = defaultCachePath({});
    expect(got.endsWith("/.lich/latest-check.json")).toBe(true);
  });
});
