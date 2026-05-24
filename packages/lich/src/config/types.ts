/**
 * TypeScript types for a parsed lich.yaml (Plan 1 subset).
 *
 * These types mirror the JSON Schema in `./schema.ts` — hand-rolled rather
 * than generated, both because the schema is small and because we want
 * to control naming/optionality precisely.
 *
 * Plan-1 scope: `version`, `services`, `owned`, `env`, `env_files`,
 * `env_from`, `lifecycle`, `runtime`.
 *
 * Sections owned by later plans (`env_groups`, `commands`, `profiles`) are
 * typed as opaque records here. Plans 2-4 will replace these placeholders
 * with proper shapes once those features are implemented.
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
 * `ready_when` block (Plan 1 subset). `capture` and `timeout` are accepted
 * here but their shapes will be tightened in Plan 4.
 */
export interface ReadyWhen {
  http_get?: string;
  tcp?: string;
  log_match?: string;
  cmd?: string;
  /** Plan-4 placeholder — any type for now. */
  timeout?: unknown;
  /** Plan-4 placeholder. */
  capture?: Record<string, unknown>;
}

/** `fail_when` is fully owned by Plan 4; accept-as-opaque here. */
export type FailWhen = Record<string, unknown>;

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

  // ----- Sections owned by later plans — opaque placeholders for now. -----
  /** Plan 2 will replace this. */
  env_groups?: Record<string, unknown>;
  /** Plan 2 will replace this. */
  commands?: Record<string, unknown>;
  /** Plan 3 will replace this. */
  profiles?: Record<string, unknown>;
}
