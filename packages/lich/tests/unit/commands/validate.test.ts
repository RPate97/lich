import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  runValidate,
  type JsonReport,
  type ValidationError,
} from "../../../src/commands/validate.js";

const DOGFOOD_YAML = resolve(
  __dirname,
  "../../../../../packages/e2e/fixtures/dogfood-stack/lich.yaml",
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

describe("runValidate", () => {
  it("validates the dogfood-stack lich.yaml cleanly (exit 0)", async () => {
    const res = await run({ path: DOGFOOD_YAML });
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
    expect(res.report.path).toBe(DOGFOOD_YAML);
    expect(res.report.summary).toBeDefined();
    // 4 owned: api, web, tunnel_demo, health_probe. 1 compose: postgres
    expect(res.report.summary?.owned).toBe(4);
    expect(res.report.summary?.compose).toBe(1);
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
    // ghost → api is too far for Levenshtein "did you mean"
  });

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
    expect(shadowErrs).toHaveLength(2);
    const names = shadowErrs.map((e) => e.message).join("\n");
    expect(names).toContain("commands.up");
    expect(names).toContain("commands.down");
    expect(names).not.toContain("commands.test:e2e");
  });

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

  it("refuses lifecycle.after_down entry env_group pointing at undeclared group", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `lifecycle:\n` +
        `  after_down:\n` +
        `    - cmd: "./scripts/cleanup.sh"\n` +
        `      env_group: nope-ad\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('env_group "nope-ad"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.location).toContain("/lifecycle/after_down/0/env_group");
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
    // covers all four surfaces (commands, top + per-service lifecycle,
    // env_groups.extends) with NO env_groups: section declared
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
    expect(refErrs.length).toBe(4);
    const flagged = refErrs.map((e) => e.message).join(" | ");
    expect(flagged).toContain('"ghostA"');
    expect(flagged).toContain('"ghostB"');
    expect(flagged).toContain('"ghostC"');
    expect(flagged).toContain('"ghostD"');
  });

  it("refuses profiles.X.services entry pointing at undeclared compose service", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `services:\n  postgres:\n    image: postgres:16\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    services: [postgres, redis]\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"redis"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("unknown compose service");
    expect(refErr!.location).toContain("/profiles/dev/services/1");
  });

  it("refuses profiles.X.owned entry pointing at undeclared owned service", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    owned: [api, ghost]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"ghost"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("unknown owned service");
    expect(refErr!.location).toContain("/profiles/dev/owned/1");
  });

  it("suggests close-match owned service name on typo", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  supabase:\n    cmd: supabase start\n` +
        `  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    owned: [supabse, api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"supabse"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("did you mean");
    expect(refErr!.message).toContain('"supabase"');
    expect(refErr!.location).toContain("/profiles/dev/owned/0");
  });

  it("accepts profiles.X with services and owned entries that all resolve", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `services:\n` +
        `  postgres:\n    image: postgres:16\n` +
        `  redis:\n    image: redis:7\n` +
        `owned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `  web:\n    cmd: echo web\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    services: [postgres, redis]\n` +
        `    owned: [api, web]\n` +
        `  lite:\n` +
        `    services: [postgres]\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const profileRefErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "ref" &&
        typeof e.location === "string" &&
        e.location.includes("/profiles/"),
    );
    expect(profileRefErrs).toEqual([]);
  });

  it("flags undeclared compose service reference under a profile", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    services: [ghost-compose]\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"ghost-compose"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("unknown compose service");
    expect(refErr!.location).toContain("/profiles/dev/services/0");
  });

  it("reports every unresolved profile reference across multiple profiles", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `services:\n  postgres:\n    image: postgres:16\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    services: [bogusA]\n` +
        `    owned: [bogusB]\n` +
        `  test:\n` +
        `    services: [bogusC]\n` +
        `    owned: [bogusD]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const profileRefErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "ref" &&
        typeof e.location === "string" &&
        e.location.includes("/profiles/"),
    );
    expect(profileRefErrs.length).toBe(4);
    const flagged = profileRefErrs.map((e) => e.message).join(" | ");
    expect(flagged).toContain('"bogusA"');
    expect(flagged).toContain('"bogusB"');
    expect(flagged).toContain('"bogusC"');
    expect(flagged).toContain('"bogusD"');
  });

  it("emits no profile ref errors when profiles section is absent", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const profileRefErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "ref" &&
        typeof e.location === "string" &&
        e.location.includes("/profiles/"),
    );
    expect(profileRefErrs).toEqual([]);
  });

  it("detects a 2-node profile extends cycle", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  a:\n    extends: b\n    owned: [api]\n` +
        `  b:\n    extends: a\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const cycErr = res.report.errors!.find(
      (e) => e.kind === "cycle" && e.message.includes("profiles extends"),
    );
    expect(cycErr).toBeDefined();
    expect(cycErr!.message).toMatch(/a → b → a|b → a → b/);
  });

  it("detects a self-loop in profile extends", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  loop:\n    extends: loop\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const cycErr = res.report.errors!.find(
      (e) => e.kind === "cycle" && e.message.includes("profiles extends"),
    );
    expect(cycErr).toBeDefined();
    expect(cycErr!.message).toContain("loop → loop");
  });

  it("accepts profile extends chains that terminate", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  root:\n    owned: [api]\n` +
        `  base:\n    extends: root\n    owned: [api]\n` +
        `  dev:\n    extends: base\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const cycErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "cycle",
    );
    expect(cycErrs).toEqual([]);
  });

  it("refuses profiles.X.extends pointing at undeclared profile", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    extends: missing-base\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"missing-base"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("extends unknown profile");
    expect(refErr!.location).toContain("/profiles/dev/extends");
    // single-string form has no index suffix
    expect(refErr!.location).not.toContain("/extends/");
  });

  it("refuses profiles.X.extends array entries pointing at undeclared profiles", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  base:\n    owned: [api]\n` +
        `  dev:\n` +
        `    extends: [base, ghost]\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"ghost"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("extends unknown profile");
    expect(refErr!.location).toContain("/profiles/dev/extends/1");
    const baseRefErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"base"'),
    );
    expect(baseRefErr).toBeUndefined();
  });

  it("suggests close-match profile name on extends typo", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  base-stack:\n    owned: [api]\n` +
        `  dev:\n` +
        `    extends: base-stck\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const refErr = res.report.errors!.find(
      (e) => e.kind === "ref" && e.message.includes('"base-stck"'),
    );
    expect(refErr).toBeDefined();
    expect(refErr!.message).toContain("did you mean");
    expect(refErr!.message).toContain('"base-stack"');
  });

  it("accepts profiles.X.extends pointing at a declared profile", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  base:\n    owned: [api]\n` +
        `  dev:\n    extends: base\n` +
        `    default: true\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const refErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "ref" &&
        typeof e.location === "string" &&
        e.location.includes("/extends"),
    );
    expect(refErrs).toEqual([]);
  });

  it("refuses two profiles with default: true", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  alpha:\n    default: true\n    owned: [api]\n` +
        `  beta:\n    default: true\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const schemaErr = res.report.errors!.find(
      (e) =>
        e.kind === "schema" &&
        e.message.includes("multiple profiles set default: true"),
    );
    expect(schemaErr).toBeDefined();
    expect(schemaErr!.message).toContain("alpha, beta");
  });

  it("accepts a config with exactly one default: true profile", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n    default: true\n    owned: [api]\n` +
        `  test:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const schemaErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "schema" &&
        e.message.includes("multiple profiles set default"),
    );
    expect(schemaErrs).toEqual([]);
  });

  it("accepts a config with zero profiles setting default: true", async () => {
    // pickDefaultProfile returns null; `lich up`'s call site decides if fatal
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n    owned: [api]\n` +
        `  test:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
  });

  it("emits warning for compose service not in any profile", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `services:\n` +
        `  postgres:\n    image: postgres:16\n` +
        `  redis:\n    image: redis:7\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    services: [postgres]\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0].message).toContain('"redis"');
    expect(warnings[0].message).toContain("not included by any profile");
    expect(warnings[0].location).toContain("/services/redis");
  });

  it("emits warning for owned service not in any profile", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `  worker:\n    cmd: echo work\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0].message).toContain('"worker"');
    expect(warnings[0].message).toContain("not included by any profile");
    expect(warnings[0].location).toContain("/owned/worker");
  });

  it("treats services as USED when included via an extends chain", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  base:\n    owned: [api]\n` +
        `  dev:\n    extends: base\n    default: true\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    expect(warnings).toEqual([]);
  });

  it("does not warn when no profiles section exists (every service implicitly always-on)", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `services:\n  postgres:\n    image: postgres:16\n` +
        `owned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    expect(warnings).toEqual([]);
  });

  it("does not warn when profiles section is empty", async () => {
    // Schema accepts an empty profiles map (additionalProperties on a {}).
    // The check skips when there are no profile entries to walk.
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles: {}\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    expect(warnings).toEqual([]);
  });

  it("exit code is 0 when only warnings are present", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `  orphan:\n    cmd: echo orphan\n` +
        `profiles:\n` +
        `  dev:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    expect(warnings.length).toBe(1);
  });

  it("warnings appear in --json output under errors[] with kind 'warning'", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `  orphan:\n    cmd: echo orphan\n` +
        `profiles:\n` +
        `  dev:\n    owned: [api]\n`,
    );
    const res = await run({ path: p, json: true });
    expect(res.exitCode).toBe(0);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]) as JsonReport;
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors!.length).toBe(1);
    expect(parsed.errors![0].kind).toBe("warning");
    expect(parsed.errors![0].message).toContain('"orphan"');
  });

  it("renders warnings with `!` prefix in pretty output", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `  orphan:\n    cmd: echo orphan\n` +
        `profiles:\n` +
        `  dev:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    const errOut = stderr.join("\n");
    expect(out).toContain("✓");
    // strip ANSI color codes — warning prefix is `!` literal
    const stripped = errOut.replace(/\x1b\[\d+m/g, "");
    expect(stripped).toContain("! ");
    expect(stripped).toContain('"orphan"');
    expect(stripped).toContain("/owned/orphan");
  });

  it("emits both compose and owned warnings together when multiple are unused", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `services:\n` +
        `  postgres:\n    image: postgres:16\n` +
        `  redis:\n    image: redis:7\n` +
        `owned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `  worker:\n    cmd: echo work\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    services: [postgres]\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    expect(warnings.length).toBe(2);
    const flagged = warnings.map((w) => w.message).join(" | ");
    expect(flagged).toContain('"redis"');
    expect(flagged).toContain('"worker"');
  });

  it("hard errors still fail when warnings are also present", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `  orphan:\n    cmd: echo orphan\n` +
        `profiles:\n` +
        `  dev:\n    extends: ghost\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    expect(res.report.ok).toBe(false);
    const warnings = (res.report.errors ?? []).filter(
      (e) => e.kind === "warning",
    );
    const refErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "ref",
    );
    expect(warnings.length).toBe(1);
    expect(refErrs.length).toBeGreaterThan(0);
  });

  it("guards against cycles in extends during unused-services walk", async () => {
    // contract: unused-services walk doesn't blow the stack on cyclic config
    // (cycle members count as "using" each other's services)
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  a:\n    extends: b\n    owned: [api]\n` +
        `  b:\n    extends: a\n`,
    );
    const res = await run({ path: p });
    expect(typeof res.exitCode).toBe("number");
    const apiWarn = (res.report.errors ?? []).find(
      (e) => e.kind === "warning" && e.message.includes('"api"'),
    );
    expect(apiWarn).toBeUndefined();
  });

  // per-profile interpolation simulation: drives the engine against a
  // synthetic context that lists ONLY services in the profile's resolved
  // set. Structural failures (refs to undeclared services) are deduped
  // against the top-level check rather than double-reported.

  it("profile that overrides a top-level value avoids the top-level's bad ref", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n` +
        `  DATABASE_URL: "postgresql://localhost:\${owned.supabase.port}/x"\n` +
        `owned:\n` +
        `  supabase:\n    cmd: supabase start\n    port: { env: SUPA }\n` +
        `  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n` +
        `    owned: [api]\n` +
        `    env:\n` +
        `      DATABASE_URL: "postgresql://hosted.example.com:5432/x"\n`,
    );
    const res = await run({ path: p });
    const profileInterpErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "interp" &&
        typeof e.location === "string" &&
        e.location.includes("/profiles/dev/"),
    );
    expect(profileInterpErrs).toEqual([]);
    const inheritedErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "interp" &&
        typeof e.location === "string" &&
        e.location.includes("(/env/DATABASE_URL)"),
    );
    expect(inheritedErrs).toEqual([]);
  });

  it("profile that does NOT override is flagged when top-level value refs a service not in profile's resolved set", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n` +
        `  DATABASE_URL: "postgresql://localhost:\${owned.supabase.port}/x"\n` +
        `owned:\n` +
        `  supabase:\n    cmd: supabase start\n    port: { env: SUPA }\n` +
        `  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  lite:\n` +
        `    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const interpErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    const inheritedErr = interpErrs.find(
      (e) =>
        typeof e.location === "string" &&
        e.location.includes("(/env/DATABASE_URL)") &&
        e.message.includes('under profile "lite"'),
    );
    expect(inheritedErr).toBeDefined();
    expect(inheritedErr!.message).toContain("supabase");
  });

  it("top-level interp check still flags refs to services not declared anywhere", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n` +
        `  X: "\${owned.ghost.port}"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const interpErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp" && e.message.includes("ghost"),
    );
    // exactly one — structural check fires; per-profile dedupes
    expect(interpErrs.length).toBe(1);
    expect(interpErrs[0].location).toContain("(/env/X)");
    expect(interpErrs[0].message).not.toContain('under profile "');
  });

  it("per-profile interp catches refs to services not in profile's services/owned", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  supabase:\n    cmd: supabase start\n    port: { env: SUPA }\n` +
        `  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  test:\n` +
        `    owned: [api]\n` +
        `    env:\n` +
        `      X: "\${owned.supabase.port}"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const interpErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    const profileErr = interpErrs.find(
      (e) =>
        typeof e.location === "string" &&
        e.location.includes("/profiles/test/env/X"),
    );
    expect(profileErr).toBeDefined();
    expect(profileErr!.message).toContain('under profile "test"');
    expect(profileErr!.message).toContain("supabase");
  });

  it("does not run per-profile interp sim when profiles section is absent", async () => {
    // No profiles -> no per-profile pass. The existing top-level check
    // still runs (and catches its own kinds of failure).
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  Y: "\${owned.api.port}"\n` +
        `owned:\n  api:\n    cmd: echo hi\n    port: { env: PORT }\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const profileInterpErrs = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "interp" && e.message.includes('under profile "'),
    );
    expect(profileInterpErrs).toEqual([]);
  });

  it("accepts a top-level ref to a service the profile includes", async () => {
    // Top-level DATABASE_URL refs `${owned.api.port}`; `dev` profile
    // resolved set includes `api`. The reference resolves under the
    // profile context — no error.
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n  DATABASE_URL: "postgresql://localhost:\${owned.api.port}/x"\n` +
        `owned:\n  api:\n    cmd: echo hi\n    port: { env: PORT }\n` +
        `profiles:\n  dev:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const profileInterpErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    expect(profileInterpErrs).toEqual([]);
  });

  it("checks references against the resolved set (extends chain)", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n` +
        `  DATABASE_URL: "postgresql://localhost:\${owned.supabase.port}/x"\n` +
        `owned:\n` +
        `  supabase:\n    cmd: supabase start\n    port: { env: SUPA }\n` +
        `  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  base:\n    owned: [supabase]\n` +
        `  dev:\n    extends: base\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const interpErrs = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    expect(interpErrs).toEqual([]);
  });

  it("emits a separate per-profile error for each profile that excludes the referenced service", async () => {
    // two profiles → two distinct entries so consumers can tell which context failed
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `env:\n` +
        `  DATABASE_URL: "postgresql://localhost:\${owned.supabase.port}/x"\n` +
        `owned:\n` +
        `  supabase:\n    cmd: supabase start\n    port: { env: SUPA }\n` +
        `  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  lite:\n    owned: [api]\n` +
        `  lean:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const profileScoped = (res.report.errors ?? []).filter(
      (e) =>
        e.kind === "interp" &&
        e.message.includes('under profile "') &&
        e.message.includes("supabase"),
    );
    expect(profileScoped.length).toBe(2);
    const profiles = profileScoped.map((e) =>
      e.message.match(/under profile "([^"]+)"/u)![1],
    );
    expect(profiles.sort()).toEqual(["lean", "lite"]);
  });

  it("flags a multi-port profile-only env ref to an excluded service", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n` +
        `  supabase:\n` +
        `    cmd: supabase start\n` +
        `    ports:\n      api: { env: SUPA_API }\n` +
        `  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  test:\n` +
        `    owned: [api]\n` +
        `    env:\n` +
        `      SUPA_URL: "http://localhost:\${owned.supabase.ports.api}"\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(1);
    const interpErr = (res.report.errors ?? []).find(
      (e) =>
        e.kind === "interp" &&
        typeof e.location === "string" &&
        e.location.includes("/profiles/test/env/SUPA_URL") &&
        e.message.includes('under profile "test"'),
    );
    expect(interpErr).toBeDefined();
    expect(interpErr!.message).toContain("supabase");
  });

  it("summary includes profile count for the dogfood yaml", async () => {
    // dogfood declares 4 profiles: dev:fast (default), dev, dev:lite, dev:env-override
    const res = await run({ path: DOGFOOD_YAML });
    expect(res.exitCode).toBe(0);
    expect(res.report.summary).toBeDefined();
    expect(res.report.summary?.profiles).toBe(4);
  });

  it("summary.profiles is 0 when no profiles section is defined", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    expect(res.report.summary?.profiles).toBe(0);
  });

  it("--json summary includes profiles count for a yaml with profiles", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n    default: true\n    owned: [api]\n` +
        `  test:\n    owned: [api]\n`,
    );
    const res = await run({ path: p, json: true });
    expect(res.exitCode).toBe(0);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]) as JsonReport;
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary?.profiles).toBe(2);
  });

  it("--json summary includes profiles: 0 when profiles section is absent", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p, json: true });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(stdout[0]) as JsonReport;
    expect(parsed.summary?.profiles).toBe(0);
  });

  it("pretty output renders 'N profile(s)' line when profiles defined", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n    default: true\n    owned: [api]\n` +
        `  test:\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("✓");
    expect(out).toMatch(/•\s+2 profiles/);
  });

  it("pretty output uses singular 'profile' when exactly one declared", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\n` +
        `owned:\n  api:\n    cmd: echo hi\n` +
        `profiles:\n` +
        `  dev:\n    default: true\n    owned: [api]\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toMatch(/•\s+1 profile\b/);
    expect(out).not.toMatch(/•\s+1 profiles/);
  });

  it("pretty output omits the profiles line when no profiles defined", async () => {
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n  api:\n    cmd: echo hi\n`,
    );
    const res = await run({ path: p });
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("✓");
    expect(out).toMatch(/owned service/);
    expect(out).not.toMatch(/profile\(s\)/);
    expect(out).not.toMatch(/•\s+\d+\s+profile/);
  });

  describe("did-you-mean integration", () => {
    it("ready_when.port_open: 5432 surfaces a message mentioning tcp", async () => {
      // port_open → tcp is too far for did-you-mean; valid-keys fallback lists tcp
      const p = writeYaml(
        "lich.yaml",
        [
          'version: "1"',
          "owned:",
          "  api:",
          "    cmd: echo hi",
          "    ready_when:",
          "      port_open: 5432",
        ].join("\n") + "\n",
      );
      const res = await run({ path: p });
      expect(res.exitCode).toBe(1);
      const ap = (res.report.errors ?? []).find((e) =>
        /port_open/.test(e.message),
      );
      expect(ap).toBeDefined();
      expect(ap!.message).toContain("tcp");
    });

    it("close typo on a property name produces a did-you-mean hint", async () => {
      const p = writeYaml(
        "lich.yaml",
        [
          'version: "1"',
          "owned:",
          "  api:",
          "    cmd: echo hi",
          "    ready_when:",
          '      log_mtch: "ready"',
        ].join("\n") + "\n",
      );
      const res = await run({ path: p });
      expect(res.exitCode).toBe(1);
      const ap = (res.report.errors ?? []).find((e) =>
        /log_mtch/.test(e.message),
      );
      expect(ap).toBeDefined();
      expect(ap!.message).toContain("did you mean");
      expect(ap!.message).toContain('"log_match"');
    });

    it("wholly unrelated unknown property does NOT trigger a hint", async () => {
      const p = writeYaml(
        "lich.yaml",
        ['version: "1"', "frob:", "  bar: baz"].join("\n") + "\n",
      );
      const res = await run({ path: p });
      expect(res.exitCode).toBe(1);
      const ap = (res.report.errors ?? []).find((e) =>
        /frob/.test(e.message),
      );
      expect(ap).toBeDefined();
      expect(ap!.message).not.toContain("did you mean");
    });
  });
});
