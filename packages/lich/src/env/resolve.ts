/**
 * Env resolution pipeline. Combines env from every source defined in lich.yaml
 * into a single resolved env map for a given service.
 *
 * Precedence (later wins, per-key):
 *
 *    1. host `process.env`
 *    2. auto-injected lich vars (LICH_WORKTREE, LICH_STACK_ID, and LICH_PROFILE
 *       when a profile is active)
 *    3. top-level `env_from` (shell-out, declared order)
 *    4. top-level `env_files` (dotenv, declared order)
 *    5. top-level `env` literals
 *    6. profile `env_from`     (only when `input.profile` is set)
 *    7. profile `env_files`    (only when `input.profile` is set)
 *    8. profile `env` literals (only when `input.profile` is set)
 *    9. per-service `env_from`
 *   10. per-service `env_files`
 *   11. per-service `env` literals
 *
 * Auto-injects sit just above process.env so user layers can override them
 * per-key. After merging, `null` values (the unset sentinel from
 * `env: { VAR: null }`) are dropped — see `dropNullValues`. Finally,
 * `interpolateRecord` runs once over the merged map against an
 * InterpolationContext built from worktree + ports + captures. Per-key
 * laziness: a value overridden by a later layer never sees the earlier
 * layer's interpolation (Object.assign replaces the string before
 * interpolation runs).
 */

import { resolve as resolvePath, isAbsolute } from "node:path";
import { existsSync } from "node:fs";

import type { LichConfig, EnvMap, EnvFiles, EnvFrom } from "../config/types.js";
import {
  interpolateRecord,
  type InterpolationContext,
} from "../config/interpolation.js";
import type { ResolvedProfile } from "../profiles/resolve.js";
import type { Worktree } from "../worktree/detect.js";

import { loadEnvFiles } from "./files.js";
import { loadEnvFromShellOut } from "./shell-out.js";

/**
 * The service-independent env layers (process.env + auto-injects + top-level +
 * profile), merged but NOT yet interpolated and with `null` unset-markers
 * retained. Produced by {@link resolveSharedEnvBase}; pre-interpolation so each
 * service can still interpolate against its own capture context.
 */
export type SharedEnvBase = Record<string, string | null>;

export interface ResolveEnvForServiceInput {
  config: LichConfig;
  service:
    | { kind: "compose"; name: string }
    | { kind: "owned"; name: string };
  /** Worktree info — supplies LICH_WORKTREE, LICH_STACK_ID, and `${worktree.*}` refs. */
  worktree: Worktree;
  allocatedPorts: {
    /** Compose service name -> logical port name -> host port. */
    compose: Record<string, Record<string, number>>;
    /** Owned service name -> either `{ port }` or `{ ports: { key: port } }`. */
    owned: Record<string, { port?: number; ports?: Record<string, number> }>;
  };
  /**
   * Captured values from owned services' `ready_when.capture`, keyed by
   * owned-service name. Populated by `up` as services become ready in
   * dependency order, so later levels see captures from earlier levels.
   * Omit if no captures are available (validate, env-only flows, tests) —
   * any `${owned.<name>.captured.<key>}` reference would then surface an
   * InterpolationError.
   */
  capturedValues?: Record<string, Record<string, string>>;
  /** Process env (defaults to `process.env` at call time). */
  processEnv?: NodeJS.ProcessEnv;
  /** Project root for relative env_files paths AND env_from cwd default. */
  projectRoot: string;
  /**
   * Override for the env_files fallback root. Defaults to `worktree.main_path`
   * (the parent of the shared `.git` dir), so a `.env` kept only in the main
   * checkout is transparently visible from `git worktree`-created secondary
   * worktrees without symlinks. Tests pin this explicitly; product callers
   * should leave it unset and let it derive from `worktree`. Absolute
   * `env_files` paths are never re-resolved against the fallback.
   */
  projectRootFallback?: string;
  /**
   * Active profile. When set, the profile's `env_from`/`env_files`/`env`
   * layer between top-level and per-service, and `LICH_PROFILE` is
   * auto-injected. When omitted, behavior matches the no-profile pipeline.
   */
  profile?: ResolvedProfile;
  /**
   * Precomputed shared base from {@link resolveSharedEnvBase}. When supplied,
   * the process.env/auto-inject/top-level/profile layers are NOT re-resolved —
   * critically, their `env_from` shell-outs do not re-run. Callers resolving
   * many services in one pass (e.g. `lich up`) compute this once and pass it to
   * every call. Must derive from the same worktree/profile/config as this call.
   */
  baseEnv?: SharedEnvBase;
}

export type ResolveTopLevelEnvInput = Omit<
  ResolveEnvForServiceInput,
  "service"
