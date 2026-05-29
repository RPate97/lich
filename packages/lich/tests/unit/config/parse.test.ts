import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseConfig } from "../../../src/config/parse.js";
import type { LichConfig, OwnedService } from "../../../src/config/types.js";

const DOGFOOD_YAML = resolve(
  __dirname,
  "../../../../../packages/e2e/fixtures/dogfood-stack/lich.yaml"
);

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

describe("parseConfig", () => {
  it("parses the dogfood-stack lich.yaml successfully", async () => {
    const result = await parseConfig(DOGFOOD_YAML);

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS

    expect(result.sourcePath).toBe(DOGFOOD_YAML);
    expect(result.config.version).toBe("1");

    expect(result.config.owned).toBeDefined();
    expect(Object.keys(result.config.owned!).sort()).toEqual([
      "api",
      "health_probe",
      "tunnel_demo",
      "web",
    ]);

    expect(result.config.services).toBeDefined();
    expect(Object.keys(result.config.services!).sort()).toEqual(["postgres"]);

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
      ["version: \"1\"", "owned:", "  key: [unclosed"].join("\n") + "\n"
    );

    const result = await parseConfig(p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.kind === "yaml")).toBe(true);
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
    // version: number (wrong type) + unknown top-level key
    const p = writeYaml(
      "two-bad.yaml",
      ["version: 1", "not_a_real_section:", "  foo: bar"].join("\n") + "\n"
    );

    const result = await parseConfig(p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const schemaErrs = result.errors.filter((e) => e.kind === "schema");
    expect(schemaErrs.length).toBeGreaterThanOrEqual(2);

    expect(
      schemaErrs.some(
        (e) => /version/i.test(e.message) && /string/i.test(e.message)
      )
    ).toBe(true);

    expect(
      schemaErrs.some((e) => /not_a_real_section/.test(e.message))
    ).toBe(true);
  });

  it("includes a useful schema message for nested violations", async () => {
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
    // load-bearing: the type assignments are the test (compile-time)
    const result = await parseConfig(DOGFOOD_YAML);
    if (!result.ok) {
      expect.fail("expected dogfood yaml to parse");
      return;
    }
    const config: LichConfig = result.config;
    const services: LichConfig["services"] = config.services;
    const owned: LichConfig["owned"] = config.owned;

    expect(services).toBeDefined();
    expect(owned).toBeDefined();
    expect(typeof config.version).toBe("string");
  });

  describe("additionalProperties hints", () => {
    it("emits a did-you-mean hint for a close-typo key inside ready_when", async () => {
      const p = writeYaml(
        "ready-typo.yaml",
        [
          'version: "1"',
          "owned:",
          "  api:",
          "    cmd: bun run dev",
          "    ready_when:",
          '      log_mtch: "ready"',
        ].join("\n") + "\n"
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const schemaErrs = result.errors.filter((e) => e.kind === "schema");
      const ap = schemaErrs.find((e) => /log_mtch/.test(e.message));
      expect(ap).toBeDefined();
      expect(ap!.message).toContain("did you mean");
      expect(ap!.message).toContain('"log_match"');
    });

    it("falls back to a valid-keys list when no candidate is close enough", async () => {
      // port_open → tcp is too far for Levenshtein but valid-keys lists tcp
      const p = writeYaml(
        "port-open.yaml",
        [
          'version: "1"',
          "owned:",
          "  api:",
          "    cmd: bun run dev",
          "    ready_when:",
          "      port_open: 5432",
        ].join("\n") + "\n"
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const schemaErrs = result.errors.filter((e) => e.kind === "schema");
      const ap = schemaErrs.find((e) => /port_open/.test(e.message));
      expect(ap).toBeDefined();
      // No misleading "did you mean" guess — `port_open` and `tcp` are
      // semantically related but lexicographically far apart.
      expect(ap!.message).not.toContain("did you mean");
      // But the user still sees the real allowed keys, `tcp` included.
      expect(ap!.message).toContain("valid:");
      expect(ap!.message).toContain("tcp");
    });

    it("does NOT emit a hint for a wholly unrelated key", async () => {
      // `frob` is not close to ANY top-level key (services, owned, env,
      // commands, profiles, …). The hint must be the silent fall-through
      // valid-keys list — there must be no "did you mean services?" noise.
      const p = writeYaml(
        "unrelated.yaml",
        ['version: "1"', "frob:", "  bar: baz"].join("\n") + "\n"
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const schemaErrs = result.errors.filter((e) => e.kind === "schema");
      const ap = schemaErrs.find((e) => /frob/.test(e.message));
      expect(ap).toBeDefined();
      expect(ap!.message).not.toContain("did you mean");
    });

    it("ties produce a `one of:` rendering", async () => {
      // crd is distance-1 to both cmd AND cwd → tie
      const p = writeYaml(
        "tie.yaml",
        [
          'version: "1"',
          "owned:",
          "  api:",
          "    cmd: bun run dev",
          "    crd: tied",
        ].join("\n") + "\n"
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const schemaErrs = result.errors.filter((e) => e.kind === "schema");
      const ap = schemaErrs.find((e) => /crd/.test(e.message));
      expect(ap).toBeDefined();
      expect(ap!.message).toContain("did you mean one of:");
      expect(ap!.message).toContain("cmd");
      expect(ap!.message).toContain("cwd");
    });
  });

  describe("owned.discover expansion", () => {
    function touch(relPath: string): void {
      const abs = join(tmp, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "// stub\n");
    }

    it("materializes one synthetic owned service per matched file", async () => {
      // non-matching file proves the glob actually filters
      touch("workers/EmailTemporalWorker.ts");
      touch("workers/PaymentTemporalWorker.ts");
      touch("workers/CleanupTemporalWorker.ts");
      touch("workers/index.ts");

      const p = writeYaml(
        "discover.yaml",
        [
          'version: "1"',
          "owned:",
          "  cronjob-workers:",
          "    discover:",
          '      glob: "workers/*TemporalWorker.ts"',
          '      name_template: "${basename_no_ext | strip_suffix:TemporalWorker | kebab}-worker"',
          '      cmd_template: "node ${basename_no_ext}.js"',
          "    ready_when:",
          '      log_match: "Worker created"',
        ].join("\n") + "\n",
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect("cronjob-workers" in result.config.owned!).toBe(false);
      expect(Object.keys(result.config.owned!).sort()).toEqual([
        "cleanup-worker",
        "email-worker",
        "payment-worker",
      ]);
      expect(result.config.owned!["email-worker"].cmd).toBe(
        "node EmailTemporalWorker.js",
      );
      expect(result.config.owned!["email-worker"].ready_when?.log_match).toBe(
        "Worker created",
      );
    });

    it("surfaces a template error as a schema parse error pointing at the offending field", async () => {
      touch("workers/Foo.ts");

      const p = writeYaml(
        "bad-template.yaml",
        [
          'version: "1"',
          "owned:",
          "  ws:",
          "    discover:",
          '      glob: "workers/*.ts"',
          '      name_template: "${basenmae}"',
          '      cmd_template: "node ${basename}"',
        ].join("\n") + "\n",
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].kind).toBe("schema");
      expect(result.errors[0].message).toMatch(/unknown template var/);
      expect(result.errors[0].message).toContain("name_template");
    });

    it("surfaces a name collision (synthetic vs. hand-written) as a schema parse error", async () => {
      touch("workers/api.ts");

      const p = writeYaml(
        "collision.yaml",
        [
          'version: "1"',
          "owned:",
          "  api:",
          "    cmd: bun run dev",
          "  workers:",
          "    discover:",
          '      glob: "workers/*.ts"',
          '      name_template: "${basename_no_ext}"',
          '      cmd_template: "node ${basename}"',
        ].join("\n") + "\n",
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0].kind).toBe("schema");
      expect(result.errors[0].message).toMatch(/collide/i);
    });

    it("rejects a discover block alongside a cmd at the entry root (schema oneOf)", async () => {
      const p = writeYaml(
        "discover-and-cmd.yaml",
        [
          'version: "1"',
          "owned:",
          "  ws:",
          "    cmd: bun run dev",
          "    discover:",
          '      glob: "workers/*.ts"',
          '      name_template: "${basename_no_ext}"',
          '      cmd_template: "node ${basename}"',
        ].join("\n") + "\n",
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.kind === "schema")).toBe(true);
    });

    it("rejects an owned entry with neither cmd nor discover", async () => {
      const p = writeYaml(
        "neither.yaml",
        [
          'version: "1"',
          "owned:",
          "  ws:",
          "    cwd: apps/x",
        ].join("\n") + "\n",
      );

      const result = await parseConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.some((e) => e.kind === "schema")).toBe(true);
    });
  });
});
