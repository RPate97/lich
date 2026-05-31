import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { schema } from "../../../src/config/schema.js";

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
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(
        "dogfood-stack/lich.yaml failed validation:\n" +
          JSON.stringify(validate.errors, null, 2)
      );
    }
    expect(ok).toBe(true);
  });

  it("validates a config with one env_groups entry and one commands entry that uses it", () => {
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
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        broken: { help: "no cmd" },
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
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        bad: {
          owned: ["api"],
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
        bad: { cwd: "x" },
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

  it("accepts runtime.ready_when_timeout as a duration string", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { ready_when_timeout: "180s" },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts runtime.ready_when_timeout as a raw integer (ms)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { ready_when_timeout: 180_000 },
    });
    expect(ok).toBe(true);
  });

  it("rejects runtime.ready_when_timeout: 'forever' with a useful error", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { ready_when_timeout: "forever" },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some((e) => /ready_when_timeout/.test(e.instancePath)),
    ).toBe(true);
  });

  it("rejects runtime.ready_when_timeout: 0 (zero raw integer)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { ready_when_timeout: 0 },
    });
    expect(ok).toBe(false);
  });

  it("accepts runtime without ready_when_timeout (still optional)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { compose_cli: "docker" },
    });
    expect(ok).toBe(true);
  });

  it("accepts runtime.kill_others_on_fail: true", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { kill_others_on_fail: true },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts runtime.kill_others_on_fail: false (opt-out)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { kill_others_on_fail: false },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("rejects runtime.kill_others_on_fail with a non-boolean value", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { kill_others_on_fail: "true" },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some((e) => /kill_others_on_fail/.test(e.instancePath)),
    ).toBe(true);
  });

  it("accepts runtime without kill_others_on_fail (still optional, defaults to ON)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      runtime: { compose_cli: "docker" },
    });
    expect(ok).toBe(true);
  });

  it("requires `cmd` on an owned service", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: { cwd: "apps/api" },
      },
    });
    expect(ok).toBe(false);
  });

  it("accepts an owned service with a `discover` block and no `cmd`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        "workers": {
          discover: {
            glob: "apps/workers/src/workers/*Worker.ts",
            name_template: "${basename_no_ext | strip_suffix:Worker | kebab}-worker",
            cmd_template: "node dist/workers/${basename_no_ext}.js",
            cwd: "apps/workers",
          },
          ready_when: {
            log_match: "Worker created",
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

  it("rejects an owned entry that sets BOTH `cmd` AND `discover`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        ws: {
          cmd: "bun run dev",
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext}",
            cmd_template: "node ${basename}",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects an owned entry with NEITHER `cmd` NOR `discover`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        ws: { cwd: "apps/x" },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects a discover block missing the required `glob`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        ws: {
          discover: {
            // glob missing
            name_template: "${basename_no_ext}",
            cmd_template: "node ${basename}",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects a discover block missing the required `name_template`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*.ts",
            cmd_template: "node ${basename}",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects a discover block missing the required `cmd_template`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext}",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects an unknown key inside a discover block (additionalProperties: false)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext}",
            cmd_template: "node ${basename}",
            cwdd: "apps/workers",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("accepts a discover block alongside other owned fields (ready_when, env, depends_on, etc.)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext}",
            cmd_template: "node ${basename}",
          },
          cwd: "apps/workers",
          depends_on: ["postgres"],
          oneshot: false,
          env: { NODE_ENV: "development" },
          env_from: ["HOME"],
          ready_when: { log_match: "Worker created" },
          fail_when: { log_match: "PANIC" },
          lifecycle: {
            before_start: ["echo starting"],
            after_ready: ["echo ready"],
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

  it("accepts an owned service with owned_containers.label", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        supabase: {
          cmd: "supabase start",
          oneshot: true,
          stop_cmd: "supabase stop",
          owned_containers: {
            label: "com.supabase.cli.project=${worktree.id}",
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

  it("accepts an owned service with owned_containers.name_pattern", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        supabase: {
          cmd: "supabase start",
          oneshot: true,
          stop_cmd: "supabase stop",
          owned_containers: {
            name_pattern: "supabase_*_${worktree.id}",
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

  it("rejects owned_containers with BOTH label AND name_pattern (mutually exclusive)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        supabase: {
          cmd: "supabase start",
          owned_containers: {
            label: "foo=bar",
            name_pattern: "supabase_*",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects owned_containers with NEITHER label NOR name_pattern", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        supabase: {
          cmd: "supabase start",
          owned_containers: {},
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects an empty-string label / name_pattern (minLength:1)", () => {
    const validate = compile();
    const okLabel = validate({
      version: "1",
      owned: {
        x: { cmd: "true", owned_containers: { label: "" } },
      },
    });
    expect(okLabel).toBe(false);

    const okName = validate({
      version: "1",
      owned: {
        x: { cmd: "true", owned_containers: { name_pattern: "" } },
      },
    });
    expect(okName).toBe(false);
  });

  it("rejects unknown fields inside owned_containers (additionalProperties: false)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        x: {
          cmd: "true",
          owned_containers: { label: "k=v", extra: "nope" },
        },
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
            api: { published_env: "SUPABASE_API_PORT" },
            db: { published_env: "SUPABASE_DB_PORT" },
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

  it("accepts a compose service whose Record-form port carries `container_port`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          image: "node:20",
          ports: {
            http: { container_port: 3000, published_env: "PORT" },
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts a compose service whose Record-form port carries container_port + host_port + published_env", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        postgres: {
          image: "postgres:16",
          ports: {
            db: { container_port: 5432, published_env: "POSTGRES_HOST_PORT", host_port: 5544 },
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts the scalar form `- 5432` in a list-form ports declaration", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        postgres: {
          image: "postgres:16",
          ports: [5432],
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts the scalar form `<key>: 5432` in a keyed ports declaration", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          image: "node:20",
          ports: { admin: 3001 },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts a mix of scalar and block entries in a keyed ports declaration", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          image: "node:20",
          ports: {
            http: { container_port: 3000, published_env: "PORT" },
            admin: 3001,
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects an unknown key inside a Record-form port descriptor", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          ports: {
            http: { container_port: 3000, not_a_real_field: "oops" },
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects an out-of-range `container_port` value", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      services: {
        api: {
          ports: {
            http: { container_port: 99999, published_env: "PORT" },
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

  it("accepts lifecycle.after_down with shorthand and long-form entries", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      lifecycle: {
        after_down: [
          "rm -rf /tmp/myapp-cache",
          { cmd: "./scripts/cleanup.sh", env_group: "stack" },
        ],
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts lifecycle.after_down inside a profile (mirror of before_down)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        dev: {
          default: true,
          owned: ["api"],
          lifecycle: {
            after_down: ["./scripts/drop-supabase-workdir.sh"],
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

  it("rejects lifecycle.after_down with non-array value (shape mirrors before_down)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      lifecycle: {
        after_down: "rm -rf /tmp/foo",
      },
    });
    expect(ok).toBe(false);
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

  it("accepts `env: { VAR: null }` at the top level", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env: {
        KEEP: "x",
        REMOTE_ONLY_VAR: null,
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts `env: { VAR: null }` on a per-owned-service block", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          env: { TOOL_TOKEN: null },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts `env: { VAR: null }` on a profile env block", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      profiles: {
        offline: {
          env: { REMOTE_ONLY_VAR: null },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts `env: { VAR: null }` on an env_group", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      env_groups: {
        scrubbed: {
          env: { DATABASE_URL: null },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts `env: { VAR: null }` on a user-defined command", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      commands: {
        "tools:scrub": {
          cmd: "echo hi",
          env: { LEAKY_TOKEN: null },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts `env_from` on an owned service as a list of shell-out objects", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          env_from: [
            {
              cmd: "infisical export --env=dev --path=/api --format=dotenv",
              format: "dotenv",
            },
          ],
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts `env_from` on an owned service as a list of strings", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        web: {
          cmd: "bun run dev",
          env_from: ["HOME", "PATH"],
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts disjoint `env_from` on two owned services", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        web: {
          cmd: "bun run dev",
          env_from: [
            {
              cmd: "infisical export --path=/web --format=dotenv",
              format: "dotenv",
            },
          ],
        },
        server: {
          cmd: "bun run server",
          env_from: [
            {
              cmd: "infisical export --path=/services --format=dotenv",
              format: "dotenv",
            },
          ],
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("rejects an owned-service `env_from` object missing `cmd`", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          env_from: [{ format: "dotenv" }],
        },
      },
    });
    expect(ok).toBe(false);
  });
});
