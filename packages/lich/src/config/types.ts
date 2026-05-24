/**
 * TypeScript types for a parsed lich.yaml (Plan 1 + Plan 2 subset).
 *
 * These types mirror the JSON Schema in `./schema.ts` — hand-rolled rather
 * than generated, both because the schema is small and because we want
 * to control naming/optionality precisely.
 *
 * Plan-1 scope: `version`, `services`, `owned`, `env`, `env_files`,
 * `env_from`, `lifecycle`, `runtime`.
 *
 * Plan-2 scope: `env_groups`, `commands` (now strict shapes — see
 * `EnvGroupDef` and `UserCommandDef` below).
 *
 * Sections owned by later plans (`profiles`) are still typed as opaque
 * records here. Plan 3 will replace that placeholder.
 *
 * Likewise a handful of fields *inside* services/owned that belong to later
 * plans (`ready_when.capture`, `ready_when.timeout`, `fail_when`) are
 * typed permissively here and will be tightened in Plan 4.
 *
 * Source-of-truth for field names and semantics:
 *   docs/superpowers/specs/2026-05-23-lich-v1-design.md (section 4).
 */

// ---------------------------------------------------------------------------
// Env primitives
// ---------------------------------------------------------------------------

/**
 * A value that may appear in an env map. The spec allows strings (the normal
 * case, supports `${...}` interpolation) plus numbers/booleans (coerced to
 * strings at resolve time).
 */
export type EnvValue = string | number | boolean;

/** Map of env var name -> value. */
export type EnvMap = Record<string, EnvValue>;

/** List of dotenv file paths (top-level or per-service). */
export type EnvFiles = string[];

/** A single entry in the `env_from` list. */
export type EnvFromEntry =
  | string
  | {
      cmd: string;
      format?: "dotenv" | "json";
      cwd?: string;
    };

export type EnvFrom = EnvFromEntry[];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type LifecycleEntry =
  | string
  | {
      cmd: string;
      env_group?: string;
      cwd?: string;
    };

export type LifecycleList = LifecycleEntry[];

export interface TopLevelLifecycle {
  before_up?: LifecycleList;
  after_up?: LifecycleList;
  before_down?: LifecycleList;
}

export interface PerServiceLifecycle {
  before_start?: LifecycleList;
  after_ready?: LifecycleList;
  before_down?: LifecycleList;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Logical port descriptor. Either a pinned host port integer or an object
 * with `env`, `host_port`, and/or `container`.
 *
 * `container` is only meaningful for compose services (where lich emits a
 * `<hostPort>:<containerPort>` binding in the compose override). Owned
 * services don't expose a container port — only `env` / `host_port` apply
 * there. The field is permitted on the union for shape symmetry; the
 * override generator and validate command read it where it makes sense.
 */
export type PortDescriptor =
  | number
  | {
      env?: string;
      host_port?: number;
      container?: number;
    };

// ---------------------------------------------------------------------------
// ready_when / fail_when
// ---------------------------------------------------------------------------

/**
 * `ready_when` block (Plan 1 subset). `timeout` is still accepted as a
 * placeholder here and will be tightened in Plan 4 Task 5.
 *
 * `capture` is Plan-4 Task 6's contract: a flat `key -> regex-string` map.
 * Each value is a regex PATTERN string (compiled at validate time + at
 * extraction time). The extractor (`src/ready/capture.ts`) returns
 * `Record<string, string>` of the matched values for downstream
 * interpolation as `${owned.<name>.captured.<key>}`. Per the spec we
 * deliberately do not support multiple regex groups per pattern — the
 * extractor uses group 1 if a `(...)` group is declared, otherwise the full
 * match. Users wanting multiple values declare multiple captures.
 */
export interface ReadyWhen {
  http_get?: string;
  tcp?: string;
  log_match?: string;
  cmd?: string;
  /** Plan-4 placeholder — any type for now. */
  timeout?: unknown;
  /**
   * Map of capture name → regex pattern. After `ready_when` fires, the
   * orchestrator runs each regex against the service's accumulated log
   * buffer and exposes the matches as `${owned.<name>.captured.<key>}`.
   * A missing match aborts the up with a `CaptureMissError`.
   */
  capture?: Record<string, string>;
}

/**
 * `fail_when` block (Plan 4 Task 7 — initial tightening to `log_match` only).
 *
 * The block currently exposes a single field:
 *   - `log_match`: a regex (string form) tested against each complete log
 *     line emitted by the service. The first match aborts the service's
 *     startup. See `failure/fail-when.ts` for the watcher; see
 *     `commands/validate.ts` for the `lich validate` compile-check.
 *
 * Locked down with `additionalProperties: false` in the schema so typos
 * (`fail_when: { log_matc: "..." }`) and not-yet-supported keys
 * (`exit_code`, `oom_score`, etc.) are caught at `lich validate` time.
 * Future plans may add more fields here; this is the v1 surface.
 */
export interface FailWhen {
  /**
   * Regex (string form) tested against each complete log line. First
   * match fires the watcher and aborts service startup. Pattern compile
   * happens at validate time (see `commands/validate.ts`'s
   * `checkRegexes`); the runtime watcher gets a pre-compiled `RegExp`.
   */
  log_match?: string;
}

// ---------------------------------------------------------------------------
// services (compose-backed)
// ---------------------------------------------------------------------------

export interface ComposeService {
  // Plan-1 fields.
  compose_file?: string;
  service?: string;
  /**
   * Logical-name -> port-descriptor map (matches dogfood-style shape), OR
   * a list of `{ container, env?, host_port? }` entries (compose-spec shape).
   */
  ports?:
    | Record<string, PortDescriptor>
    | Array<{ container: number; env?: string; host_port?: number }>;
  lifecycle?: PerServiceLifecycle;
  depends_on?: string[];

