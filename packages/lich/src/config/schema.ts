/**
 * JSON Schema (draft-07 compatible, ajv-consumable) for the v1 lich.yaml.
 *
 * Plan 1 subset: this schema strictly validates the sections that Plan 1
 * implements (`services`, `owned`, `env`, `env_files`, `env_from`,
 * `lifecycle`, `runtime`). Sections owned by later plans
 * (`env_groups`, `commands`, `profiles`) are accepted as opaque objects so
 * the dogfood-stack yaml validates today — Plans 2-4 will tighten them.
 *
 * Likewise a handful of fields *inside* services/owned that belong to later
 * plans (`ready_when.capture`, `ready_when.timeout`, `fail_when`) are
 * accepted-as-opaque here and will be locked down in Plan 4.
 *
 * Source-of-truth for field names and semantics:
 *   docs/superpowers/specs/2026-05-23-lich-v1-design.md (section 4).
 *
 * Conformance target: examples/dogfood-stack/lich.yaml must validate cleanly.
 */

// ---------------------------------------------------------------------------
// Reusable sub-schemas
// ---------------------------------------------------------------------------

/** A string or a YAML primitive that env values commonly take. */
const envValueSchema = {
  // Allow strings (the normal case, supports `${...}` interpolation) plus
  // numbers and booleans (coerced at resolve time per spec).
  type: ["string", "number", "boolean"],
} as const;

/** Map of env var name → value (or interpolated string). */
const envMapSchema = {
  type: "object",
  additionalProperties: envValueSchema,
} as const;

/** Top-level (or per-service) list of dotenv file paths. */
const envFilesSchema = {
  type: "array",
  items: { type: "string" },
} as const;

/**
 * Top-level (or per-service) list of shell-out env sources.
 * Per spec section 4: each entry has `cmd`, optional `format` ('dotenv' |
 * 'json'), optional `cwd`.
 */
const envFromSchema = {
  type: "array",
  items: {
    oneOf: [
      // Shorthand: a list of env var names to inherit from the parent
      // process. (Per task scope: `env_from` is "array of strings — env
      // var names to inherit".)
      { type: "string" },
      // Long form: a shell-out source.
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

/**
 * A lifecycle hook entry. Shorthand is a plain shell string; the long form
 * is `{ cmd, env_group? }` per spec section 4.
 */
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

/** Top-level lifecycle block: before_up / after_up / before_down. */
const topLevelLifecycleSchema = {
  type: "object",
  properties: {
    before_up: lifecycleListSchema,
    after_up: lifecycleListSchema,
    before_down: lifecycleListSchema,
  },
  additionalProperties: false,
} as const;

/**
 * Per-service lifecycle block. Adds `before_start` and `after_ready`
 * relative to the top-level shape, per spec section 4.
 */
const perServiceLifecycleSchema = {
  type: "object",
  properties: {
    before_start: lifecycleListSchema,
    after_ready: lifecycleListSchema,
    before_down: lifecycleListSchema,
  },
  additionalProperties: false,
} as const;

/**
 * Logical port descriptor as used in dogfood-stack/lich.yaml:
 *   { env: SOME_ENV_NAME }  — lich allocates a host port and exposes it as
 *                              the named env var.
 *
 * Per the task scope "logical-name → optional fixed host port" we also
 * allow an integer shortcut for pinning a specific host port.
 *
 * `container` is meaningful for compose services (where lich emits a
 * `<hostPort>:<containerPort>` binding in the compose override). It's
 * accepted on the object form for both compose and owned ports — owned
 * services just ignore it.
 */
const portDescriptorSchema = {
  oneOf: [
    // Pinned host port (e.g. `db: 5432`).
    { type: "integer", minimum: 1, maximum: 65535 },
    // Object form — at minimum one of { env, host_port, container } should
    // be present but we don't force it; future plans may add more keys.
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

/**
 * `ready_when` block (Plan 1 subset).
 * `capture` and `timeout` are accept-as-opaque here; Plan 4 will tighten
 * them.
 */
const readyWhenSchema = {
  type: "object",
  properties: {
    http_get: { type: "string" },
    tcp: { type: "string" },
    log_match: { type: "string" },
    cmd: { type: "string" },
    // Future-plan placeholders — kept permissive intentionally.
    timeout: {}, // any type for now (Plan 4 will require a duration string)
    capture: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
} as const;

/**
 * `fail_when` is fully owned by Plan 4 but appears in the dogfood yaml.
 * Accept-as-opaque so the dogfood validates today.
 */
const failWhenSchema = {
  type: "object",
  additionalProperties: true,
} as const;

// ---------------------------------------------------------------------------
// services (compose-backed)
// ---------------------------------------------------------------------------

/**
 * A compose-backed service. Plan 1 implements `compose_file`, `service`,
 * `ports`, and per-service `lifecycle`. Other compose-spec fields are
 * accepted opaquely (compose validates them itself when we shell out).
 */
const composeServiceSchema = {
  type: "object",
  properties: {
    // Plan-1 fields:
    compose_file: { type: "string" },
    service: { type: "string" },
    ports: {
      // Logical name → port descriptor (matches dogfood-style shape).
      // Compose-spec also allows a list of `{ container, env }` entries;
      // we accept that shape too to keep the door open.
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
    // Common compose-spec passthroughs we want to allow without enforcing
    // their internal shape (compose itself will validate them when we
    // shell out).
    image: { type: "string" },
    environment: {},
    healthcheck: { type: "object", additionalProperties: true },
    volumes: { type: "array" },
    networks: {},
    profiles: { type: "array" },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// owned (host processes)
// ---------------------------------------------------------------------------

const ownedServiceSchema = {
  type: "object",
  properties: {
    cmd: { type: "string" },
    cwd: { type: "string" },
    depends_on: {
      type: "array",
      items: { type: "string" },
    },
    // Single-port shape: `port: { env: PORT }`
    port: portDescriptorSchema,
    // Multi-port shape: `ports: { api: { env: ... }, db: { env: ... } }`
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

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

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
    // Plan 2 will tighten env_groups + commands.
    env_groups: { type: "object", additionalProperties: true },
    commands: { type: "object", additionalProperties: true },
    // Plan 3 will tighten profiles.
    profiles: { type: "object", additionalProperties: true },
  },
  required: ["version"],
  additionalProperties: false,
} as const;

export default schema;
