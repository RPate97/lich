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
  "../../../../../packages/e2e/fixtures/dogfood-stack/lich.yaml"
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

  // -------------------------------------------------------------------------
  // Plan 2 Task 27 — focused conformance assertions for env_groups + commands.
  //
  // These mirror the most load-bearing shapes the dogfood-stack yaml relies
  // on, in minimal form. If any of these starts failing, the schema and the
  // dogfood yaml have drifted apart — fix the schema, not the yaml (the
  // dogfood-stack is the source-of-truth for what lich must handle).
  // -------------------------------------------------------------------------

  it("validates a config with one env_groups entry and one commands entry that uses it", () => {
    // Mirrors the dogfood-stack pattern of `tools:env-check` using
    // `isolated-tools`: a user-defined env_group + a user-defined command
    // whose `env_group` field references that group by name.
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        "isolated-tools": {
          process_env: false,
          env: { TOOL_MODE: "standalone" },
        },
      },
      commands: {
        "tools:env-check": {
          cmd: "printenv TOOL_MODE",
          env_group: "isolated-tools",
          help: "Diagnostic for isolated env_group resolution.",
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("rejects a config with env_groups.stack (reserved)", () => {
    // The built-in `stack` group is reserved and cannot be redeclared. The
    // schema's `propertyNames` constraint forbids it at parse time so this
    // never reaches the resolver.
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        stack: { env: { OOPS: "1" } },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects a config with a command missing the required cmd field", () => {
    // `cmd` is the one required field on a user-defined command — without
    // it the dispatcher has nothing to run.
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        broken: { help: "no cmd" }, // missing required `cmd`
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

  // -------------------------------------------------------------------------
  // Plan 3 Task 2 — profiles is now a strict shape (no longer opaque).
  //
  // The opaque `profiles: { type: "object", additionalProperties: true }`
  // placeholder has been replaced with `profileSchema`. The dogfood-stack's
  // existing `profiles.dev` block (default + owned list + lifecycle) must
  // continue to validate; arbitrary unknown keys inside a profile entry now
  // fail validation.
  // -------------------------------------------------------------------------

  it("validates a config with a minimal profile (only services list)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        minimal: { services: ["postgres"] },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("validates a config with a profile that uses extends: string", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        base: { owned: ["api"] },
        child: { extends: "base" },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("validates a config with a profile that uses extends: [a, b]", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        a: { owned: ["api"] },
        b: { owned: ["web"] },
        combo: { extends: ["a", "b"] },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("validates a config with profile-scoped env, env_files, env_from, lifecycle", () => {
    // Exercises every supported field on a profile entry. The lifecycle
    // shape mirrors the top-level lifecycle (before_up / after_up /
    // before_down only — no before_start / after_ready, those are
    // per-service).
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        rich: {
          services: ["postgres"],
          owned: ["api", "web"],
          default: true,
          env: { DATABASE_URL: "postgresql://hosted.example.com:5432/x" },
          env_files: ["profile.env", "secrets.env"],
          env_from: [
            "HOME",
            { cmd: "infisical export --format=dotenv", format: "dotenv" },
          ],
          lifecycle: {
            before_up: ["echo profile starting"],
            after_up: [
              "supabase migration up",
              { cmd: "./scripts/seed.sh", env_group: "stack-plus-test" },
            ],
            before_down: ["echo profile stopping"],
          },
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("rejects unknown property inside a profile entry", () => {
    // additionalProperties: false on the profile schema means typos like
    // `lifeycle:` and unsupported keys (`before_start:` at the profile
    // level — that's per-service only) fail validation up-front.
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        bad: {
          owned: ["api"],
          // Typo: should be `lifecycle`.
          lifeycle: { after_up: ["echo hi"] },
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

  it("rejects profile.services with non-string entries", () => {
    // services is `array of strings`; numbers / nested objects must be
    // rejected at the schema layer (otherwise the resolver would crash
    // later trying to look up a non-string name).
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        bad: {
          services: ["postgres", 42],
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("accepts profile names containing `:` (dev:test-env style)", () => {
    // Spec worked examples use `:` as a logical separator
    // (`dev:test-env`, `dev:with-tunnel`). The schema must NOT regex-
    // constrain property names so these are accepted.
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        dev: { default: true, owned: ["api"] },
        "dev:test-env": {
          extends: "dev",
          env: { DATABASE_URL: "postgresql://hosted.example.com:5432/x" },
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
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
