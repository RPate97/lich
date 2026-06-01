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
          cmd: {
            type: "string",
            description: "Shell command to execute. Its stdout supplies env vars in the chosen format.",
          },
          format: {
            type: "string",
            enum: ["dotenv", "json"],
            description: "How to parse the cmd's stdout. `dotenv` (KEY=VALUE lines) or `json` (flat object).",
          },
          cwd: {
            type: "string",
            description: "Working directory for the cmd, relative to the repo root.",
          },
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
        cmd: {
          type: "string",
          description: "Shell command to run for this lifecycle entry.",
        },
        env_group: {
          type: "string",
          description: "Name of an env_group whose env this entry runs with (instead of the default stack env).",
        },
        cwd: {
          type: "string",
          description: "Working directory for the cmd, relative to the repo root.",
        },
        per_fork: {
          type: "boolean",
          description: "When true, hook runs on every sandbox fork rather than being baked into the golden. Default false.",
        },
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

export const topLevelLifecycleSchema = {
  type: "object",
  properties: {
    before_up: {
      ...lifecycleListSchema,
      description: "Commands to run before any service starts.",
    },
    after_up: {
      ...lifecycleListSchema,
      description: "Commands to run once all services are ready. Common spot for migrations and seeds.",
    },
    before_down: {
      ...lifecycleListSchema,
      description: "Commands to run before any service stops. Services are still alive here.",
    },
    after_down: {
      ...lifecycleListSchema,
      description: "Commands to run after all services have stopped. Use for external resource cleanup.",
    },
  },
  additionalProperties: false,
} as const;

export const perServiceLifecycleSchema = {
  type: "object",
  properties: {
    before_start: {
      ...lifecycleListSchema,
      description: "Commands to run before this service starts.",
    },
    after_ready: {
      ...lifecycleListSchema,
      description: "Commands to run once this service is ready.",
    },
    before_down: {
      ...lifecycleListSchema,
      description: "Commands to run before this service stops.",
    },
  },
  additionalProperties: false,
} as const;

/**
 * Scalar integer (`5432`), or block `{ container_port, published_env, host_port }`.
 * Bare `{ container_port: N }` (no `published_env`) is rejected by the parser —
 * use the scalar form instead. One way to say each thing.
 */
const portDescriptorSchema = {
  oneOf: [
    { type: "integer", minimum: 1, maximum: 65535 },
    {
      type: "object",
      properties: {
        container_port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Container-side port being published.",
        },
        published_env: {
          type: "string",
          description: "Env var name lich exposes the allocated host port as.",
        },
        host_port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Pin the host port to this exact value instead of letting lich allocate one.",
        },
      },
      additionalProperties: false,
    },
  ],
} as const;

const readyWhenSchema = {
  type: "object",
  properties: {
    http_get: {
      type: "string",
      description: "Path to probe (relative to the service's port). 200 OK = ready.",
    },
    tcp: {
      type: "string",
      description: "TCP `host:port` to probe. A successful connect = ready (no HTTP body check).",
    },
    log_match: {
      type: "string",
      description: "Regex matched against the service's log stream. A match = ready.",
    },
    cmd: {
      type: "string",
      description: "Shell command run periodically. Exit 0 = ready.",
    },
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
      description: "How long to wait for ready before giving up. Duration string (`30s`, `2m`) or positive integer ms.",
    },
    // Flat `key -> regex-pattern` map. Reject non-string values so typos
    // like `capture: { url: 42 }` surface as a clean schema error.
    capture: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Map of `key -> regex` for capturing values from logs (e.g. ephemeral tunnel URLs).",
    },
    extend_on_progress: {
      type: "boolean",
      description: "If true, `timeout` is the max acceptable silence between log lines (resets on each new line) instead of a wall-clock deadline. Total wait is unbounded as long as the service keeps producing output. Use for services that make real progress under contention. Default false.",
    },
  },
  additionalProperties: false,
} as const;

const failWhenSchema = {
  type: "object",
  properties: {
    log_match: {
      type: "string",
      description: "Regex matched against the log stream. A match marks the service as failed (short-circuits ready_when).",
    },
  },
  additionalProperties: false,
} as const;

