/**
 * Env resolution pipeline (Plan 1 Task 13; Plan 3 Task 6 added the profile layer).
 *
 * Combines env from every source defined in lich.yaml into a single
 * resolved env map for a given service (or for the "no specific service"
 * case used by lifecycle hooks).
 *
 * Precedence (later wins, per-key), matching the design spec section 4:
 *
 *    1. host `process.env`
 *    2. auto-injected lich vars (LICH_WORKTREE, LICH_STACK_ID, LICH_PROFILE
 *       when a profile is active)
 *    3. top-level `env_from`  (shell-out, in declared order)
 *    4. top-level `env_files` (dotenv, in declared order)
 *    5. top-level `env` literals
 *    6. profile `env_from`     (only when `input.profile` is set)
 *    7. profile `env_files`    (only when `input.profile` is set)
 *    8. profile `env` literals (only when `input.profile` is set)
 *    9. per-service `env_from`
 *   10. per-service `env_files`
 *   11. per-service `env` literals
 *
 * Auto-injects sit at the lowest priority that still beats `process.env`
 * so the user's env layers can deliberately override them if needed
 * (rare, but supported — the spec says these are "always available", not
 * "always frozen"). In practice nothing user-written touches them, so
 * they end up visible to every spawned child.
 *
 * After merging, every value goes through {@link interpolateRecord} once
 * against an {@link InterpolationContext} built from the worktree info
 * and the allocated-ports map. This is the single point where `${...}`
 * references in env values are resolved (Plan 3 Task 7 will verify that
 * eager interpolation is correctly lazy-per-key for env values: a key whose
 * value is overridden by a later layer never sees the earlier layer's
 * interpolation, because the earlier layer's string was already replaced
 * before interpolation ran).
 *
 * Profiles (precedence steps 6-8 above) layer between top-level and
 * per-service. When `input.profile` is undefined, the profile layer is
 * skipped entirely and behavior matches the Plan-1 pipeline exactly.
 */

import { resolve as resolvePath } from "node:path";

import type { LichConfig, EnvMap, EnvFiles, EnvFrom } from "../config/types.js";
import {
  interpolateRecord,
  type InterpolationContext,
} from "../config/interpolation.js";
import type { ResolvedProfile } from "../profiles/resolve.js";
import type { Worktree } from "../worktree/detect.js";

import { loadEnvFiles } from "./files.js";
import { loadEnvFromShellOut } from "./shell-out.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolveEnvForServiceInput {
  config: LichConfig;
  /** Which service's env to resolve. */
  service:
    | { kind: "compose"; name: string }
    | { kind: "owned"; name: string };
  /** Resolved worktree info (provides LICH_WORKTREE, LICH_STACK_ID, and ${worktree.*} refs). */
  worktree: Worktree;
  /** Allocated ports — used to build the InterpolationContext. */
  allocatedPorts: {
    /** Compose service name -> logical port name -> host port. */
    compose: Record<string, Record<string, number>>;
    /** Owned service name -> either { port } or { ports: { key: port } }. */
    owned: Record<string, { port?: number; ports?: Record<string, number> }>;
  };
  /**
   * Plan-4 (LEV-361) captured values from owned services'
   * `ready_when.capture` extractions, keyed by owned-service name. Each
   * inner record maps capture-key -> matched-string. Populated by the
   * `up` orchestrator (Task 14) as services become ready in dependency
   * order, so later levels see captures from earlier levels.
   *
   * Optional — callers that haven't run any owned services through
   * capture (validate, env-only flows, tests) may omit this and the
   * interpolation context will simply have no `captured` maps. Any
   * `${owned.<name>.captured.<key>}` reference in that state surfaces
   * an InterpolationError per the engine's rules.
   */
  capturedValues?: Record<string, Record<string, string>>;
  /** Process env (defaults to `process.env` at call time if omitted). */
  processEnv?: NodeJS.ProcessEnv;
  /** Project root cwd used for relative env_files paths AND for env_from cwd default. */
  projectRoot: string;
  /**
   * Plan-3 (LEV-380) profile-scoped env layer. When provided, the profile's
   * `env_from`, `env_files`, and `env` are layered between the top-level and
   * per-service layers (precedence steps 6-8 in the module-level docstring),
   * and `LICH_PROFILE` is auto-injected alongside `LICH_WORKTREE` /
   * `LICH_STACK_ID`. When omitted, behavior is identical to the Plan-1
   * pipeline (no profile layer, no `LICH_PROFILE`).
   *
   * Callers obtain `ResolvedProfile` from `profiles/resolve.ts`'s
   * `resolveProfile()`. The active profile is decided by `commands/up.ts`
   * before env resolution runs.
   */
  profile?: ResolvedProfile;
}

