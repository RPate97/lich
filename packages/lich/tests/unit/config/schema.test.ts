import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { schema } from "../../../src/config/schema.js";

// Resolve the dogfood yaml relative to the repo root. The test file is at
// packages/lich/tests/unit/config/schema.test.ts, so the repo root is four
// directories up.
const DOGFOOD_YAML = resolve(
  __dirname,
  "../../../../../examples/dogfood-stack/lich.yaml"
);

function makeAjv() {
  return new Ajv({ allErrors: true, strict: false });
}

function compile() {
  return makeAjv().compile(schema);
}

describe("config/schema", () => {
  it("compiles under ajv without error", () => {
    expect(() => makeAjv().compile(schema)).not.toThrow();
  });

  it("validates the dogfood-stack/lich.yaml as a conformance benchmark", () => {
    const raw = readFileSync(DOGFOOD_YAML, "utf8");
    const parsed = parseYaml(raw);
    const validate = compile();
    const ok = validate(parsed);
    // If this fails, print the errors so the diagnostic is useful.
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(
        "dogfood-stack/lich.yaml failed validation:\n" +
          JSON.stringify(validate.errors, null, 2)
      );
    }
    expect(ok).toBe(true);
  });

  it("accepts a minimal valid config (version + one owned service)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: { cmd: "bun run dev" },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts a minimal valid config with a compose service", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        postgres: {
          image: "postgres:16",
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects a config missing the required `version` field with a useful error", () => {
    const validate = compile();
    const ok = validate({
      owned: { api: { cmd: "bun run dev" } },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          e.keyword === "required" &&
          /version/.test(JSON.stringify(e.params ?? {}))
      )
    ).toBe(true);
  });

  it("rejects a non-string `version` with a useful error", () => {
    const validate = compile();
    const ok = validate({ version: 1 });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) => e.instancePath === "/version" && /string/.test(e.message ?? "")
      )
    ).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      not_a_real_section: { foo: "bar" },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some((e) =>
        /additional/i.test(e.keyword) ||
        /must NOT have additional properties/i.test(e.message ?? "")
      )
    ).toBe(true);
  });

  it("rejects an unknown key inside a strictly-defined section", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          // Typo: should be `ready_when`.
          ready_wen: { http_get: "/health" },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some((e) =>
        /additional/i.test(e.keyword) ||
        /must NOT have additional properties/i.test(e.message ?? "")
      )
    ).toBe(true);
  });

  it("accepts unknown keys inside an opaque-future section (profiles)", () => {
    // Plans 2-4 will tighten profiles/commands/env_groups. Until then we
    // accept arbitrary nested shapes so the dogfood yaml validates.
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        foo: { bar: { baz: "anything" } },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts unknown keys inside an opaque-future section (commands)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        anything: { whatever: true, deeply: { nested: [1, 2, 3] } },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts unknown keys inside an opaque-future section (env_groups)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        prod: { env_from: [{ cmd: "infisical export" }], extends: "stack" },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects a bad runtime.port_range shape (string instead of [int, int])", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { port_range: "9999" },
    });
    expect(ok).toBe(false);
  });

  it("accepts a well-formed runtime block", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: {
        compose_cli: "docker",
        proxy_port: 3300,
        port_range: [9000, 9999],
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects port_range with the wrong length", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { port_range: [9000] },
    });
    expect(ok).toBe(false);
  });

  it("rejects an out-of-range port in runtime.proxy_port", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { proxy_port: 70000 },
    });
    expect(ok).toBe(false);
  });

  it("requires `cmd` on an owned service", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: { cwd: "apps/api" }, // missing cmd
      },
    });
    expect(ok).toBe(false);
  });

  it("accepts owned services with multi-port + oneshot + stop_cmd (supabase shape)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        supabase: {
          cmd: "supabase start",
          cwd: ".",
          oneshot: true,
          stop_cmd: "supabase stop",
          ports: {
            api: { env: "SUPABASE_API_PORT" },
            db: { env: "SUPABASE_DB_PORT" },
          },
          ready_when: {
            tcp: "localhost:${owned.supabase.ports.api}",
            timeout: "90s",
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts a top-level lifecycle block with shorthand and long-form entries", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      lifecycle: {
        before_up: ["echo starting"],
        after_up: [
          "pnpm prisma migrate dev",
          { cmd: "./scripts/sync.sh", env_group: "infisical-prod" },
        ],
        before_down: ["echo stopping"],
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts env_from as a list of strings (inherit env var names)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_from: ["HOME", "PATH"],
    });
    expect(ok).toBe(true);
  });

  it("accepts env_from as a list of shell-out objects", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_from: [
        { cmd: "infisical export --format=dotenv", format: "dotenv" },
      ],
    });
    expect(ok).toBe(true);
  });

  it("rejects an env_from object missing `cmd`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_from: [{ format: "dotenv" }],
    });
    expect(ok).toBe(false);
  });
});
