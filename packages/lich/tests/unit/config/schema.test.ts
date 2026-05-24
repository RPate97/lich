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

  it("validates a config with one user-defined command", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        foo: { cmd: "echo hi", help: "say hi" },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("validates a user-defined command with every optional field", () => {
    // cwd, env_group, env, help all permitted alongside the required cmd.
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        "test:e2e": {
          cmd: "pnpm test:e2e",
          cwd: "apps/web",
          env_group: "stack",
          env: { CI: "1" },
          help: "Run the e2e suite.",
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("requires cmd on every user-defined command", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        bad: { cwd: "x" }, // missing cmd
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          e.keyword === "required" &&
          /cmd/.test(JSON.stringify(e.params ?? {}))
      )
    ).toBe(true);
  });

  it("rejects unknown property inside a user-defined command", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        foo: {
          cmd: "echo hi",
          // Typo: should be `help`.
          helps: "say hi",
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          /additional/i.test(e.keyword) ||
          /must NOT have additional properties/i.test(e.message ?? "")
      )
    ).toBe(true);
  });

  it("accepts user-defined command names containing `:` or `/`", () => {
    // The schema must NOT regex-constrain property names; commands like
    // `test:e2e` and `db/psql` are common shorthand.
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        "test:e2e": { cmd: "pnpm test:e2e" },
        "db/psql": { cmd: 'psql "$DATABASE_URL"' },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("validates a config with one user-defined env_group", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        foo: { env: { A: "1" } },
      },
    });
    expect(ok).toBe(true);
  });

  it("validates an env_group exercising every supported field", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        prod: {
          env_from: [{ cmd: "infisical export", format: "dotenv" }],
          env: { LOG_LEVEL: "info" },
          extends: "stack",
          process_env: false,
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects env_groups.stack as a reserved name", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        stack: { env: { OOPS: "1" } },
      },
    });
    expect(ok).toBe(false);
    // The property-name constraint should fire — the error should point at
    // the reserved name so the user sees what went wrong.
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          (e.keyword === "propertyNames" || e.keyword === "not") &&
          /stack/.test(JSON.stringify(e))
      )
    ).toBe(true);
  });

  it("rejects unknown property inside an env_group entry", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        foo: {
          env: { A: "1" },
          // Typo: should be `env_from`.
          env_form: [{ cmd: "echo hi" }],
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          /additional/i.test(e.keyword) ||
          /must NOT have additional properties/i.test(e.message ?? "")
      )
    ).toBe(true);
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

  it("accepts a compose service whose Record-form port carries `container`", () => {
    // `container` is the field the override generator uses to emit
    // `<hostPort>:<containerPort>` bindings. Per LEV-305 it must be a
    // first-class field in the object form of PortDescriptor.
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          image: "node:20",
          ports: {
            http: { container: 3000, env: "PORT" },
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts a compose service whose Record-form port carries container + host_port + env", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        postgres: {
          image: "postgres:16",
          ports: {
            db: { container: 5432, env: "POSTGRES_HOST_PORT", host_port: 5544 },
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects an unknown key inside a Record-form port descriptor", () => {
    // additionalProperties is still false on the object form. Adding
    // `container` doesn't open the gate to arbitrary fields.
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          ports: {
            http: { container: 3000, not_a_real_field: "oops" },
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects an out-of-range `container` value", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          ports: {
            http: { container: 99999, env: "PORT" },
          },
        },
      },
    });
    expect(ok).toBe(false);
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
