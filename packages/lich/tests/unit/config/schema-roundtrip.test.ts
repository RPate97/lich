import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { schema as runtimeSchema } from "../../../src/config/schema.js";

const EMITTED_SCHEMA_PATH = resolve(
  __dirname,
  "../../../schema/v1.json"
);

const DOGFOOD_YAML = resolve(
  __dirname,
  "../../../../../packages/e2e/fixtures/dogfood-stack/lich.yaml"
);

const PUBLIC_SCHEMA_URL =
  "https://raw.githubusercontent.com/RPate97/lich/main/packages/lich/schema/v1.json";

function makeAjv() {
  return new Ajv({ allErrors: true, strict: false });
}

function loadEmittedSchema(): unknown {
  const raw = readFileSync(EMITTED_SCHEMA_PATH, "utf8");
  return JSON.parse(raw);
}

describe("schema/v1.json — emitted JSON Schema", () => {
  it("exists and is valid JSON", () => {
    const text = readFileSync(EMITTED_SCHEMA_PATH, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("advertises the GitHub raw URL as its $id", () => {
    const emitted = loadEmittedSchema() as { $id?: string };
    expect(emitted.$id).toBe(PUBLIC_SCHEMA_URL);
  });

  it("declares JSON Schema Draft 7 (the dialect yaml-language-server expects)", () => {
    const emitted = loadEmittedSchema() as { $schema?: string };
    expect(emitted.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("ajv compiles the emitted schema without error", () => {
    const emitted = loadEmittedSchema();
    expect(() => makeAjv().compile(emitted as object)).not.toThrow();
  });

  it("includes the top-level properties the design spec promises", () => {
    const emitted = loadEmittedSchema() as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(emitted.properties).toBeDefined();
    const required = [
      "version",
      "runtime",
      "services",
      "owned",
      "env",
      "env_files",
      "env_from",
      "env_groups",
      "lifecycle",
      "commands",
      "profiles",
    ];
    for (const prop of required) {
      expect(emitted.properties).toHaveProperty(prop);
    }
    expect(emitted.required).toEqual(["version"]);
  });
});

describe("schema round-trip — runtime + emitted accept the same yaml", () => {
  it("the dogfood-stack lich.yaml passes BOTH the runtime validator and the emitted schema", () => {
    const raw = readFileSync(DOGFOOD_YAML, "utf8");
    const parsed = parseYaml(raw);

    const runtimeValidator = makeAjv().compile(runtimeSchema);
    const emittedValidator = makeAjv().compile(loadEmittedSchema() as object);

    const runtimeOk = runtimeValidator(parsed);
    const emittedOk = emittedValidator(parsed);

    if (!runtimeOk) {
      // eslint-disable-next-line no-console
      console.error(
        "dogfood-stack rejected by RUNTIME schema:\n" +
          JSON.stringify(runtimeValidator.errors, null, 2)
      );
    }
    if (!emittedOk) {
      // eslint-disable-next-line no-console
      console.error(
        "dogfood-stack rejected by EMITTED schema:\n" +
          JSON.stringify(emittedValidator.errors, null, 2)
      );
    }

    expect(runtimeOk).toBe(true);
    expect(emittedOk).toBe(true);
  });

  it("a minimal lich.yaml (version only) passes both validators", () => {
    const runtimeValidator = makeAjv().compile(runtimeSchema);
    const emittedValidator = makeAjv().compile(loadEmittedSchema() as object);

    const minimal = { version: "1" };
    expect(runtimeValidator(minimal)).toBe(true);
    expect(emittedValidator(minimal)).toBe(true);
  });

  it("a config missing `version` is rejected by both validators (schema parity)", () => {
    const runtimeValidator = makeAjv().compile(runtimeSchema);
    const emittedValidator = makeAjv().compile(loadEmittedSchema() as object);

    const bad = { owned: { api: { cmd: "bun run dev" } } };
    expect(runtimeValidator(bad)).toBe(false);
    expect(emittedValidator(bad)).toBe(false);
  });

  it("an unknown top-level property is rejected by both validators (schema parity)", () => {
    const runtimeValidator = makeAjv().compile(runtimeSchema);
    const emittedValidator = makeAjv().compile(loadEmittedSchema() as object);

    const bad = { version: "1", not_a_real_section: { foo: "bar" } };
    expect(runtimeValidator(bad)).toBe(false);
    expect(emittedValidator(bad)).toBe(false);
  });

  it("a config with `env: { VAR: null }` passes both validators", () => {
    // envValueSchema accepts null (the unset marker); both validators must agree
    const runtimeValidator = makeAjv().compile(runtimeSchema);
    const emittedValidator = makeAjv().compile(loadEmittedSchema() as object);

    const cfg = {
      version: "1",
      env: { KEEP: "x", REMOTE_ONLY_VAR: null },
    };
    expect(runtimeValidator(cfg)).toBe(true);
    expect(emittedValidator(cfg)).toBe(true);
  });

  it("the emitted schema is structurally identical to the runtime schema (modulo $id)", () => {
    // drift check: failure → run `bun run build:schema` and commit v1.json
    const emitted = loadEmittedSchema() as Record<string, unknown>;
    const runtime = runtimeSchema as Record<string, unknown>;

    const expected = { ...runtime, $id: PUBLIC_SCHEMA_URL };

    expect(emitted).toEqual(expected);
  });
});
