// JSON Schema for lich.yaml.

/**
 * String, number, boolean, or null. `null` is an explicit unset marker —
 * after env layers merge, keys with final value `null` are removed from
 * the resolved env (not equivalent to empty string).
 */
const envValueSchema = {
  type: ["string", "number", "boolean", "null"],
} as const;

const envMapSchema = {
  type: "object",
  additionalProperties: envValueSchema,
} as const;

const envFilesSchema = {
  type: "array",
  items: { type: "string" },
} as const;

const envFromSchema = {
  type: "array",
  items: {
    oneOf: [
      // String shorthand: env var name to inherit from the parent process.
      { type: "string" },
      // Long form: shell-out source.
      {
        type: "object",
        properties: {
          cmd: { type: "string" },
          format: { type: "string", enum: ["dotenv", "json"] },
          cwd: { type: "string" },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
    ],
  },
} as const;

const lifecycleEntrySchema = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        cmd: { type: "string" },
        env_group: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  ],
} as const;

const lifecycleListSchema = {
  type: "array",
  items: lifecycleEntrySchema,
} as const;

const topLevelLifecycleSchema = {
  type: "object",
  properties: {
    before_up: lifecycleListSchema,
    after_up: lifecycleListSchema,
    before_down: lifecycleListSchema,
    after_down: lifecycleListSchema,
  },
  additionalProperties: false,
} as const;

const perServiceLifecycleSchema = {
  type: "object",
  properties: {
    before_start: lifecycleListSchema,
    after_ready: lifecycleListSchema,
    before_down: lifecycleListSchema,
  },
  additionalProperties: false,
} as const;

/** Pinned host port integer, or object form: `{ env, host_port, container }`. */
const portDescriptorSchema = {
  oneOf: [
    { type: "integer", minimum: 1, maximum: 65535 },
    {
      type: "object",
      properties: {
        env: { type: "string" },
        host_port: { type: "integer", minimum: 1, maximum: 65535 },
        container: { type: "integer", minimum: 1, maximum: 65535 },
      },
      additionalProperties: false,
    },
  ],
} as const;

const readyWhenSchema = {
  type: "object",
  properties: {
    http_get: { type: "string" },
    tcp: { type: "string" },
    log_match: { type: "string" },
    cmd: { type: "string" },
    // Duration STRING or positive INTEGER ms. The string pattern catches
    // typos like `"forever"` at validate time, not at ready-check time.
    timeout: {
      oneOf: [
        {
          type: "string",
          pattern: "^[0-9]+(ms|s|m|h)?$",
        },
        {
          type: "integer",
          minimum: 1,
        },
      ],
    },
    // Flat `key -> regex-pattern` map. Reject non-string values so typos
    // like `capture: { url: 42 }` surface as a clean schema error.
    capture: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
  additionalProperties: false,
} as const;

const failWhenSchema = {
  type: "object",
  properties: {
    log_match: { type: "string" },
  },
  additionalProperties: false,
} as const;

// env_groups support a single parent (`extends: <string>`) and intentionally
// have no `env_files` field — only top-level stack composition does.
const envGroupSchema = {
  type: "object",
  properties: {
    env_from: envFromSchema,
    env: envMapSchema,
    extends: { type: "string" },
    process_env: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

// Compose-spec fields beyond the lich-owned ones are accepted opaquely;
// compose validates them itself when we shell out.
const composeServiceSchema = {
  type: "object",
  properties: {
    compose_file: { type: "string" },
    service: { type: "string" },
    ports: {
      // Record form (logical name → descriptor) OR array form
      // (`[{ container, env, host_port }]`, the compose-spec passthrough).
      oneOf: [
        {
          type: "object",
          additionalProperties: portDescriptorSchema,
        },
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              container: { type: "integer", minimum: 1, maximum: 65535 },
              env: { type: "string" },
              host_port: { type: "integer", minimum: 1, maximum: 65535 },
            },
            required: ["container"],
            additionalProperties: false,
          },
        },
      ],
    },
    lifecycle: perServiceLifecycleSchema,
    depends_on: {
      type: "array",
      items: { type: "string" },
    },
    image: { type: "string" },
    environment: {},
    healthcheck: { type: "object", additionalProperties: true },
    volumes: { type: "array" },
    networks: {},
    profiles: { type: "array" },
    tmpfs: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
  },
  additionalProperties: false,
} as const;

