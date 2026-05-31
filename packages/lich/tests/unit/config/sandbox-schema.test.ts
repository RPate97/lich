import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../../src/config/parse.js";

// Note: the plan references `parseLichYaml` (a string-based API) but the
// actual export is `parseConfig` (file-based). Tests are adapted accordingly.

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-sandbox-schema-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(body: string): string {
  const p = join(tmp, "lich.yaml");
  writeFileSync(p, body, "utf8");
  return p;
}

describe("runtime.sandbox config parsing", () => {
  test("minimal sandbox block parses", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.runtime?.sandbox?.backend).toBe("tart");
    }
  });

  test("full sandbox block parses", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
    image: lich-sandbox-base
    memory: 8192
    cpus: 8
    warm_fork: false
    snapshot_store: /tmp/lich-snapshots
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.runtime?.sandbox).toMatchObject({
        backend: "tart",
        image: "lich-sandbox-base",
        memory: 8192,
        cpus: 8,
        warm_fork: false,
        snapshot_store: "/tmp/lich-snapshots",
      });
    }
  });

  test("unknown backend rejected", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: vmware
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(false);
  });

  test("missing backend rejected", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    image: foo
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(false);
  });

  test("lich.yaml without sandbox block parses fine", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  port_range: [3000, 3999]
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.runtime?.sandbox).toBeUndefined();
    }
  });
});