export type ResolveTopLevelEnvInput = Omit<
  ResolveEnvForServiceInput,
  "service"
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stringify EnvMap values. The schema allows string|number|boolean for
 * convenience; env vars are always strings at the OS level, so coerce
 * eagerly. Skip undefined entries (shouldn't occur with a well-formed
 * config, but be defensive — `undefined` would make interpolation crash).
 */
function literalsToStrings(literals: EnvMap | undefined): Record<string, string> {
  if (!literals) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(literals)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Copy process.env into a Record<string, string>. node's NodeJS.ProcessEnv
 * allows `undefined` values; drop those rather than carrying them through
 * the pipeline (a key with value `undefined` would break interpolation).
 */
function processEnvToRecord(
  pe: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(pe)) {
    const v = pe[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Resolve env_files paths against the project root (or absolute paths
 * pass through untouched).
 */
function absolutizeFiles(
  files: EnvFiles | undefined,
  projectRoot: string,
): string[] {
  if (!files || files.length === 0) return [];
  return files.map((f) => resolvePath(projectRoot, f));
}

/**
 * Auto-injects derived from worktree info (plus the active profile name when
 * one is in play). These are placed just above process.env in the precedence
 * stack so any user layer (env_from / env_files / env) can override them on
 * a per-key basis.
 *
 * If `worktree.stack_id` is absent for any reason (shouldn't happen given
 * Worktree's required fields), fall back to the worktree id alone.
 *
 * When `profileName` is provided, `LICH_PROFILE` is also injected so spawned
 * services (and `lich exec` / `lich env stack` consumers) can see which
 * profile their stack is running under. When `profileName` is undefined,
 * `LICH_PROFILE` is NOT injected — the spec treats it as "present iff a
 * profile is active" rather than "always present, possibly empty".
 */
function autoInjects(
  worktree: Worktree,
  profileName?: string,
): Record<string, string> {
  const injects: Record<string, string> = {};
  if (worktree.name) injects.LICH_WORKTREE = worktree.name;
  // stack_id is the canonical stack identifier (sanitized name + short hash).
  if (worktree.stack_id) injects.LICH_STACK_ID = worktree.stack_id;
  // Plan-3 (LEV-380): profile name is exposed to children when a profile is
  // active. Treated as "absent" when no profile is in play so tests can
  // distinguish the two states cleanly.
  if (profileName) injects.LICH_PROFILE = profileName;
  return injects;
}

/**
 * Build the InterpolationContext shape expected by interpolation.ts from
 * the worktree + allocated-ports inputs.
 *
 * Compose services in `services.*` interpolation only currently expose
 * `host_port` (the primary port). The allocator's per-compose-service map
 * is `logicalName -> hostPort`; we expose the first entry as `host_port`
 * here, since the design spec defines `${services.<name>.host_port}` as
 * "the primary port" (the first logical port declared for that service).
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
    // Pick a stable "primary" port: the first logical port in declared
    // order. Object.keys preserves insertion order for string keys, so
    // this matches the order the allocator filled them in.
    const keys = Object.keys(ports);
    services[name] = {
      host_port: keys.length > 0 ? ports[keys[0]] : undefined,
    };
  }

  const owned: InterpolationContext["owned"] = {};
  // Seed every entry from the port map so port references still work for
  // services that haven't captured anything.
  for (const [name, entry] of Object.entries(allocatedPorts.owned)) {
    owned[name] = {
      port: entry.port,
      ports: entry.ports,
    };
  }
  // Layer in captured values (Plan-4): may include services not in the
  // port map (an owned service without a declared port still gets
  // capture support), so iterate over capturedValues independently and
  // merge or create entries as needed.
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
 * Layer a single bundle of {env_from, env_files, env literals} onto the
 * running merged env. Used twice — once for the top-level layer, once
 * for the per-service layer. Returns the new merged env (mutates `into`).
 *
 * `baseEnvForShellOut` is the env exposed to env_from child processes;
 * we always pass the current merged env so a per-service env_from sees
 * everything resolved so far (process.env + top-level env, etc.). That
 * lets a service-level secret loader inherit top-level auth tokens.
 */
async function layerBundle(args: {
  into: Record<string, string>;
  env_from: EnvFrom | undefined;
  env_files: EnvFiles | undefined;
  env: EnvMap | undefined;
  projectRoot: string;
}): Promise<Record<string, string>> {
  const { into, env_from, env_files, env, projectRoot } = args;

  // 1. env_from (shell-out). Pass the current merged env so children see
  //    the resolved-so-far env (user's auth tokens etc. propagate).
  if (env_from && env_from.length > 0) {
    const fromShell = await loadEnvFromShellOut({
      entries: env_from,
      baseEnv: into,
      defaultCwd: projectRoot,
    });
    Object.assign(into, fromShell);
  }

  // 2. env_files (dotenv). Paths are resolved relative to project root.
  if (env_files && env_files.length > 0) {
    const fromFiles = await loadEnvFiles({
      files: absolutizeFiles(env_files, projectRoot),
    });
    Object.assign(into, fromFiles);
  }

  // 3. env literals. Coerce non-string values to strings.
  if (env) {
    Object.assign(into, literalsToStrings(env));
  }

  return into;
}

/**
 * Look up a per-service env bundle (env_from / env_files / env) by
 * service kind and name. Compose services don't have per-service
 * env_from/env_files in the Plan-1 type (the compose spec passthrough
 * `environment` is handled separately when we shell out to compose), so
 * for `kind: 'compose'` this returns empty bundles — only owned services
 * have per-service env layers in the Plan-1 surface.
 *
 * If the named service is missing from the config, we treat its bundle
 * as empty rather than throwing — validation upstream is responsible for
 * catching unknown service names; this function is best-effort about it.
 */
function getServiceBundle(
  config: LichConfig,
  service: ResolveEnvForServiceInput["service"],
): { env_from?: EnvFrom; env_files?: EnvFiles; env?: EnvMap } {
  if (service.kind === "compose") {
    // Plan-1 ComposeService doesn't carry env_from/env_files/env on the
    // lich side — compose handles its own `environment:` block. Nothing
    // to layer.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fully resolve env for one service. See module-level docstring for the
 * precedence order. Throws ShellOutError on env_from failure, the error
 * raised by loadEnvFiles on dotenv parse failure, and InterpolationError
 * on `${...}` resolution failure — each carries context-rich detail.
 */
export async function resolveEnvForService(
  input: ResolveEnvForServiceInput,
): Promise<Record<string, string>> {
  const processEnv = input.processEnv ?? process.env;

  // 1. process.env baseline (drop undefined values).
  let merged: Record<string, string> = processEnvToRecord(processEnv);

  // 2. Auto-injects (LICH_WORKTREE, LICH_STACK_ID, and LICH_PROFILE when a
  //    profile is active) — sit just above process.env so user layers can
  //    override.
  Object.assign(merged, autoInjects(input.worktree, input.profile?.name));

  // 3-5. Top-level env_from / env_files / env literals.
  merged = await layerBundle({
    into: merged,
    env_from: input.config.env_from,
    env_files: input.config.env_files,
    env: input.config.env,
    projectRoot: input.projectRoot,
  });

  // 6-8. Profile env_from / env_files / env literals (Plan-3 layer; no-op
  //      when no profile is active so Plan-1 callers see unchanged behavior).
  if (input.profile) {
    merged = await layerBundle({
      into: merged,
      env_from: input.profile.env_from,
      env_files: input.profile.env_files,
      env: input.profile.env,
      projectRoot: input.projectRoot,
    });
  }

  // 9-11. Per-service env_from / env_files / env literals.
  const bundle = getServiceBundle(input.config, input.service);
  merged = await layerBundle({
    into: merged,
    env_from: bundle.env_from,
    env_files: bundle.env_files,
    env: bundle.env,
    projectRoot: input.projectRoot,
  });

  // 12. Interpolate every value against the runtime context.
  const ctx = buildInterpolationContext(
    input.worktree,
    input.allocatedPorts,
    input.capturedValues,
  );
  const interpolated = interpolateRecord(
    merged,
    ctx,
    `env:${input.service.kind}:${input.service.name}`,
  );

  return interpolated;
}

/**
 * Resolve env for the "no specific service" case (lifecycle hooks, for
 * example). Same as {@link resolveEnvForService} but skips the per-service
 * bundle layer.
 */
export async function resolveTopLevelEnv(
  input: ResolveTopLevelEnvInput,
): Promise<Record<string, string>> {
  const processEnv = input.processEnv ?? process.env;

  let merged: Record<string, string> = processEnvToRecord(processEnv);
  Object.assign(merged, autoInjects(input.worktree, input.profile?.name));

  merged = await layerBundle({
    into: merged,
    env_from: input.config.env_from,
    env_files: input.config.env_files,
    env: input.config.env,
    projectRoot: input.projectRoot,
  });

  // Plan-3 profile layer at the END of the top-level pipeline so callers
  // that use `resolveTopLevelEnv` (lifecycle hooks, `lich exec`, `lich env
  // stack`) see profile overrides too. No per-service layer applies here by
  // design — the function is the "no specific service" path.
  if (input.profile) {
    merged = await layerBundle({
      into: merged,
      env_from: input.profile.env_from,
      env_files: input.profile.env_files,
      env: input.profile.env,
      projectRoot: input.projectRoot,
    });
  }

  const ctx = buildInterpolationContext(
    input.worktree,
    input.allocatedPorts,
    input.capturedValues,
  );
  return interpolateRecord(merged, ctx, "env:top-level");
}