>;

/**
 * Coerce EnvMap values to `string | null`. Strings pass through; numbers/booleans
 * stringify (env is always string at the OS level); `null` survives as the unset
 * sentinel — filtered by `dropNullValues` at the end.
 */
function literalsToStrings(
  literals: EnvMap | undefined,
): Record<string, string | null> {
  if (!literals) return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(literals)) {
    if (v === undefined) continue;
    if (v === null) {
      out[k] = null;
      continue;
    }
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Drop keys whose final value is `null` from the merged env. Happens AFTER
 * all layering so a per-service `env: { FOO: null }` correctly wins over a
 * top-level `env: { FOO: "x" }` (per-service is the last layer), and a
 * top-level `env: { FOO: null }` correctly wins over a parent-shell
 * `FOO=parent` (top-level literal beats process.env in the precedence chain).
 * Runs before interpolation so the engine never sees `null`.
 */
function dropNullValues(
  merged: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

/**
 * Copy process.env into a `Record<string, string | null>`. Drops `undefined`
 * values (which would break interpolation). The `| null` is for layering
 * compatibility — process.env never produces null, but later layers may.
 */
function processEnvToRecord(
  pe: NodeJS.ProcessEnv,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(pe)) {
    const v = pe[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function absolutizeFiles(
  files: EnvFiles | undefined,
  projectRoot: string,
  projectRootFallback?: string,
): string[] {
  if (!files || files.length === 0) return [];
  const hasFallback =
    projectRootFallback !== undefined && projectRootFallback !== projectRoot;
  return files.map((f) => {
    const primary = resolvePath(projectRoot, f);
    if (!hasFallback) return primary;
    if (isAbsolute(f)) return primary;
    if (existsSync(primary)) return primary;
    const fallback = resolvePath(projectRootFallback, f);
    if (existsSync(fallback)) return fallback;
    return primary;
  });
}

/**
 * Auto-injects derived from worktree (plus active profile name). Placed just
 * above process.env so user layers can override per-key. LICH_PROFILE only
 * injected when a profile is active (not "always present, possibly empty").
 */
function autoInjects(
  worktree: Worktree,
  profileName?: string,
): Record<string, string> {
  const injects: Record<string, string> = {};
  if (worktree.name) injects.LICH_WORKTREE = worktree.name;
  if (worktree.stack_id) injects.LICH_STACK_ID = worktree.stack_id;
  if (profileName) injects.LICH_PROFILE = profileName;
  return injects;
}

/**
 * Build the InterpolationContext from worktree + allocated ports + captures.
 *
 * Compose `services.*` exposes two facets:
 *   - `host_port`: the primary port (first declared, via Object.keys insertion order)
 *   - `ports`: full per-service map (numeric strings for array-form, declared
 *     logical names for Record-form), used by multi-port shapes like
 *     `host_port_<idx>` and `ports.<key>`.
 */
function buildInterpolationContext(
  worktree: Worktree,
  allocatedPorts: ResolveEnvForServiceInput["allocatedPorts"],
  capturedValues:
    | ResolveEnvForServiceInput["capturedValues"]
    | undefined,
): InterpolationContext {
  const services: InterpolationContext["services"] = {};
  for (const [name, ports] of Object.entries(allocatedPorts.compose)) {
    const keys = Object.keys(ports);
    services[name] = {
      host_port: keys.length > 0 ? ports[keys[0]] : undefined,
      ports: { ...ports },
    };
  }

  const owned: InterpolationContext["owned"] = {};
  for (const [name, entry] of Object.entries(allocatedPorts.owned)) {
    owned[name] = {
      port: entry.port,
      ports: entry.ports,
    };
  }
  // Layer in captured values; may include services not in the port map (an
  // owned service without a declared port still gets capture support).
  if (capturedValues) {
    for (const [name, captured] of Object.entries(capturedValues)) {
      const existing = owned[name] ?? {};
      owned[name] = {
        ...existing,
        captured,
      };
    }
  }

  return {
    worktree: {
      name: worktree.name,
      id: worktree.id,
      path: worktree.path,
    },
    services,
    owned,
  };
}

/**
 * Layer one bundle of {env_from, env_files, env} onto the running merged env.
 * Used twice — top-level and per-service. `into` carries `string | null`:
 * `null` is the unset sentinel, dropped only at the very end so a per-service
 * `env: { FOO: null }` correctly wins over a top-level literal.
 *
 * `env_from` children see the current merged env (so per-service env_from
 * inherits top-level auth tokens). Null markers stripped before handing to
 * the child — Node's spawn stringifies `null` to the literal `"null"`.
 */
async function layerBundle(args: {
  into: Record<string, string | null>;
  env_from: EnvFrom | undefined;
  env_files: EnvFiles | undefined;
  env: EnvMap | undefined;
  projectRoot: string;
  projectRootFallback?: string;
}): Promise<Record<string, string | null>> {
  const { into, env_from, env_files, env, projectRoot, projectRootFallback } = args;

  if (env_from && env_from.length > 0) {
    const fromShell = await loadEnvFromShellOut({
      entries: env_from,
      baseEnv: dropNullValues(into),
      defaultCwd: projectRoot,
    });
    Object.assign(into, fromShell);
  }

  if (env_files && env_files.length > 0) {
    const fromFiles = await loadEnvFiles({
      files: absolutizeFiles(env_files, projectRoot, projectRootFallback),
    });
    Object.assign(into, fromFiles);
  }

  if (env) {
    Object.assign(into, literalsToStrings(env));
  }

  return into;
}

/**
 * Look up a per-service env bundle by service kind and name. Compose services
 * don't have per-service env layers on the lich side (compose handles its own
 * `environment:`); returns an empty bundle for compose. Missing services
 * return empty rather than throwing — validation upstream catches them.
 */
function getServiceBundle(
  config: LichConfig,
  service: ResolveEnvForServiceInput["service"],
): { env_from?: EnvFrom; env_files?: EnvFiles; env?: EnvMap } {
  if (service.kind === "compose") {
    return {};
  }
  const owned = config.owned?.[service.name];
  if (!owned) return {};
  return {
    env_from: owned.env_from,
    env_files: owned.env_files,
    env: owned.env,
  };
}

/**
 * Resolve the service-independent env layers — process.env, auto-injects,
 * top-level, and profile — into a pre-interpolation {@link SharedEnvBase}.
 * This is where the top-level/profile `env_from` shell-outs run; computing it
 * once and threading it back via `input.baseEnv` keeps those commands from
 * re-running for every service. Returns a fresh object each call (a clone when
 * `baseEnv` is supplied), so callers may safely layer onto the result.
 */
export async function resolveSharedEnvBase(
  input: ResolveTopLevelEnvInput,
): Promise<SharedEnvBase> {
  if (input.baseEnv !== undefined) return { ...input.baseEnv };

  const processEnv = input.processEnv ?? process.env;
  let merged: SharedEnvBase = processEnvToRecord(processEnv);
  Object.assign(merged, autoInjects(input.worktree, input.profile?.name));

  merged = await layerBundle({
    into: merged,
    env_from: input.config.env_from,
    env_files: input.config.env_files,
    env: input.config.env,
    projectRoot: input.projectRoot,
    projectRootFallback: input.projectRootFallback ?? input.worktree.main_path,
  });

  if (input.profile) {
    merged = await layerBundle({
      into: merged,
      env_from: input.profile.env_from,
      env_files: input.profile.env_files,
      env: input.profile.env,
      projectRoot: input.projectRoot,
    });
  }

  return merged;
}

/**
 * Fully resolve env for one service. Throws `ShellOutError` on env_from failure,
 * the error from `loadEnvFiles` on dotenv parse failure, and `InterpolationError`
 * on `${...}` resolution failure.
 */
export async function resolveEnvForService(
  input: ResolveEnvForServiceInput,
): Promise<Record<string, string>> {
  let merged = await resolveSharedEnvBase(input);

  const bundle = getServiceBundle(input.config, input.service);
  merged = await layerBundle({
    into: merged,
    env_from: bundle.env_from,
    env_files: bundle.env_files,
    env: bundle.env,
    projectRoot: input.projectRoot,
    projectRootFallback: input.projectRootFallback ?? input.worktree.main_path,
  });

  const finalEnv = dropNullValues(merged);

  const ctx = buildInterpolationContext(
    input.worktree,
    input.allocatedPorts,
    input.capturedValues,
  );
  const interpolated = interpolateRecord(
    finalEnv,
    ctx,
    `env:${input.service.kind}:${input.service.name}`,
  );

  return interpolated;
}

/**
 * Resolve env for the "no specific service" case (lifecycle hooks, `lich exec`,
 * `lich env stack`). Same as `resolveEnvForService` minus the per-service layer.
 */
export async function resolveTopLevelEnv(
  input: ResolveTopLevelEnvInput,
): Promise<Record<string, string>> {
  const merged = await resolveSharedEnvBase(input);

  const finalEnv = dropNullValues(merged);

  const ctx = buildInterpolationContext(
    input.worktree,
    input.allocatedPorts,
    input.capturedValues,
  );
  return interpolateRecord(finalEnv, ctx, "env:top-level");
}