const ownedDiscoverSchema = {
  type: "object",
  properties: {
    glob: { type: "string", minLength: 1 },
    name_template: { type: "string", minLength: 1 },
    cmd_template: { type: "string", minLength: 1 },
    cwd: { type: "string" },
  },
  required: ["glob", "name_template", "cmd_template"],
  additionalProperties: false,
} as const;

// Owned service shape — `oneOf` enforces one of two arms:
//   A) Hand-written: `cmd` required, NO `discover`.
//   B) Discovery: `discover` required (its template + glob describe per-
//      instance shape), NO `cmd` at the entry root.
// Mutual-exclusion error surfaces from the parse layer (config/discover.ts).
const ownedServiceSchema = {
  type: "object",
  properties: {
    cmd: { type: "string" },
    cwd: { type: "string" },
    depends_on: {
      type: "array",
      items: { type: "string" },
    },
    port: portDescriptorSchema,
    ports: {
      type: "object",
      additionalProperties: portDescriptorSchema,
    },
    oneshot: { type: "boolean" },
    stop_cmd: { type: "string" },
    env: envMapSchema,
    env_files: envFilesSchema,
    env_from: envFromSchema,
    ready_when: readyWhenSchema,
    fail_when: failWhenSchema,
    lifecycle: perServiceLifecycleSchema,
    discover: ownedDiscoverSchema,
  },
  oneOf: [
    {
      required: ["cmd"],
      not: { required: ["discover"] },
    },
    {
      required: ["discover"],
      not: { required: ["cmd"] },
    },
  ],
  additionalProperties: false,
} as const;

// Built-in command shadow-checks happen in `lich validate`, not here.
const userCommandSchema = {
  type: "object",
  properties: {
    cmd: { type: "string" },
    cwd: { type: "string" },
    env_group: { type: "string" },
    env: envMapSchema,
    help: { type: "string" },
  },
  required: ["cmd"],
  additionalProperties: false,
} as const;

/**
 * Single profile entry. The `default: true` "exactly one" rule and name
 * collisions with built-in commands are enforced by `lich validate`, not
 * here (cross-property checks AJV doesn't express cleanly).
 */
const profileSchema = {
  type: "object",
  properties: {
    services: {
      type: "array",
      items: { type: "string" },
    },
    owned: {
      type: "array",
      items: { type: "string" },
    },
    extends: {
      oneOf: [
        { type: "string" },
        {
          type: "array",
          items: { type: "string" },
        },
      ],
    },
    default: { type: "boolean" },
    env: envMapSchema,
    env_files: envFilesSchema,
    env_from: envFromSchema,
    lifecycle: topLevelLifecycleSchema,
  },
  additionalProperties: false,
} as const;

const runtimeSchema = {
  type: "object",
  properties: {
    compose_cli: { type: "string", enum: ["auto", "docker", "podman", "nerdctl"] },
    // Deprecated alias for `compose_cli`.
    compose: { type: "string", enum: ["auto", "docker", "podman", "nerdctl"] },
    proxy_port: { type: "integer", minimum: 1, maximum: 65535 },
    port_range: {
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 65535 },
      minItems: 2,
      maxItems: 2,
    },
    // Stack-wide default for owned services' `ready_when.timeout`. Same
    // duration shape (string `^[0-9]+(ms|s|m|h)?$` or positive integer ms).
    ready_when_timeout: {
      oneOf: [
        {
          type: "string",
          pattern: "^[0-9]+(ms|s|m|h)?$",
        },
        {
          type: "integer",
          minimum: 1,
        },
      ],
    },
    kill_others_on_fail: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

export const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://lich.sh/schema/v1.json",
  title: "lich.yaml (v1)",
  type: "object",
  properties: {
    version: { type: "string" },
    runtime: runtimeSchema,
    services: {
      type: "object",
      additionalProperties: composeServiceSchema,
    },
    owned: {
      type: "object",
      additionalProperties: ownedServiceSchema,
    },
    env: envMapSchema,
    env_files: envFilesSchema,
    env_from: envFromSchema,
    lifecycle: topLevelLifecycleSchema,
    // Built-in group name `stack` is reserved — `propertyNames` rejects
    // redeclaration at parse time.
    env_groups: {
      type: "object",
      propertyNames: { not: { const: "stack" } },
      additionalProperties: envGroupSchema,
    },
    commands: {
      type: "object",
      additionalProperties: userCommandSchema,
    },
    profiles: {
      type: "object",
      additionalProperties: profileSchema,
    },
  },
  required: ["version"],
  additionalProperties: false,
} as const;

export default schema;
