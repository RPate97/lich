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

  // -------------------------------------------------------------------------
  // Plan-4 (LEV-361) Task 12: ${owned.X.captured.Y} reference validation
  //
  // The earlier "deferral" message (LEV-337) was a stub — this task
  // replaces it with real validation against declared captures.
  // -------------------------------------------------------------------------

  it("accepts ${owned.X.captured.Y} when X.ready_when.capture declares Y", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  TOKEN: "\${owned.api.captured.AUTH_TOKEN}"\n` +
        `owned:\n` +
        `  api:\n` +
        `    cmd: echo hi\n` +
        `    ready_when:\n` +
        `      log_match: "started"\n` +
        `      capture:\n` +
        `        AUTH_TOKEN: "token=([a-z0-9]+)"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const ies = (res.report.errors ?? []).filter((e) => e.kind === "interp");
    expect(ies).toEqual([]);
  });

  it("flags ${owned.X.captured.Y} when X.ready_when.capture doesn't declare Y", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  TOKEN: "\${owned.api.captured.MISSING}"\n` +
        `owned:\n` +
        `  api:\n` +
        `    cmd: echo hi\n` +
        `    ready_when:\n` +
        `      log_match: "started"\n` +
        `      capture:\n` +
        `        AUTH_TOKEN: "token=([a-z0-9]+)"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
    expect(ie!.message).toContain("unknown capture");
    expect(ie!.message).toContain('"MISSING"');
    expect(ie!.message).toContain('"api"');
  });

  it("suggests close-match capture key on typo", async () => {
    // `auth_tokn` is one edit away from `auth_token` -> Levenshtein
    // surfaces it. Exercises the `did you mean` branch shared with
    // other reference checks.
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  TOKEN: "\${owned.api.captured.auth_tokn}"\n` +
        `owned:\n` +
        `  api:\n` +
        `    cmd: echo hi\n` +
        `    ready_when:\n` +
        `      log_match: "started"\n` +
        `      capture:\n` +
        `        auth_token: "token=([a-z0-9]+)"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
    expect(ie!.message).toContain('"auth_tokn"');
    expect(ie!.message).toContain("did you mean");
    expect(ie!.message).toContain('"auth_token"');
  });

  it("flags ${owned.X.captured.Y} when X doesn't declare ready_when.capture at all", async () => {
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
    expect(ie!.message).toContain("does not declare");
    expect(ie!.message).toContain("ready_when.capture");
    expect(ie!.message).toContain('"api"');
  });

  it("flags ${owned.X.captured.Y} when X is not a declared owned service", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  TOKEN: "\${owned.ghost.captured.AUTH_TOKEN}"\n` +
        `owned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const ie = res.report.errors!.find((e) => e.kind === "interp");
    expect(ie).toBeDefined();
    expect(ie!.message).toContain("unknown owned service");
    expect(ie!.message).toContain('"ghost"');
    // Levenshtein-based suggestion for the close typo `ghost` -> `api`?
    // The names are too far apart — no `did you mean`. Skip that assert.
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

  // -------------------------------------------------------------------------
  // LEV-334 (Plan 2 Task 14): user commands shadowing built-ins
  // -------------------------------------------------------------------------

  it("refuses a user command named 'up'", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `commands:\n  up:\n    cmd: "echo nope"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const shadowErr = res.report.errors!.find((e) => e.kind === "shadow");
    expect(shadowErr).toBeDefined();
    expect(shadowErr!.message).toContain("commands.up");
    expect(shadowErr!.message).toContain("'lich up'");
    expect(shadowErr!.message).toContain("'up:run'");
  });

  it("refuses a user command named 'validate'", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `commands:\n  validate:\n    cmd: "echo nope"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const shadowErr = res.report.errors!.find((e) => e.kind === "shadow");
    expect(shadowErr).toBeDefined();
    expect(shadowErr!.message).toContain("commands.validate");
    expect(shadowErr!.message).toContain("'lich validate'");
  });

  it("accepts user commands with `:` separators that don't collide with built-ins", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `commands:\n` +
        `  up:run:\n    cmd: "echo run"\n` +
        `  tools:env-check:\n    cmd: "printenv"\n` +
        `  db:psql:\n    cmd: "psql"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
  });

  it("accepts a command named 'test:e2e' (from dogfood-stack)", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `commands:\n  test:e2e:\n    cmd: "echo running e2e"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
  });

  it("reports every shadowing user command (multiple offenders)", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `commands:\n` +
        `  up:\n    cmd: "echo a"\n` +
        `  down:\n    cmd: "echo b"\n` +
        `  test:e2e:\n    cmd: "echo ok"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const shadowErrs = res.report.errors!.filter((e) => e.kind === "shadow");
    // Two shadowing entries, one accepted entry -> two shadow errors.
    expect(shadowErrs).toHaveLength(2);
    const names = shadowErrs.map((e) => e.message).join("\n");
    expect(names).toContain("commands.up");
    expect(names).toContain("commands.down");
    expect(names).not.toContain("commands.test:e2e");
  });

  // -------------------------------------------------------------------------
  // env_groups extends cycle detection (Plan 2 Task 15 — LEV-335)
  // -------------------------------------------------------------------------

  it("detects a 2-node env_groups extends cycle", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `env_groups:\n` +
        `  a:\n    extends: b\n    env:\n      X: "1"\n` +
        `  b:\n    extends: a\n    env:\n      Y: "2"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const cycErr = res.report.errors!.find(
      (e) => e.kind === "cycle" && e.message.includes("env_groups extends"),
    );
    expect(cycErr).toBeDefined();
    // Closed-walk format mirrors depends_on cycles (start node repeated).
    expect(cycErr!.message).toMatch(/a → b → a|b → a → b/);
  });

  it("detects a self-loop in env_groups extends", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `env_groups:\n` +
        `  loop:\n    extends: loop\n    env:\n      X: "1"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const cycErr = res.report.errors!.find(
      (e) => e.kind === "cycle" && e.message.includes("env_groups extends"),
    );
    expect(cycErr).toBeDefined();
    expect(cycErr!.message).toContain("loop → loop");
  });

  it("accepts env_groups extends chains that terminate", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `env_groups:\n` +
        `  base:\n    env:\n      BASE: "1"\n` +
        `  middle:\n    extends: base\n    env:\n      MID: "2"\n` +
        `  leaf:\n    extends: middle\n    env:\n      LEAF: "3"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const cycErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "cycle",
    );
    expect(cycErrs).toEqual([]);
  });

  it("accepts env_groups with extends: stack (built-in terminator)", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `env_groups:\n` +
        `  derived:\n    extends: stack\n    env:\n      DERIVED: "1"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const cycErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "cycle",
    );
    expect(cycErrs).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // env_group reference resolution (Plan 2 Task 16 — LEV-336)
  // -------------------------------------------------------------------------

  it("refuses commands.X.env_group pointing at undeclared group", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `commands:\n` +
        `  foo:\n    cmd: echo bar\n    env_group: ghost\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('env_group "ghost"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("not declared");
    expect(refErr!.location).toContain("/commands/foo/env_group");
  });

  it("refuses lifecycle.after_up entry env_group pointing at undeclared group", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `lifecycle:\n` +
        `  after_up:\n` +
        `    - cmd: "./scripts/sync.sh"\n` +
        `      env_group: missing\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('env_group "missing"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.location).toContain("/lifecycle/after_up/0/env_group");
  });

  it("refuses owned.svc.lifecycle entry env_group pointing at undeclared group", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n` +
        `    cmd: echo hi\n` +
        `    lifecycle:\n` +
        `      after_ready:\n` +
        `        - cmd: "./scripts/post-start.sh"\n` +
        `          env_group: nope\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('env_group "nope"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.location).toContain(
      "/owned/api/lifecycle/after_ready/0/env_group",
    );
  });

  it("refuses env_groups.X.extends pointing at undeclared group", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `env_groups:\n` +
        `  child:\n` +
        `    extends: nonexistent\n` +
        `    env:\n      K: v\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('env_group "nonexistent"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.location).toContain("/env_groups/child/extends");
  });

  it("accepts env_group: stack universally (built-in is always valid)", async () => {
    // Verify across all four surfaces: commands, top-level lifecycle,
    // per-service lifecycle, and env_groups.extends — even with NO
    // env_groups: section declared at all.
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n` +
        `    cmd: echo hi\n` +
        `    lifecycle:\n` +
        `      after_ready:\n` +
        `        - cmd: "./scripts/post-start.sh"\n` +
        `          env_group: stack\n` +
        `lifecycle:\n` +
        `  after_up:\n` +
        `    - cmd: "./scripts/migrate.sh"\n` +
        `      env_group: stack\n` +
        `commands:\n` +
        `  foo:\n    cmd: echo bar\n    env_group: stack\n` +
        `env_groups:\n` +
        `  derived:\n    extends: stack\n    env:\n      K: v\n`,
    );
    const res = await run({ path: p });
    // No env_group ref errors should appear (other categories may still emit;
    // but our `ref` errors should not mention env_group).
    const envGroupRefErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "ref" && e.message.includes("env_group"),
    );
    expect(envGroupRefErrs).toEqual([]);
    expect(res.exitCode).toBe(0);
  });

  it("suggests close-match names on typo", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `env_groups:\n` +
        `  "infisical-prod":\n` +
        `    env:\n      SECRET: shh\n` +
        `commands:\n` +
        `  sync:\n` +
        `    cmd: "./scripts/sync.sh"\n` +
        `    env_group: "infisical-prdo"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"infisical-prdo"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("infisical-prod");
    expect(refErr!.message).toContain("did you mean");
  });

  it("resolves env_group references to user-declared groups (no error)", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `env_groups:\n` +
        `  isolated-tools:\n` +
        `    env:\n      TOOL_MODE: standalone\n` +
        `commands:\n` +
        `  check:\n` +
        `    cmd: "printenv TOOL_MODE"\n` +
        `    env_group: isolated-tools\n`,
    );
    const res = await run({ path: p });
    const envGroupRefErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "ref" && e.message.includes("env_group"),
    );
    expect(envGroupRefErrs).toEqual([]);
    expect(res.exitCode).toBe(0);
  });

  it("reports every unresolved env_group reference across all surfaces", async () => {
    // Sanity-check: when multiple surfaces have bad refs, every one is
    // reported (we don't short-circuit on the first error).
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n` +
        `    cmd: echo hi\n` +
        `    lifecycle:\n` +
        `      after_ready:\n` +
        `        - cmd: x\n          env_group: ghostA\n` +
        `lifecycle:\n` +
        `  after_up:\n` +
        `    - cmd: y\n      env_group: ghostB\n` +
        `commands:\n` +
        `  foo:\n    cmd: z\n    env_group: ghostC\n` +
        `env_groups:\n` +
        `  child:\n    extends: ghostD\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "ref" && e.message.includes("env_group"),
    );
    // All four bad refs should be flagged.
    expect(refErrs.length).toBe(4);
    const flagged = refErrs.map((e) => e.message).join(" | ");
    expect(flagged).toContain('"ghostA"');
    expect(flagged).toContain('"ghostB"');
    expect(flagged).toContain('"ghostC"');
    expect(flagged).toContain('"ghostD"');
  });
});
