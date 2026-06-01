import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../../src/config/parse.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "lich-bake-inputs-val-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function writeYaml(body: string): string {
  const p = join(tmp, "lich.yaml");
  writeFileSync(p, body, "utf8");
  return p;
}

describe("runtime.sandbox requires bake_inputs", () => {
  test("sandbox without bake_inputs is rejected", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /bake_inputs/.test(e.message))).toBe(true);
    }
  });

  test("sandbox with empty bake_inputs is rejected", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
    bake_inputs: []
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => /bake_inputs/.test(e.message) && /non-empty|empty|fewer than 1/.test(e.message),
        ),
      ).toBe(true);
    }
  });

  test("sandbox with bake_inputs is accepted", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
    bake_inputs:
      - db/migrations/**
      - db/seed.sql
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(true);
  });

  test("no sandbox block — bake_inputs not required", async () => {
    const p = writeYaml(`
version: "1"
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(true);
  });

  test("sandbox.gc block accepted", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
    bake_inputs: ["db/migrations/**"]
    gc:
      keep_per_profile: 3
      max_total_gb: 50
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(true);
  });

  test("sandbox.gc.keep_per_profile must be positive", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
    bake_inputs: ["db/migrations/**"]
    gc:
      keep_per_profile: 0
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(false);
  });

  test("per_fork: true on a lifecycle hook is accepted", async () => {
    const p = writeYaml(`
version: "1"
runtime:
  sandbox:
    backend: tart
    bake_inputs: ["db/migrations/**"]
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
lifecycle:
  after_up:
    - cmd: echo ephemeral
      per_fork: true
`);
    const result = await parseConfig(p);
    expect(result.ok).toBe(true);
  });
});
