import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveStableId,
  getInstallationId,
} from "../../../src/telemetry/installation-id.js";

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-tel-id-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("getInstallationId", () => {
  it("derives a 32-char hex id on first call and caches it to the path", () => {
    const path = join(tmp, "installation-id");
    const id = getInstallationId(path);
    expect(id).toMatch(HEX32);
    expect(readFileSync(path, "utf8").trim()).toBe(id);
  });

  it("returns the same id on subsequent calls (cache hit)", () => {
    const path = join(tmp, "installation-id");
    const a = getInstallationId(path);
    const b = getInstallationId(path);
    expect(a).toBe(b);
  });

  it("accepts a legacy UUIDv4 in the cache file (back-compat)", () => {
    const path = join(tmp, "installation-id");
    const seed = "abcdef01-2345-6789-abcd-ef0123456789";
    writeFileSync(path, seed + "\n");
    expect(getInstallationId(path)).toBe(seed);
  });

  it("accepts a 32-char hex id in the cache file", () => {
    const path = join(tmp, "installation-id");
    const seed = "0123456789abcdef0123456789abcdef";
    writeFileSync(path, seed + "\n");
    expect(getInstallationId(path)).toBe(seed);
  });

  it("regenerates if the cache file is malformed", () => {
    const path = join(tmp, "installation-id");
    writeFileSync(path, "not-an-id\n");
    const id = getInstallationId(path);
    expect(id).not.toBe("not-an-id");
    expect(id).toMatch(HEX32);
  });

  it("returns null on read-only path", () => {
    const path = "/no/such/dir/installation-id";
    expect(getInstallationId(path)).toBeNull();
  });

  it("two fresh cache paths on the same machine produce the same id", () => {
    // The architectural fix: a test (or a user with a fresh LICH_HOME) no
    // longer mints a new ghost identity per LICH_HOME — the hash collapses
    // them by homedir+hostname.
    const a = getInstallationId(join(tmp, "a", "installation-id"));
    const b = getInstallationId(join(tmp, "b", "installation-id"));
    expect(a).toBe(b);
  });
});

describe("deriveStableId", () => {
  it("returns a 32-char hex string", () => {
    expect(deriveStableId()).toMatch(HEX32);
  });

  it("is deterministic across calls on the same machine", () => {
    expect(deriveStableId()).toBe(deriveStableId());
  });

  it("output format does not collide with the UUIDv4 shape", () => {
    expect(deriveStableId()).not.toMatch(UUID);
  });
});
