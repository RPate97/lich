// JSON Schema for lich.yaml. See docs/superpowers/specs/2026-05-23-lich-v1-design.md (section 4).
// Conformance target: packages/e2e/fixtures/dogfood-stack/lich.yaml.

/** String, number, or boolean (numbers/booleans coerced to strings at resolve time). */
const envValueSchema = {
  type: ["string", "number", "boolean"],
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
  },
  required: ["cmd"],
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

// ---------------------------------------------------------------------------
// profiles (Plan 3 — named slices of the stack)
// ---------------------------------------------------------------------------

/**
 * A single profile entry. Plan 3 introduces `profiles:` as a strictly-shaped
 * top-level section; this schema validates one entry.
 *
 * Per spec section 4 (`profiles`):
 *   - `services`: list of compose-service names included in this slice.
 *   - `owned`: list of owned-service names included in this slice.
 *   - `extends`: a single parent profile name OR an array of parent names.
 *     The array form lets a profile compose its behavior from multiple bases
 *     (e.g. `[dev, with-tunnel]`); per-key env layering disambiguates
 *     collisions deterministically (later parent wins, then the child).
 *   - `default`: when `true`, this profile is what `lich up` (no argument)
 *     activates. Exactly zero or one profile in the map may set this — the
 *     "multiple defaults" check is a `lich validate` reference check
 *     (Plan 3 Task 11), NOT enforced at the schema layer (it would require
 *     cross-property awareness ajv doesn't express cleanly here).
 *   - `env` / `env_files` / `env_from`: profile-scoped env contributions
 *     (layered between top-level and per-service per spec section 4).
 *   - `lifecycle`: profile-scoped lifecycle hooks (same shape as
 *     `TopLevelLifecycle` — `before_up` / `after_up` / `before_down`).
 *
 * `additionalProperties: false` so typos surface at validate time.
 *
 * Notes:
 *   - The `extends` oneOf lists `string` first for readability — for
 *     `extends: "foo"` the `array` branch fails on shape, so ajv selects the
 *     string branch unambiguously regardless of order.
 *   - No regex constraint on profile names: spec worked examples use `:`
 *     separators (`dev:test-env`, `dev:with-tunnel`), so we keep names
 *     fully free-form (matches `commands` for the same reason).
 *   - Name collisions with built-in command names are intentionally NOT
 *     rejected here — that's a `lich validate` reference check (same
 *     rationale as Plan 2 Task 3 for `commands`).
 *
 * Spec source: `docs/superpowers/specs/2026-05-23-lich-v1-design.md`,
 * section 4 (`profiles`).
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
    // Deprecated alias for `compose_cli` — kept for back-compat with
    // earlier design-spec drafts that wrote it as `runtime.compose`.
    compose: { type: "string", enum: ["auto", "docker", "podman", "nerdctl"] },
    proxy_port: { type: "integer", minimum: 1, maximum: 65535 },
    port_range: {
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 65535 },
      minItems: 2,
      maxItems: 2,
    },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://lich.dev/schema/v1.json",
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

    // ----- Sections owned by later plans — accept-as-opaque for now. -----
    // Plan 2 tightens env_groups (Task 2) and commands (Task 3).
    /**
     * Named env_groups (Plan 2 Task 2). Keys are group names; values
     * match `envGroupSchema`. The built-in group name `stack` is
     * reserved — the `propertyNames` constraint rejects it at parse
     * time so users can't redeclare the built-in.
     */
    env_groups: {
      type: "object",
      propertyNames: { not: { const: "stack" } },
      additionalProperties: envGroupSchema,
    },
    /**
     * User-defined commands (Plan 2 Task 3). Strict: keys are command
     * names (free-form strings; `:` and `/` are intentionally allowed so
     * names like `test:e2e` and `db/psql` work), values match
     * {@link userCommandSchema}.
     */
    commands: {
      type: "object",
      additionalProperties: userCommandSchema,
    },
    /**
     * Named profiles (Plan 3 Task 2). Strict: keys are profile names
     * (free-form strings — `:` and `/` allowed so names like `dev:test-env`
     * work), values match {@link profileSchema}.
     */
    profiles: {
      type: "object",
      additionalProperties: profileSchema,
    },
  },
  required: ["version"],
  additionalProperties: false,
} as const;

export default schema;