// env_groups support a single parent (`extends: <string>`) and intentionally
// have no `env_files` field — only top-level stack composition does.
export const envGroupSchema = {
  type: "object",
  properties: {
    env_from: {
      ...envFromSchema,
      description: "Shell-out env sources for this group (inherited env vars or dynamic exports).",
    },
    env: {
      ...envMapSchema,
      description: "Literal env vars for this group. Use `null` to unset an inherited key.",
    },
    extends: {
      type: "string",
      description: "Name of another env_group whose resolved env this group inherits from.",
    },
    process_env: {
      type: "boolean",
      description: "Whether to inherit the parent shell's env (default true). Set false for a sealed group.",
    },
  },
  additionalProperties: false,
} as const;

// Compose-spec fields beyond the lich-owned ones are accepted opaquely;
// compose validates them itself when we shell out.
export const composeServiceSchema = {
  type: "object",
  properties: {
    compose_file: {
      type: "string",
      description: "Path to a sibling compose file holding this service (defaults to compose.yaml at the worktree root).",
    },
    service: {
      type: "string",
      description: "Name of the service inside the compose file. Defaults to the key under `services:` in lich.yaml.",
    },
    ports: {
      // Record form (logical name → descriptor) OR list form. Both accept
      // scalar (`5432` = container_port shorthand) and block forms.
      oneOf: [
        {
          type: "object",
          additionalProperties: portDescriptorSchema,
        },
        {
          type: "array",
          items: portDescriptorSchema,
        },
      ],
      description: "Ports to publish from container to host. Lich allocates host ports dynamically per worktree.",
    },
    lifecycle: {
      ...perServiceLifecycleSchema,
      description: "Per-service hooks (before_start, after_ready, before_down).",
    },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description: "Other services this one waits on before starting. Healthchecks gate readiness.",
    },
    image: {
      type: "string",
      description: "Container image reference (e.g. `postgres:16-alpine`). Compose-spec passthrough.",
    },
    environment: {
      description: "Env vars set inside the container. Compose-spec passthrough.",
    },
    healthcheck: {
      type: "object",
      additionalProperties: true,
      description: "Compose-spec healthcheck definition. Gates `depends_on` readiness.",
    },
    volumes: {
      type: "array",
      description: "Host or named volume mounts. Compose-spec passthrough.",
    },
    networks: {
      description: "Compose networks the service joins. Compose-spec passthrough.",
    },
    profiles: {
      type: "array",
      description: "Compose-spec profiles for this service.",
    },
    tmpfs: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description: "In-RAM mount paths. Use for dev databases that should disappear on `lich down`.",
    },
  },
  additionalProperties: false,
} as const;

// `owned_containers` declares a docker label or name pattern lich uses to
// force-clean stragglers (`docker rm -f`) after `stop_cmd` returns. Pair with
// oneshot services whose wrapped CLI sometimes misses containers (restart-backoff,
// etc.) and which carry Docker's `restart: always` policy.
const ownedContainersSchema = {
  type: "object",
  properties: {
    label: {
      type: "string",
      minLength: 1,
      description: "Docker label filter, e.g. `com.supabase.cli.project=${worktree.id}`. Survivors matching `docker ps -aq --filter label=<value>` are force-removed.",
    },
    name_pattern: {
      type: "string",
      minLength: 1,
      description: "Docker name filter, e.g. `supabase_*_${worktree.id}`. Survivors matching `docker ps -aq --filter name=<value>` are force-removed. Less precise than `label`; prefer `label` when the wrapped CLI sets one.",
    },
  },
  oneOf: [
    { required: ["label"], not: { required: ["name_pattern"] } },
    { required: ["name_pattern"], not: { required: ["label"] } },
  ],
  additionalProperties: false,
} as const;

const ownedDiscoverSchema = {
  type: "object",
  properties: {
    glob: {
      type: "string",
      minLength: 1,
      description: "Micromatch-style pattern matched against files under `discover.cwd` (or parent cwd).",
    },
    name_template: {
      type: "string",
      minLength: 1,
      description: "Template producing each synthetic service name. Supports `${var | filter}` grammar.",
    },
    cmd_template: {
      type: "string",
      minLength: 1,
      description: "Template producing each synthetic service's shell command. Supports `${var | filter}` grammar.",
    },
    cwd: {
      type: "string",
      description: "Glob root and per-instance working dir. Defaults to the parent entry's `cwd`.",
    },
  },
  required: ["glob", "name_template", "cmd_template"],
  additionalProperties: false,
} as const;