  // Compose-spec passthroughs — accepted opaquely, compose will validate
  // them when we shell out.
  image?: string;
  environment?: unknown;
  healthcheck?: Record<string, unknown>;
  volumes?: unknown[];
  networks?: unknown;
  profiles?: unknown[];
}

// ---------------------------------------------------------------------------
// owned (host processes)
// ---------------------------------------------------------------------------

export interface OwnedService {
  cmd: string;
  cwd?: string;
  depends_on?: string[];
  /** Single-port shape: `port: { env: PORT }` */
  port?: PortDescriptor;
  /** Multi-port shape: `ports: { api: {...}, db: {...} }` */
  ports?: Record<string, PortDescriptor>;
  oneshot?: boolean;
  stop_cmd?: string;
  env?: EnvMap;
  env_files?: EnvFiles;
  env_from?: EnvFrom;
  ready_when?: ReadyWhen;
  fail_when?: FailWhen;
  lifecycle?: PerServiceLifecycle;
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

export interface Runtime {
  /**
   * Which compose CLI to shell out to. `auto` (default) probes for
   * `docker compose`, then `podman compose`, then `nerdctl compose`
   * in that order. See `src/compose/detect.ts`.
   *
   * The canonical name is `compose_cli`. The `compose` alias is
   * preserved (with identical semantics) for back-compat with earlier
   * design-spec drafts that wrote it as `runtime.compose`; new configs
   * should use `compose_cli`.
   */
  compose_cli?: "auto" | "docker" | "podman" | "nerdctl";
  /** Deprecated alias for `compose_cli` — same semantics. */
  compose?: "auto" | "docker" | "podman" | "nerdctl";
  proxy_port?: number;
  port_range?: [number, number];
}

// ---------------------------------------------------------------------------
// env_groups (Plan 2)
// ---------------------------------------------------------------------------

/**
 * A user-defined named env group. Plan 2 introduces `env_groups:` as a
 * top-level config section; this interface types one entry inside that map.
 *
 * The built-in group `stack` is NOT represented here — it's auto-populated
 * from the top-level env pipeline (see `src/groups/built-in-stack.ts` in
 * Plan 2). The schema rejects `env_groups.stack` so user configs cannot
 * redeclare it.
 *
 * `extends` is single-string only — env_groups support exactly one parent.
 * (Profiles support a list of names; env_groups do not. See spec section 4.)
 *
 * Spec source: `docs/superpowers/specs/2026-05-23-lich-v1-design.md`,
 * section 4 (`env_groups`).
 */
export interface EnvGroupDef {
  /** Shell-out / dotenv-file entries layered before `env` literals. */
  env_from?: EnvFrom;
  /** Literal `KEY: VALUE` map, layered last (wins over `env_from`). */
  env?: EnvMap;
  /**
   * Name of the parent group to extend. Resolution starts with the parent
   * (recursively), then this group's `env_from` + `env` layer on top.
   * `extends: stack` opts back into the built-in stack group's env.
   */
  extends?: string;
  /**
   * Whether to overlay `process.env` at the outermost resolution call.
   * Defaults to `true`. Set to `false` to make a group hermetic — useful
   * for isolated tool envs that shouldn't see the user's shell exports.
   */
  process_env?: boolean;
}

// ---------------------------------------------------------------------------
// commands (Plan 2 — user-defined commands)
// ---------------------------------------------------------------------------

/**
 * A user-defined command, invokable as `lich <name>`. Plan 2 introduces
 * `commands:` as a top-level config section; this interface types one entry
 * inside that map.
 *
 * Built-in commands always win on name conflict; `lich validate` refuses
 * configs whose user-command names shadow a built-in (see Plan 2 Task 14).
 *
 * Argv after the name is forwarded as positional args to the underlying
 * shell command via `/bin/sh -c <cmd> -- "$@"`.
 *
 * Spec source: `docs/superpowers/specs/2026-05-23-lich-v1-design.md`,
 * section 4 (`commands`).
 */
export interface UserCommandDef {
  /** Shell command to execute. Required. */
  cmd: string;
  /** Working directory, relative to the project root. Defaults to `.`. */
  cwd?: string;
  /**
   * Name of the env_group whose resolved env is loaded into the child.
   * Defaults to `"stack"` (the built-in group). May be overridden at
   * invocation time via the universal `--env-group=<name>` flag.
   */
  env_group?: string;
  /** Per-command env literals, layered on top of the resolved group env. */
  env?: EnvMap;
  /**
   * Free-form help text shown by `lich help <name>` and summarised (first
   * line) in `lich help`'s command listing.
   */
  help?: string;
}

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export interface LichConfig {
  version: string;
  runtime?: Runtime;
  services?: Record<string, ComposeService>;
  owned?: Record<string, OwnedService>;
  env?: EnvMap;
  env_files?: EnvFiles;
  env_from?: EnvFrom;
  lifecycle?: TopLevelLifecycle;

  /**
   * Named env groups (Plan 2). Keyed by group name; values are
   * {@link EnvGroupDef} entries. The built-in `stack` group is implicit
   * and may not be redeclared here (the schema rejects it).
   */
  env_groups?: Record<string, EnvGroupDef>;
  /**
   * User-defined commands (Plan 2). Keyed by command name (invoked as
   * `lich <name>`); values are {@link UserCommandDef} entries.
   */
  commands?: Record<string, UserCommandDef>;

  // ----- Sections owned by later plans — opaque placeholders for now. -----
  /** Plan 3 will replace this. */
  profiles?: Record<string, unknown>;
}
