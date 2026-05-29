/**
 * Value type for `env:` map entries. `null` is an explicit unset marker —
 * keys with final value `null` are removed from the resolved env (not
 * equivalent to empty string). See `env/resolve.ts`.
 */
export type EnvValue = string | number | boolean | null;

export type EnvMap = Record<string, EnvValue>;

export type EnvFiles = string[];

export type EnvFromEntry =
  | string
  | {
      cmd: string;
      format?: "dotenv" | "json";
      cwd?: string;
    };

export type EnvFrom = EnvFromEntry[];

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
  /** Runs AFTER all services have stopped — for external resource cleanup. */
  after_down?: LifecycleList;
}

export interface PerServiceLifecycle {
  before_start?: LifecycleList;
  after_ready?: LifecycleList;
  before_down?: LifecycleList;
}

export type PortDescriptor =
  | number
  | {
      env?: string;
      host_port?: number;
      container?: number;
    };

export interface ReadyWhen {
  http_get?: string;
  tcp?: string;
  log_match?: string;
  cmd?: string;
  /** Duration string (`500ms`, `30s`, `2m`, `1h`) or positive integer (ms). */
  timeout?: string | number;
  /** Capture name → regex pattern; matches surface as `${owned.<name>.captured.<key>}`. */
  capture?: Record<string, string>;
}

export interface FailWhen {
  /** Regex (string form) tested against each complete log line; first match aborts startup. */
  log_match?: string;
}

export interface ComposeService {
  compose_file?: string;
  service?: string;
  ports?:
    | Record<string, PortDescriptor>
    | Array<{ container: number; env?: string; host_port?: number }>;
  lifecycle?: PerServiceLifecycle;
  depends_on?: string[];

  // Compose-spec passthroughs — emitted verbatim into the override.
  image?: string;
  environment?: unknown;
  healthcheck?: Record<string, unknown>;
  volumes?: unknown[];
  networks?: unknown;
  profiles?: unknown[];
  tmpfs?: string[] | string;
}

/**
 * Glob-based service discovery. When set on an owned entry, parse expands it
 * into N synthetic owned services (one per matched file) and removes the
 * discover entry. Mutually exclusive with `cmd:` on the parent.
 *
 * Template grammar (name_template + cmd_template):
 *   `${var}` or `${var | filter1 | filter2:arg}`
 *   Vars: `basename`, `basename_no_ext`, `dirname`
 *   Filters: `kebab`, `snake`, `strip_suffix:X`, `strip_prefix:X`
 */
export interface OwnedDiscover {
  /** Micromatch-style glob, relative to `discover.cwd` (or parent's `cwd` if unset). */
  glob: string;
  /** Template producing the synthetic service name. Required. */
  name_template: string;
  /** Template producing the per-instance shell command. Required. */
  cmd_template: string;
  /** Glob root + per-instance cwd. Defaults to the parent's `cwd`. */
  cwd?: string;
}

export interface OwnedService {
  /** Required for hand-written entries; omitted when `discover:` is set. */
  cmd?: string;
  cwd?: string;
  depends_on?: string[];
  port?: PortDescriptor;
  ports?: Record<string, PortDescriptor>;
  oneshot?: boolean;
  stop_cmd?: string;
  env?: EnvMap;
  env_files?: EnvFiles;
  env_from?: EnvFrom;
  ready_when?: ReadyWhen;
  fail_when?: FailWhen;
  lifecycle?: PerServiceLifecycle;
  /** Mutually exclusive with `cmd:`. See {@link OwnedDiscover}. */
  discover?: OwnedDiscover;
}

export interface Runtime {
  /** `auto` probes docker → podman → nerdctl. */
  compose_cli?: "auto" | "docker" | "podman" | "nerdctl";
  /** Deprecated alias for `compose_cli`. */
  compose?: "auto" | "docker" | "podman" | "nerdctl";
  proxy_port?: number;
  port_range?: [number, number];
  /** Stack-wide default for owned services' `ready_when.timeout`. */
  ready_when_timeout?: string | number;
  /** Cascade-kill siblings on startup failure. Defaults to `true`. */
  kill_others_on_fail?: boolean;
}

export interface EnvGroupDef {
  env_from?: EnvFrom;
  env?: EnvMap;
  /** Single parent group name. Use `stack` to extend the built-in. */
  extends?: string;
  /** Defaults to `true`; set `false` to make the group hermetic from `process.env`. */
  process_env?: boolean;
}

export interface UserCommandDef {
  cmd: string;
  cwd?: string;
  /** Defaults to `"stack"`. Override per-invocation with `--env-group=<name>`. */
  env_group?: string;
  env?: EnvMap;
  help?: string;
}

export interface ProfileDef {
  services?: string[];
  owned?: string[];
  /** Single parent name or list of parents (later parent wins on collision). */
  extends?: string | string[];
  /** Exactly zero or one profile may set this; activated by `lich up` (no arg). */
  default?: boolean;
  env?: EnvMap;
  env_files?: EnvFiles;
  env_from?: EnvFrom;
  /**
   * Same shape as {@link TopLevelLifecycle}. `before_up`/`after_up` run
   * top-level then profile; `before_down`/`after_down` run profile then
   * top-level (LIFO).
   */
  lifecycle?: TopLevelLifecycle;
}

export interface LichConfig {
  version: string;
  runtime?: Runtime;
  services?: Record<string, ComposeService>;
  owned?: Record<string, OwnedService>;
  env?: EnvMap;
  env_files?: EnvFiles;
  env_from?: EnvFrom;
  lifecycle?: TopLevelLifecycle;

  /** Built-in `stack` group is implicit; the schema rejects redeclaration. */
  env_groups?: Record<string, EnvGroupDef>;
  commands?: Record<string, UserCommandDef>;
  /** When absent or empty, every declared service / owned process starts. */
  profiles?: Record<string, ProfileDef>;
}