// Owned service shape — `oneOf` enforces one of two arms:
//   A) Hand-written: `cmd` required, NO `discover`.
//   B) Discovery: `discover` required (its template + glob describe per-
//      instance shape), NO `cmd` at the entry root.
// Mutual-exclusion error surfaces from the parse layer (config/discover.ts).
export const ownedServiceSchema = {
  type: "object",
  properties: {
    cmd: {
      type: "string",
      description: "Shell command to run for this service. Required unless `discover:` is set.",
    },
    cwd: {
      type: "string",
      description: "Working directory for the cmd, relative to the repo root. Defaults to the root.",
    },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description: "Other owned or compose services that must be ready before this one starts.",
    },
    port: {
      ...portDescriptorSchema,
      description: "Single allocated port for this service. Lich injects the host port as the named env var.",
    },
    ports: {
      type: "object",
      additionalProperties: portDescriptorSchema,
      description: "Multi-port shape — map of port-key to descriptor. Each gets its own injected env var.",
    },
    oneshot: {
      type: "boolean",
      description: "If true, lich runs cmd to completion (non-zero = fail) instead of supervising it. Pair with `stop_cmd`.",
    },
    stop_cmd: {
      type: "string",
      description: "Teardown command invoked on `lich down` / `lich nuke`. Used with `oneshot` to clean up side-effects.",
    },
    owned_containers: {
      ...ownedContainersSchema,
      description: "Docker label or name pattern. After `stop_cmd` runs, lich force-removes any container matching the filter (`docker rm -f`). Pick exactly one of `label` or `name_pattern`.",
    },
    env: {
      ...envMapSchema,
      description: "Service-scoped env vars. Merges with top-level `env:` — per-service wins on collision.",
    },
    env_files: {
      ...envFilesSchema,
      description: "Service-scoped dotenv files to load. Merges with top-level `env_files:`.",
    },
    env_from: {
      ...envFromSchema,
      description: "Service-scoped shell-out env sources. Merges with top-level — per-service wins on collision.",
    },
    ready_when: {
      ...readyWhenSchema,
      description: "Readiness probe for this service. Pick http_get, tcp, log_match, or cmd.",
    },
    fail_when: {
      ...failWhenSchema,
      description: "Hard-fail signal for this service. A match short-circuits ready_when and fails the stack.",
    },
    lifecycle: {
      ...perServiceLifecycleSchema,
      description: "Per-service hooks (before_start, after_ready, before_down).",
    },
    discover: {
      ...ownedDiscoverSchema,
      description: "Glob-based expansion: produces N synthetic owned services, one per matched file.",
    },
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
export const userCommandSchema = {
  type: "object",
  properties: {
    cmd: {
      type: "string",
      description: "Shell command run when the user invokes `lich <command-name>`.",
    },
    cwd: {
      type: "string",
      description: "Working directory for the cmd, relative to the repo root.",
    },
    env_group: {
      type: "string",
      description: "Name of an env_group whose env this command runs with (instead of the default stack env).",
    },
    env: {
      ...envMapSchema,
      description: "Extra env vars set when running this command. Merges with the stack or named group env.",
    },
    help: {
      type: "string",
      description: "Help text printed by `lich <command-name> --help`.",
    },
  },
  required: ["cmd"],
  additionalProperties: false,
} as const;

/**
 * Single profile entry. The `default: true` "exactly one" rule and name
 * collisions with built-in commands are enforced by `lich validate`, not
 * here (cross-property checks AJV doesn't express cleanly).
 */
export const profileSchema = {
  type: "object",
  properties: {
    services: {
      type: "array",
      items: { type: "string" },
      description: "Subset of top-level `services:` to start under this profile.",
    },
    owned: {
      type: "array",
      items: { type: "string" },
      description: "Subset of top-level `owned:` to start under this profile.",
    },
    extends: {
      oneOf: [
        { type: "string" },
        {
          type: "array",
          items: { type: "string" },
        },
      ],
      description: "Name or list of names of profiles this one inherits services, owned, env, and lifecycle from.",
    },
    default: {
      type: "boolean",
      description: "If true, `lich up` (no arg) picks this profile. Exactly one profile may set this.",
    },
    env: {
      ...envMapSchema,
      description: "Profile-scoped env vars. Override top-level on collision.",
    },
    env_files: {
      ...envFilesSchema,
      description: "Profile-scoped dotenv files. Merge with top-level.",
    },
    env_from: {
      ...envFromSchema,
      description: "Profile-scoped shell-out env sources. Merge with top-level.",
    },
    lifecycle: {
      ...topLevelLifecycleSchema,
      description: "Profile-scoped lifecycle hooks. Merge with top-level (LIFO on the down phases).",
    },
  },
  additionalProperties: false,
} as const;

export const runtimeSchema = {
  type: "object",
  properties: {
    compose_cli: {
      type: "string",
      enum: ["auto", "docker", "podman", "nerdctl"],
      description: "Which compose CLI to shell out to. `auto` detects what's installed (default and usually correct).",
    },
    // Deprecated alias for `compose_cli`.
    compose: {
      type: "string",
      enum: ["auto", "docker", "podman", "nerdctl"],
      description: "Deprecated alias for `compose_cli`. Prefer `compose_cli`.",
    },
    proxy_port: {
      type: "integer",
      minimum: 1,
      maximum: 65535,
      description: "Pin the dashboard reverse-proxy port. Default 3300; override via env LICH_PROXY_PORT.",
    },
    port_range: {
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 65535 },
      minItems: 2,
      maxItems: 2,
      description: "Two-element `[min, max]` range lich allocates dynamic host ports from.",
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
      description: "Stack-wide default for every owned service's `ready_when.timeout`. Per-service value overrides.",
    },
    kill_others_on_fail: {
      type: "boolean",
      description: "Cascade-kill siblings if one service fails during `lich up` startup. Default true.",
    },
    sandbox: {
      type: "object",
      additionalProperties: false,
      required: ["backend", "bake_inputs"],
      properties: {
        backend: { type: "string", enum: ["tart"] },
        image: { type: "string" },
        memory: { type: "integer", minimum: 512 },
        cpus: { type: "integer", minimum: 1 },
        warm_fork: { type: "boolean" },
        snapshot_store: { type: "string" },
        sync: {
          type: "object",
          additionalProperties: false,
          properties: {
            ignore: { type: "array", items: { type: "string" } },
            mutagen_flags: { type: "array", items: { type: "string" } },
          },
        },
        bake_inputs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Globs (relative to worktree) whose content is baked into the golden. Required.",
        },
        gc: {
          type: "object",
          additionalProperties: false,
          properties: {
            keep_per_profile: { type: "integer", minimum: 1 },
            max_total_gb: { type: "number", exclusiveMinimum: 0 },
          },
        },
      },
    },
  },
  additionalProperties: false,
} as const;

