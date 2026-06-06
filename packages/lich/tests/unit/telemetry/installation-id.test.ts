import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getInstallationId } from "../../../src/telemetry/installation-id.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-tel-id-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("getInstallationId", () => {
  it("generates a UUID on first call", () => {
    const path = join(tmp, "installation-id");
    const id = getInstallationId(path);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(readFileSync(path, "utf8").trim()).toBe(id);
  });

  it("returns the same id on subsequent calls", () => {
    const path = join(tmp, "installation-id");
    const a = getInstallationId(path);
    const b = getInstallationId(path);
    expect(a).toBe(b);
  });

  it("reads an existing id without rewriting", () => {
    const path = join(tmp, "installation-id");
    const seed = "abcdef01-2345-6789-abcd-ef0123456789";
    writeFileSync(path, seed + "\n");
    expect(getInstallationId(path)).toBe(seed);
  });

  it("regenerates if the existing file is malformed", () => {
    const path = join(tmp, "installation-id");
    writeFileSync(path, "not-a-uuid\n");
    const id = getInstallationId(path);
    expect(id).not.toBe("not-a-uuid");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns null on read-only path", () => {
    const path = "/no/such/dir/installation-id";
    expect(getInstallationId(path)).toBeNull();
  });
});
