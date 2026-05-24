import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  runValidate,
  type JsonReport,
  type ValidationError,
} from "../../../src/commands/validate.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const DOGFOOD_YAML = resolve(
  __dirname,
  "../../../../../examples/dogfood-stack/lich.yaml",
);

let tmp: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-validate-test-"));
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body, "utf8");
  return p;
}

async function run(opts: {
  path?: string;
  json?: boolean;
  cwd?: string;
} = {}) {
  return runValidate({
    ...opts,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runValidate", () => {
  it("validates the dogfood-stack lich.yaml cleanly (exit 0)", async () => {
    const res = await run({ path: DOGFOOD_YAML });
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
    expect(res.report.path).toBe(DOGFOOD_YAML);
    expect(res.report.summary).toBeDefined();
    expect(res.report.summary?.owned).toBe(3);
    expect(res.report.summary?.compose).toBe(0);
  });

  it("dogfood-stack validates cleanly via --json with the documented shape", async () => {
    const res = await run({ path: DOGFOOD_YAML, json: true });
    expect(res.exitCode).toBe(0);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]) as JsonReport;
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(DOGFOOD_YAML);
    expect(parsed.summary).toBeDefined();
    expect(parsed.errors).toBeUndefined();
  });

  it("prints a pretty checkmark + summary on success", async () => {
    const res = await run({ path: DOGFOOD_YAML });
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("✓");
    expect(out).toContain(DOGFOOD_YAML);
    expect(out).toMatch(/owned service/);
  });

  // -------------------------------------------------------------------------
  // Missing / bad path
  // -------------------------------------------------------------------------

  it("returns exit 1 with an io error when the file is missing", async () => {
    const missing = join(tmp, "nope.yaml");
    const res = await run({ path: missing });
    expect(res.exitCode).toBe(1);
    expect(res.report.ok).toBe(false);
    const errs = res.report.errors!;
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].kind).toBe("io");
    expect(errs[0].message).toContain(missing);
  });

  it("treats a directory argument as 'find lich.yaml inside'", async () => {
    const sub = join(tmp, "stack");
    mkdirSync(sub);
    writeFileSync(
      join(sub, "lich.yaml"),
      `version: "1"\nowned:\n  api:\n    cmd: echo hi\n`,
      "utf8",
    );
    const res = await run({ path: sub });
    expect(res.exitCode).toBe(0);
    expect(res.report.path).toBe(join(sub, "lich.yaml"));
  });

  it("defaults to lich.yaml in cwd when no path is provided", async () => {
    writeFileSync(
      join(tmp, "lich.yaml"),
      `version: "1"\nowned:\n  api:\n    cmd: echo hi\n`,
      "utf8",
    );
    const res = await run({ cwd: tmp });
    expect(res.exitCode).toBe(0);
    expect(res.report.path).toBe(join(tmp, "lich.yaml"));
  });

  // -------------------------------------------------------------------------
  // Schema errors
  // -------------------------------------------------------------------------

  it("returns a schema error when version is a number instead of a string", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: 1\nowned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const errs = res.report.errors!;
    const schemaErr = errs.find((e) => e.kind === "schema");
    expect(schemaErr).toBeDefined();
    expect(schemaErr!.message).toContain("/version");
  });

  it("returns a schema error for an unknown top-level property", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nbogus_section: true\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const errs = res.report.errors!;
    expect(errs.some((e) => e.kind === "schema")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // depends_on reference errors
  // -------------------------------------------------------------------------

  it("flags a depends_on target that isn't declared", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n` +
        `  api:\n    cmd: echo hi\n    depends_on: [ap]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find((e) => e.kind === "ref");
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain('"ap"');
  });

  it("allows cross-kind depends_on (owned -> compose) when both exist", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `services:\n  postgres:\n    image: postgres:16\n` +
        `owned:\n  api:\n    cmd: echo hi\n    depends_on: [postgres]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Cycles
  // -------------------------------------------------------------------------

  it("flags a cycle in depends_on", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n` +
        `  a:\n    cmd: echo a\n    depends_on: [b]\n` +
        `  b:\n    cmd: echo b\n    depends_on: [a]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const cycErr = res.report.errors!.find((e) => e.kind === "cycle");
    expect(cycErr).toBeDefined();
    expect(cycErr!.message).toMatch(/a.*b.*a|b.*a.*b/);
  });

  // -------------------------------------------------------------------------
  // Regex
  // -------------------------------------------------------------------------

  it("flags an invalid ready_when.log_match regex", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `    ready_when:\n      log_match: "[unclosed"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const rxErr = res.report.errors!.find((e) => e.kind === "regex");
    expect(rxErr).toBeDefined();
    expect(rxErr!.message).toContain("[unclosed");
  });

  it("flags an invalid fail_when.log_match regex", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `    fail_when:\n      log_match: "*bad"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const rxErr = res.report.errors!.find((e) => e.kind === "regex");
    expect(rxErr).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Interpolation
  // -------------------------------------------------------------------------

  it("flags a ${owned.X.port} reference to a nonexistent owned service", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  FOO: "http://localhost:\${owned.nonexistent.port}"\n` +
        `owned:\n  api:\n    cmd: echo hi\n    port: { env: PORT }\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
    expect(ie!.message).toContain("nonexistent");
  });

  it("flags an unsupported reference shape", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  FOO: "\${bogus.thing}"\n` +
        `owned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
  });

  it("flags a single-port reference when the service uses multi-port", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  FOO: "\${owned.supabase.port}"\n` +
        `owned:\n  supabase:\n    cmd: supabase start\n    ports:\n      api: { env: SUPA_API }\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
    expect(ie!.message).toContain("multi-port");
  });

  it("flags a ports.<key> reference where the key isn't declared", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  FOO: "\${owned.supabase.ports.nope}"\n` +
        `owned:\n  supabase:\n    cmd: supabase start\n    ports:\n      api: { env: SUPA_API }\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
    expect(ie!.message).toContain("nope");
  });

  it("accepts $$ as a literal $ in env values", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  PRICE: "$$5.00"\n` +
        `owned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
  });

  it("reports a clearer error for ${owned.X.captured.Y} references (Plan 4 feature)", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  TOKEN: "\${owned.api.captured.AUTH_TOKEN}"\n` +
        `owned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
    expect(ie!.message).toContain("Plan-4");
    expect(ie!.message).toContain("failure-surfacing");
    expect(ie!.message).toContain("${owned.api.captured.AUTH_TOKEN}");
    // Includes the list of currently supported reference shapes.
    expect(ie!.message).toContain("worktree.*");
    expect(ie!.message).toContain("services.<name>.host_port");
    expect(ie!.message).toContain("owned.<name>.port");
    expect(ie!.message).toContain("owned.<name>.ports.<key>");
  });

  // -------------------------------------------------------------------------
  // JSON output
  // -------------------------------------------------------------------------

  it("--json on error produces a parseable JSON report with ok:false + errors", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: 1\nowned:\n  a:\n    cmd: echo a\n    depends_on: [b]\n`,
    );
    const res = await run({ path: p, json: true });
    expect(res.exitCode).toBe(1);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]) as JsonReport;
    expect(parsed.ok).toBe(false);
    expect(parsed.path).toBe(p);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors!.length).toBeGreaterThan(0);
    // Each error has the documented shape.
    for (const e of parsed.errors as ValidationError[]) {
      expect(typeof e.kind).toBe("string");
      expect(typeof e.location).toBe("string");
      expect(typeof e.message).toBe("string");
    }
  });

  it("--json on success has no errors field", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p, json: true });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(stdout[0]) as JsonReport;
    expect(parsed.ok).toBe(true);
    expect(parsed.errors).toBeUndefined();
    expect(parsed.summary).toBeDefined();
  });
});
