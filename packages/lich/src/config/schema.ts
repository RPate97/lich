/**
 * JSON Schema (draft-07 compatible, ajv-consumable) for the v1 lich.yaml.
 *
 * Plan 1 subset: this schema strictly validates the sections that Plan 1
 * implements (`services`, `owned`, `env`, `env_files`, `env_from`,
 * `lifecycle`, `runtime`). Plan 2 tightens `env_groups` and `commands`
 * (see `envGroupSchema`, `userCommandSchema`). Plan 3 tightens `profiles`
 * (see `profileSchema`). Sections still owned by later plans are accepted
 * as opaque objects so the dogfood-stack yaml validates today — Plan 4
 * will continue tightening `ready_when` / `fail_when` internals.
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
 *
 * `timeout` is tightened by Plan 4 Task 5: either a duration STRING matching
 * `^[0-9]+(ms|s|m|h)?$` (e.g. `"500ms"`, `"30s"`, `"2m"`, `"1h"`, `"60000"`)
 * OR a positive INTEGER number of milliseconds. Both forms are parsed at
 * runtime by `src/ready/timeout.ts#parseDuration`; the regex here ensures
 * malformed strings (`"forever"`, `"5 minutes"`, signed values, decimals)
 * surface at `lich validate` time, not at ready-check time.
 *
 * Why not a single `oneOf` with a freeform string? The pattern-restricted
 * string variant is the load-bearing piece — without it, ajv would happily
 * accept `timeout: "forever"` and the user would only see the failure once
 * a service actually tried to come up. Putting the pattern in the schema
 * means `lich validate` is the front line of defense and the runtime parser
 * just confirms what the schema already proved.
 *
 * `capture` is locked down by Plan 4 Task 6: a flat `key -> regex-string`
 * map. The values are regex PATTERN strings that the runtime will compile
 * (validate will also compile them so syntax errors surface at load time,
 * not at ready-check time). Nested objects, numbers, arrays, etc. are
 * rejected here — keeps the API simple and the surfaced errors precise.
 */
const readyWhenSchema = {
  type: "object",
  properties: {
    http_get: { type: "string" },
    tcp: { type: "string" },
    log_match: { type: "string" },
    cmd: { type: "string" },
    /**
     * Plan 4 Task 5: duration string OR positive integer ms. The string
     * pattern `^[0-9]+(ms|s|m|h)?$` accepts the four suffixes documented
     * in the spec plus the bare-digits form (which the runtime parser
     * treats as already-ms, same as the `ms` suffix). The integer form
     * uses ajv's `minimum: 1` to reject `0` and negatives at schema time.
     *
     * The runtime parser (`parseDuration`) re-validates these constraints
     * so any pre-validated direct callers can still rely on safe values,
     * but the schema is the user-facing front line — a config with
     * `timeout: "forever"` fails `lich validate` before lich ever tries
     * to start a service.
     */
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
    /**
     * Plan 4 Task 6: a flat `key -> regex-pattern` map. Each VALUE must be
     * a string (the regex pattern). Reject non-string values like numbers
     * or nested objects so users see a useful error if they accidentally
     * write `capture: { url: 42 }` or `capture: { url: { regex: "..." } }`.
     */
    capture: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
  additionalProperties: false,
} as const;

/**
 * `fail_when` block (Plan 4 Task 7 — first tightening).
 *
 * v1 surface: a single optional `log_match` field (string-form regex).
 * The runtime watcher lives in `failure/fail-when.ts`; the validate-time
 * regex compile lives in `commands/validate.ts` (`checkRegexes`).
 *
 * `additionalProperties: false` catches typos (`log_matc`) and not-yet-
 * supported fields (`exit_code`, `oom_score`, etc.) at validate time
 * rather than silently ignoring them at runtime. Future plans may add
 * more keys here (`exit_code` is a plausible Plan-4-followup); when
 * they do, both this schema and `FailWhen` in `./types.ts` must move
 * together.
 */
const failWhenSchema = {
  type: "object",
  properties: {
    log_match: { type: "string" },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// env_groups (Plan 2)
// ---------------------------------------------------------------------------

/**
 * A user-defined env_group entry. Per spec section 4 (`env_groups`):
 *   - `env_from`: shell-out / dotenv-file sources (reuses `envFromSchema`).
 *   - `env`: literal `KEY: VALUE` map layered last (reuses `envMapSchema`).
 *   - `extends`: single string — name of parent group to inherit from.
 *     env_groups support exactly one parent (unlike profiles).
 *   - `process_env`: boolean (defaults to `true` at resolve time). When
 *     `false`, the resolver does NOT overlay `process.env` at the outermost
 *     call — useful for hermetic tool envs.
 *
 * `additionalProperties: false` so typos surface at validate time.
 *
 * Note: `env_files` is intentionally NOT a field here. The spec restricts
 * env_groups to `env_from` for file/shell sourcing; `env_files` belongs to
 * the top-level stack composition only. See spec section 4 env_groups.
 */
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

// ---------------------------------------------------------------------------
// commands (user-defined; Plan 2)
// ---------------------------------------------------------------------------

/**
 * A single user-defined command entry. Plan 2 introduces `commands:` as a
 * strictly-shaped top-level section; this schema validates one entry.
 *
 * Required: `cmd`. Optional: `cwd`, `env_group`, `env`, `help`.
 *
 * `additionalProperties: false` ensures typos like `helps:` or `command:`
 * are caught at validate time rather than silently ignored at runtime.
 *
 * NOTE: this schema does NOT enforce "command name cannot shadow a built-in"
 * — that's a `lich validate` reference check (Plan 2 Task 14), because the
 * list of built-ins lives in `commands/index.ts` and schemas shouldn't
 * import from sibling modules.
 *
 * Spec source: `docs/superpowers/specs/2026-05-23-lich-v1-design.md`,
 * section 4 (`commands`).
 */
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
