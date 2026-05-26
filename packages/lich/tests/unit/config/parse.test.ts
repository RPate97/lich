import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseConfig } from "../../../src/config/parse.js";
import type { LichConfig, OwnedService } from "../../../src/config/types.js";

// Repo-root-relative path to the dogfood-stack yaml. From this file:
//   packages/lich/tests/unit/config/parse.test.ts
// the repo root is five `..` segments up.
const DOGFOOD_YAML = resolve(
  __dirname,
  "../../../../../examples/dogfood-stack/lich.yaml"
);

// ---------------------------------------------------------------------------
// tmpdir helper
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-parse-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body, "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseConfig", () => {
  it("parses the dogfood-stack lich.yaml successfully", async () => {
    const result = await parseConfig(DOGFOOD_YAML);

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS

    expect(result.sourcePath).toBe(DOGFOOD_YAML);
    expect(result.config.version).toBe("1");

    // owned services we expect from the dogfood yaml. `tunnel_demo` was
    // added in Plan 4 (LEV-368) as a synthetic fixture that exercises
    // ready_when.capture and fail_when end-to-end; if it disappears from
    // the yaml the capture e2e tests in Plan 4 lose their target.
    //
    // LEV-463: supabase (owned) was replaced by postgres (compose service)
    // for faster startup (~3s vs ~35s). owned count is now 3 (was 4).
    expect(result.config.owned).toBeDefined();
    expect(Object.keys(result.config.owned!).sort()).toEqual([
      "api",
      "tunnel_demo",
      "web",
    ]);

    // services block now declares postgres (LEV-463 + LEV-477 inlined the
    // compose service definition into lich.yaml). Confirm parse handles
    // the inline-compose shape correctly.
    expect(result.config.services).toBeDefined();
    expect(Object.keys(result.config.services!).sort()).toEqual(["postgres"]);

    // Type-check: LichConfig actually narrows things. If types compile
    // we get to assign here without `any`.
    const api: OwnedService = result.config.owned!.api;
    expect(api.cmd).toBe("bun run dev");
    expect(api.cwd).toBe("apps/api");
  });

  it("returns an io error when the file does not exist", async () => {
    const result = await parseConfig(join(tmp, "does-not-exist.yaml"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe("io");
    expect(result.errors[0].message).toMatch(/not found/i);
    expect(result.errors[0].location).toContain("does-not-exist.yaml");
  });

  it("returns a yaml error for malformed YAML", async () => {
    const p = writeYaml(
      "broken.yaml",
      // unterminated flow sequence — invalid YAML
      ["version: \"1\"", "owned:", "  key: [unclosed"].join("\n") + "\n"
    );

    const result = await parseConfig(p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.kind === "yaml")).toBe(true);
    // Location should at least reference the file.
    expect(result.errors[0].location).toContain(p);
  });

  it("returns a schema error when required `version` is missing", async () => {
    const p = writeYaml(
      "missing-version.yaml",
      "owned:\n  api:\n    cmd: bun run dev\n"
    );

    const result = await parseConfig(p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    const schemaErrs = result.errors.filter((e) => e.kind === "schema");
    expect(schemaErrs.length).toBeGreaterThan(0);
    expect(
      schemaErrs.some((e) => /version/i.test(e.message))
    ).toBe(true);
  });

  it("surfaces multiple schema errors at once", async () => {
    // Two distinct violations:
    //   1. `version` is the wrong type (number, must be string)
    //   2. unknown top-level key `not_a_real_section`
    const p = writeYaml(
      "two-bad.yaml",
      ["version: 1", "not_a_real_section:", "  foo: bar"].join("\n") + "\n"
    );

    const result = await parseConfig(p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const schemaErrs = result.errors.filter((e) => e.kind === "schema");
    expect(schemaErrs.length).toBeGreaterThanOrEqual(2);

    // The version type error should mention /version.
    expect(
      schemaErrs.some(
        (e) => /version/i.test(e.message) && /string/i.test(e.message)
      )
    ).toBe(true);

    // The unknown-key error should mention the offending property.
    expect(
      schemaErrs.some((e) => /not_a_real_section/.test(e.message))
    ).toBe(true);
  });

  it("includes a useful schema message for nested violations", async () => {
    // owned.api.cmd has the wrong type — should produce
    // "/owned/api/cmd must be string" (or similar).
    const p = writeYaml(
      "bad-cmd.yaml",
      ["version: \"1\"", "owned:", "  api:", "    cmd: 42"].join("\n") + "\n"
    );

    const result = await parseConfig(p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const schemaErrs = result.errors.filter((e) => e.kind === "schema");
    expect(schemaErrs.length).toBeGreaterThan(0);
    expect(
      schemaErrs.some(
        (e) =>
          e.message.includes("/owned/api/cmd") &&
          /string/i.test(e.message)
      )
    ).toBe(true);
  });

  it("LichConfig types compile through the parse result", async () => {
    // This test exists mostly so the TS compiler verifies the types from
    // ./types.ts are usable in a real consumer. If the types regress, this
    // test will fail to compile and `bun test` will surface it.
    const result = await parseConfig(DOGFOOD_YAML);
    if (!result.ok) {
      expect.fail("expected dogfood yaml to parse");
      return;
    }
    const config: LichConfig = result.config;
    const services: LichConfig["services"] = config.services;
    const owned: LichConfig["owned"] = config.owned;

    // Post-LEV-463/LEV-477: dogfood yaml declares an inline `postgres`
    // compose service. Both blocks should be defined.
    expect(services).toBeDefined();
    expect(owned).toBeDefined();
    // The assignment-itself is the type check; runtime assertions just keep
    // vitest from skipping the test as empty.
    expect(typeof config.version).toBe("string");
  });
});