export const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://lich.sh/schema/v1.json",
  title: "lich.yaml (v1)",
  type: "object",
  properties: {
    version: {
      type: "string",
      description: "Schema version. Only `\"1\"` is supported.",
    },
    runtime: {
      ...runtimeSchema,
      description: "Compose CLI selection, proxy port pin, default ready-when timeout, and other engine knobs.",
    },
    services: {
      type: "object",
      additionalProperties: composeServiceSchema,
      description: "Docker-compose services lich orchestrates. Each entry becomes a compose service.",
    },
    owned: {
      type: "object",
      additionalProperties: ownedServiceSchema,
      description: "Host processes lich starts directly. Logs captured to `<LICH_HOME>/stacks/<id>/logs/<service>.log`.",
    },
    env: {
      ...envMapSchema,
      description: "Env vars exposed to every owned service. Use `${...}` interpolation to wire services together.",
    },
    env_files: {
      ...envFilesSchema,
      description: "Dotenv files loaded into the stack env (gitignored `.env` is the common pattern).",
    },
    env_from: {
      ...envFromSchema,
      description: "Shell-out sources for stack env (e.g. secret-manager exports like Infisical/1Password/Doppler).",
    },
    lifecycle: {
      ...topLevelLifecycleSchema,
      description: "Top-level hooks at stack boundaries: before_up, after_up, before_down, after_down.",
    },
    // Built-in group name `stack` is reserved — `propertyNames` rejects
    // redeclaration at parse time.
    env_groups: {
      type: "object",
      propertyNames: { not: { const: "stack" } },
      additionalProperties: envGroupSchema,
      description: "Named env-var bundles for `lich exec --env-group` and `lifecycle.*[].env_group:`.",
    },
    commands: {
      type: "object",
      additionalProperties: userCommandSchema,
      description: "Custom CLI commands invoked via `lich <name>`. Inherit the stack's env by default.",
    },
    profiles: {
      type: "object",
      additionalProperties: profileSchema,
      description: "Named subsets of the stack — pick a service set and env for a given run.",
    },
  },
  required: ["version"],
  additionalProperties: false,
} as const;

export default schema;
