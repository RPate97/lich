/**
 * `lich validate [path]` — static analysis of a lich.yaml. No shell-outs,
 * no docker, no service starts. Exit 0 if clean, 1 otherwise.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { parseConfig, type ParseError } from "../config/parse.js";
import { buildGraph, type NodeDecl } from "../deps/graph.js";
import { topoLevels, CycleError } from "../deps/sort.js";
import type {
  ComposeService,
  EnvMap,
  LichConfig,
  LifecycleList,
  PerServiceLifecycle,
  ProfileDef,
  TopLevelLifecycle,
} from "../config/types.js";
import { BUILTIN_COMMAND_NAMES } from "./builtin-names.js";
import { detectExtendsCycle } from "../groups/validate-extends.js";
import { detectProfileExtendsCycle } from "../profiles/validate-extends.js";
import { pickDefaultProfile } from "../profiles/default.js";
import { resolveProfile } from "../profiles/resolve.js";
import {
  interpolateString,
  InterpolationError,
  type InterpolationContext,
} from "../config/interpolation.js";

export interface ValidateOptions {
  /** Path to a lich.yaml OR a directory containing one. Defaults to `cwd/lich.yaml`. */
  path?: string;
  json?: boolean;
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface ValidationError {
  /**
   * `"warning"` is non-fatal; exit stays 0 if warnings are the only diagnostics.
   * Consumers filter by `kind` to separate them.
   */
  kind:
    | "io"
    | "yaml"
    | "schema"
    | "ref"
    | "cycle"
    | "regex"
    | "interp"
    | "shadow"
    | "warning";
  /** `<file>:<line>:<col>` when available, else just `<file>`. */
  location: string;
  message: string;
}

export interface ValidationSummary {
  compose: number;
  owned: number;
  lifecycle_hooks: number;
  /** Optional for backward-compatible JSON consumers; new writes always populate. */
  profiles?: number;
}

export interface JsonReport {
  ok: boolean;
  path: string;
  summary?: ValidationSummary;
  errors?: ValidationError[];
}

export interface ValidateResult {
  exitCode: 0 | 1;
  report: JsonReport;
}

export async function runValidate(
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? ((s: string) => console.log(s));
  const err = opts.stderr ?? ((s: string) => console.error(s));

  const resolvedPath = resolveYamlPath(opts.path, cwd);

  const errors: ValidationError[] = [];
  let config: LichConfig | null = null;
  let summary: ValidationSummary | null = null;

  if (!existsSync(resolvedPath)) {
    errors.push({
      kind: "io",
      location: resolvedPath,
      message: `lich.yaml not found at ${resolvedPath}`,
    });
  } else {
    const parsed = await parseConfig(resolvedPath);
    if (!parsed.ok) {
      for (const e of parsed.errors) {
        errors.push(parseErrorToValidationError(e));
      }
    } else {
      config = parsed.config;
      checkDependsOnAndCycles(config, resolvedPath, errors);
      checkRegexes(config, resolvedPath, errors);
      checkInterpolations(config, resolvedPath, errors);
      checkCommandShadowing(config, resolvedPath, errors);
      // MUST run before checkEnvGroupReferences — a cycle would otherwise
      // surface there as "extends X not found" once the resolver walks
      // past the duplicate node, which is a misleading diagnostic.
      checkEnvGroupExtendsCycles(config, resolvedPath, errors);
      checkEnvGroupReferences(config, resolvedPath, errors);
      checkProfiles(config, resolvedPath, errors);
      // MUST run before checkProfileDefaultsAndExtends — same cycle-before-
      // reference ordering as env_groups above.
      checkProfileExtendsCycles(config, resolvedPath, errors);
      checkProfileDefaultsAndExtends(config, resolvedPath, errors);
      checkProfileUnusedServices(config, resolvedPath, errors);
      // MUST run AFTER checkInterpolations so structural-bad refs are
      // already flagged and we can skip duplicate diagnostics here.
      checkProfileInterpolations(config, resolvedPath, errors);
      summary = computeSummary(config);
    }
  }

  // Warnings don't change exit code; they ride in the same `errors` array
  // and consumers filter by `kind`. Pretty output prefixes them with `!`.
  const hardErrors = errors.filter((e) => e.kind !== "warning");
  const warnings = errors.filter((e) => e.kind === "warning");
  const ok = hardErrors.length === 0;
  const report: JsonReport = ok
    ? {
        ok: true,
        path: resolvedPath,
        summary: summary ?? undefined,
        ...(warnings.length > 0 ? { errors: warnings } : {}),
      }
    : { ok: false, path: resolvedPath, errors };

  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    // Warnings go to stderr; success/summary stays on stdout.
    renderPretty(report, ok ? out : err, err);
  }

  return { exitCode: ok ? 0 : 1, report };
}

function resolveYamlPath(input: string | undefined, cwd: string): string {
  if (!input) return join(cwd, "lich.yaml");

  const abs = isAbsolute(input) ? input : resolve(cwd, input);

  try {
    const st = statSync(abs);
    if (st.isDirectory()) return join(abs, "lich.yaml");
  } catch {
    // Doesn't exist — return as-is so caller emits "not found" at the
    // literal path the user asked about.
  }
  return abs;
}

function parseErrorToValidationError(e: ParseError): ValidationError {
  return { kind: e.kind, location: e.location, message: e.message };
}

/**
 * Build the depends_on graph and check both missing-target refs and cycles.
 * Cycle check runs on the subgraph of declared nodes so a cycle within
 * declared nodes still surfaces even when there are also unknown targets.
 */
function checkDependsOnAndCycles(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const decls: NodeDecl[] = [];

  const services = config.services ?? {};
  for (const [name, svc] of Object.entries(services)) {
    decls.push({
      name,
      kind: "compose",
      depends_on: svc?.depends_on ?? [],
    });
  }
  const owned = config.owned ?? {};
  for (const [name, o] of Object.entries(owned)) {
    decls.push({
      name,
      kind: "owned",
      depends_on: o?.depends_on ?? [],
    });
  }

  const declared = new Set(decls.map((d) => d.name));
  const filteredDecls: NodeDecl[] = [];
  for (const decl of decls) {
    const kept: string[] = [];
    for (let i = 0; i < decl.depends_on.length; i++) {
      const target = decl.depends_on[i];
      if (!declared.has(target)) {
        const section = decl.kind === "compose" ? "services" : "owned";
        const suggestion = suggest(target, [...declared]);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "ref",
          location: `${path} (/${section}/${decl.name}/depends_on/${i})`,
          message: `references unknown service "${target}"${hint}`,
        });
      } else {
        kept.push(target);
      }
    }
    filteredDecls.push({ ...decl, depends_on: kept });
  }

  // buildGraph throws on duplicate node names; wrap so we don't crash the
  // validator when distinct keys in services/owned happen to collide.
  let graph;
  try {
    graph = buildGraph(filteredDecls);
  } catch (e) {
    errors.push({
      kind: "schema",
      location: path,
      message: `duplicate service declaration: ${(e as Error).message}`,
    });
    return;
  }
  try {
    topoLevels(graph);
  } catch (e) {
    if (e instanceof CycleError) {
      errors.push({
        kind: "cycle",
        location: path,
        message: `cycle in depends_on: ${e.cycle.join(" → ")}`,
      });
    } else {
      throw e;
    }
  }
}

function checkRegexes(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  for (const [name, svc] of Object.entries(config.owned ?? {})) {
    const ready = svc?.ready_when;
    if (ready && typeof ready.log_match === "string") {
      tryCompile(
        ready.log_match,
        `${path} (/owned/${name}/ready_when/log_match)`,
        errors,
      );
    }
    if (ready && ready.capture && typeof ready.capture === "object") {
      for (const [key, pattern] of Object.entries(ready.capture)) {
        if (typeof pattern !== "string") continue;
        tryCompile(
          pattern,
          `${path} (/owned/${name}/ready_when/capture/${key})`,
          errors,
        );
      }
    }
    const failWhen = svc?.fail_when as { log_match?: unknown } | undefined;
    if (failWhen && typeof failWhen.log_match === "string") {
      tryCompile(
        failWhen.log_match,
        `${path} (/owned/${name}/fail_when/log_match)`,
        errors,
      );
    }
  }

  // Defensive: compose schema doesn't currently define ready_when, but
  // walk it if present so future shape extensions are covered.
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    const ready = (svc as { ready_when?: { log_match?: unknown } })
      .ready_when;
    if (ready && typeof ready.log_match === "string") {
      tryCompile(
        ready.log_match,
        `${path} (/services/${name}/ready_when/log_match)`,
        errors,
      );
    }
  }
}

function tryCompile(
  pattern: string,
  location: string,
  errors: ValidationError[],
): void {
  try {
    new RegExp(pattern, "u");
  } catch (e) {
    errors.push({
      kind: "regex",
      location,
      message: `invalid regex /${pattern}/: ${(e as Error).message}`,
    });
  }
}

/**
 * Walk `${...}` refs in env values + ready_when probes. Verifies each is
 * structurally supported and (for service refs) points at a declared service.
 * Does NOT resolve values — runtime's job.
 */
function checkInterpolations(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const composeNames = new Set(Object.keys(config.services ?? {}));
  const ownedNames = new Set(Object.keys(config.owned ?? {}));

  const sources: Array<{ env: EnvMap; loc: string }> = [];
  if (config.env) {
    sources.push({ env: config.env, loc: `/env` });
  }
  for (const [name, svc] of Object.entries(config.owned ?? {})) {
    if (svc?.env) {
      sources.push({ env: svc.env, loc: `/owned/${name}/env` });
    }
  }

  // ready_when.{tcp,http_get,cmd} commonly use `${owned.X.ports.Y}`.
  for (const [name, svc] of Object.entries(config.owned ?? {})) {
    const ready = svc?.ready_when;
    if (!ready) continue;
    for (const field of ["tcp", "http_get", "cmd"] as const) {
      const v = ready[field];
      if (typeof v !== "string") continue;
      checkValueRefs(
        v,
        `${path} (/owned/${name}/ready_when/${field})`,
        composeNames,
        ownedNames,
        config,
        errors,
      );
    }
  }

  for (const { env, loc } of sources) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") continue;
      checkValueRefs(
        value,
        `${path} (${loc}/${key})`,
        composeNames,
        ownedNames,
        config,
        errors,
      );
    }
  }

  // cmd-context refs (owned.cmd/stop_cmd, lifecycle, commands): runtime uses passUnknownShapes=true, mirror that here.
  for (const [name, svc] of Object.entries(config.owned ?? {})) {
    if (!svc) continue;
    if (typeof svc.cmd === "string") {
      checkValueRefs(
        svc.cmd,
        `${path} (/owned/${name}/cmd)`,
        composeNames,
        ownedNames,
        config,
        errors,
        true,
      );
    }
    if (typeof svc.stop_cmd === "string") {
      checkValueRefs(
        svc.stop_cmd,
        `${path} (/owned/${name}/stop_cmd)`,
        composeNames,
        ownedNames,
        config,
        errors,
        true,
      );
    }
    if (svc.lifecycle) {
      checkPerServiceLifecycleRefs(
        svc.lifecycle,
        path,
        `/owned/${name}/lifecycle`,
        composeNames,
        ownedNames,
        config,
        errors,
      );
    }
  }

  if (config.lifecycle) {
    checkTopLifecycleRefs(
      config.lifecycle,
      path,
      `/lifecycle`,
      composeNames,
      ownedNames,
      config,
      errors,
    );
  }

  for (const [name, cmd] of Object.entries(config.commands ?? {})) {
    if (cmd && typeof cmd.cmd === "string") {
      checkValueRefs(
        cmd.cmd,
        `${path} (/commands/${name}/cmd)`,
        composeNames,
        ownedNames,
        config,
        errors,
        true,
      );
    }
  }

  for (const [pname, profile] of Object.entries(config.profiles ?? {})) {
    if (profile?.lifecycle) {
      checkTopLifecycleRefs(
        profile.lifecycle,
        path,
        `/profiles/${pname}/lifecycle`,
        composeNames,
        ownedNames,
        config,
        errors,
      );
    }
  }
}

function checkLifecycleListRefs(
  entries: LifecycleList,
  path: string,
  yamlPath: string,
  composeNames: Set<string>,
  ownedNames: Set<string>,
  config: LichConfig,
  errors: ValidationError[],
): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry === "string") {
      checkValueRefs(
        entry,
        `${path} (${yamlPath}/${i})`,
        composeNames,
        ownedNames,
        config,
        errors,
        true,
      );
    } else if (entry && typeof entry.cmd === "string") {
      checkValueRefs(
        entry.cmd,
        `${path} (${yamlPath}/${i}/cmd)`,
        composeNames,
        ownedNames,
        config,
        errors,
        true,
      );
    }
  }
}

function checkTopLifecycleRefs(
  lifecycle: TopLevelLifecycle,
  path: string,
  yamlPath: string,
  composeNames: Set<string>,
  ownedNames: Set<string>,
  config: LichConfig,
  errors: ValidationError[],
): void {
  for (const phase of ["before_up", "after_up", "before_down", "after_down"] as const) {
    const entries = lifecycle[phase];
    if (!entries) continue;
    checkLifecycleListRefs(
      entries,
      path,
      `${yamlPath}/${phase}`,
      composeNames,
      ownedNames,
      config,
      errors,
    );
  }
}

function checkPerServiceLifecycleRefs(
  lifecycle: PerServiceLifecycle,
  path: string,
  yamlPath: string,
  composeNames: Set<string>,
  ownedNames: Set<string>,
  config: LichConfig,
  errors: ValidationError[],
): void {
  for (const phase of ["before_start", "after_ready", "before_down"] as const) {
    const entries = lifecycle[phase];
    if (!entries) continue;
    checkLifecycleListRefs(
      entries,
      path,
      `${yamlPath}/${phase}`,
      composeNames,
      ownedNames,
      config,
      errors,
    );
  }
}

const REF_RE = /\$\$|\$\{([^}]*)\}/g;

function checkValueRefs(
  value: string,
  location: string,
  composeNames: Set<string>,
  ownedNames: Set<string>,
  config: LichConfig,
  errors: ValidationError[],
  passUnknownShapes = false,
): void {
  if (value.indexOf("$") === -1) return;
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(value)) !== null) {
    if (m[0] === "$$") continue; // literal $
    const body = m[1];
    if (!body) {
      errors.push({
        kind: "interp",
        location,
        message: `empty interpolation \${}`,
      });
      continue;
    }
    if (passUnknownShapes) {
      const root = body.split(".")[0];
      if (root !== "worktree" && root !== "services" && root !== "owned") {
        continue;
      }
    }
    validateRefBody(body, m[0], location, composeNames, ownedNames, config, errors);
  }
}

function validateRefBody(
  body: string,
  fullRef: string,
  location: string,
  composeNames: Set<string>,
  ownedNames: Set<string>,
  config: LichConfig,
  errors: ValidationError[],
): void {
  const parts = body.split(".");
  const [root, ...rest] = parts;

  if (root === "worktree") {
    if (rest.length !== 1 || !["name", "id", "path"].includes(rest[0])) {
      errors.push({
        kind: "interp",
        location,
        message: `unknown reference ${fullRef} (worktree fields: name, id, path)`,
      });
    }
    return;
  }

  if (root === "services") {
    // Supported: services.<name>.host_port | host_port_<idx> | ports.<key>
    if (rest.length === 2 && rest[1].startsWith("host_port")) {
      const name = rest[0];
      if (!composeNames.has(name)) {
        const suggestion = suggest(name, [...composeNames]);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown compose service "${name}"${hint}`,
        });
        return;
      }

      if (rest[1] === "host_port") return;

      // host_port_<idx>: array-form positional.
      if (rest[1].startsWith("host_port_")) {
        const suffix = rest[1].slice("host_port_".length);
        if (suffix.length === 0 || !/^\d+$/.test(suffix)) {
          errors.push({
            kind: "interp",
            location,
            message:
              `unknown reference ${fullRef} ` +
              `(expected \${services.${name}.host_port_<idx>} with a numeric index, ` +
              `or \${services.${name}.ports.<key>} for Record-form ports)`,
          });
          return;
        }
        const svc = config.services?.[name];
        const portsDecl = svc?.ports;
        if (!portsDecl) {
          errors.push({
            kind: "interp",
            location,
            message: `${fullRef} indexes into ports but compose service "${name}" declares no \`ports:\` block`,
          });
          return;
        }
        const idx = Number(suffix);
        if (Array.isArray(portsDecl)) {
          if (idx >= portsDecl.length) {
            errors.push({
              kind: "interp",
              location,
              message:
                `${fullRef} is out of range: compose service "${name}" has only ` +
                `${portsDecl.length} port(s) declared (valid indices: 0..${portsDecl.length - 1})`,
            });
          }
          return;
        }
        // Array-style indexing used against a Record-form ports decl.
        errors.push({
          kind: "interp",
          location,
          message:
            `${fullRef} uses array-form indexing but compose service "${name}" ` +
            `declares \`ports:\` as a Record — use \${services.${name}.ports.<key>} with one of: ` +
            `${Object.keys(portsDecl).join(", ") || "<none>"}`,
        });
        return;
      }

      errors.push({
        kind: "interp",
        location,
        message: `unknown reference ${fullRef} (expected \${services.<name>.host_port} or \${services.<name>.host_port_<idx>})`,
      });
      return;
    }

    // services.<name>.ports.<key>
    if (rest.length === 3 && rest[1] === "ports") {
      const name = rest[0];
      const key = rest[2];
      if (!composeNames.has(name)) {
        const suggestion = suggest(name, [...composeNames]);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown compose service "${name}"${hint}`,
        });
        return;
      }
      const svc = config.services?.[name];
      const portsDecl = svc?.ports;
      if (!portsDecl) {
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} uses keyed lookup but compose service "${name}" declares no \`ports:\` block`,
        });
        return;
      }
      if (Array.isArray(portsDecl)) {
        errors.push({
          kind: "interp",
          location,
          message:
            `${fullRef} uses keyed lookup but compose service "${name}" declares ` +
            `\`ports:\` as an array — use \${services.${name}.host_port_<idx>} with a numeric index`,
        });
        return;
      }
      if (!(key in portsDecl)) {
        const suggestion = suggest(key, Object.keys(portsDecl));
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown port "${key}" on compose service "${name}"${hint}`,
        });
      }
      return;
    }

    errors.push({
      kind: "interp",
      location,
      message:
        `unknown reference ${fullRef} ` +
        `(expected \${services.<name>.host_port}, \${services.<name>.host_port_<idx>}, ` +
        `or \${services.<name>.ports.<key>})`,
    });
    return;
  }

  if (root === "owned") {
    if (rest.length === 2 && rest[1] === "port") {
      const name = rest[0];
      if (!ownedNames.has(name)) {
        const suggestion = suggest(name, [...ownedNames]);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown owned service "${name}"${hint}`,
        });
        return;
      }
      // Single-port shape against a multi-port service is wrong.
      const svc = config.owned?.[name];
      if (svc && !svc.port && svc.ports) {
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} uses single-port shape but owned service "${name}" declares multi-port \`ports:\` — use \${owned.${name}.ports.<key>}`,
        });
      }
      return;
    }
    if (rest.length === 3 && rest[1] === "ports") {
      const name = rest[0];
      const key = rest[2];
      if (!ownedNames.has(name)) {
        const suggestion = suggest(name, [...ownedNames]);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown owned service "${name}"${hint}`,
        });
        return;
      }
      const svc = config.owned?.[name];
      const ports = svc?.ports;
      if (svc && !ports) {
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} uses multi-port shape but owned service "${name}" does not declare \`ports:\``,
        });
        return;
      }
      if (ports && !(key in ports)) {
        const suggestion = suggest(key, Object.keys(ports));
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown port "${key}" on owned service "${name}"${hint}`,
        });
      }
      return;
    }
    // ${owned.<name>.captured.<key>} — captures declared on the producer's
    // ready_when.capture block. Valid iff service exists, declares
    // capture, and the key is one of the declared capture keys.
    if (rest.length === 3 && rest[1] === "captured") {
      const name = rest[0];
      const key = rest[2];
      if (!ownedNames.has(name)) {
        const suggestion = suggest(name, [...ownedNames]);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown owned service "${name}"${hint}`,
        });
        return;
      }
      const svc = config.owned?.[name];
      const capture = svc?.ready_when?.capture;
      if (!capture) {
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references a captured value but owned service "${name}" does not declare \`ready_when.capture\``,
        });
        return;
      }
      if (!(key in capture)) {
        const suggestion = suggest(key, Object.keys(capture));
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "interp",
          location,
          message: `${fullRef} references unknown capture "${key}" on owned service "${name}"${hint}`,
        });
      }
      return;
    }
    errors.push({
      kind: "interp",
      location,
      message: `unknown reference ${fullRef} (expected \${owned.<name>.port}, \${owned.<name>.ports.<key>}, or \${owned.<name>.captured.<key>})`,
    });
    return;
  }

  errors.push({
    kind: "interp",
    location,
    message:
      `unknown reference ${fullRef} (supported: worktree.*, ` +
      `services.<name>.host_port, services.<name>.host_port_<idx>, ` +
      `services.<name>.ports.<key>, owned.<name>.port, ` +
      `owned.<name>.ports.<key>, owned.<name>.captured.<key>)`,
  });
}

/**
 * Refuse user-defined `commands.<name>` entries that collide with a built-in.
 * Built-ins always win at runtime; shadow declarations are dead config.
 *
 * The names list is in `commands/builtin-names.ts` to avoid an ESM cycle
 * with `commands/index.ts` (which imports `runValidate` from here).
 */
function checkCommandShadowing(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const userCommands = config.commands;
  if (!userCommands) return;

  const builtins = new Set<string>(BUILTIN_COMMAND_NAMES);
  for (const name of Object.keys(userCommands)) {
    if (builtins.has(name)) {
      errors.push({
        kind: "shadow",
        location: path,
        message:
          `commands.${name} shadows the built-in 'lich ${name}' — ` +
          `pick a different name (try '${name}:run' or similar)`,
      });
    }
  }
}

/** Cycle detection in `env_groups.<name>.extends`. Must run before reference check (see runValidate). */
function checkEnvGroupExtendsCycles(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const groups = config.env_groups;
  if (!groups) return;

  const result = detectExtendsCycle(groups);
  if (!result) return;

  errors.push({
    kind: "cycle",
    location: path,
    message: `cycle in env_groups extends: ${result.cycle.join(" → ")}`,
  });
}

/**
 * Every `env_group:` reference must resolve to the built-in `"stack"` or a
 * name declared in `config.env_groups`. Walks: commands, lifecycle (top +
 * per-service), and env_groups.extends.
 */
function checkEnvGroupReferences(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  // "stack" isn't in this set so it can't dominate Levenshtein hits when
  // suggesting alternatives for typo'd user-group names.
  const declaredGroups = new Set(Object.keys(config.env_groups ?? {}));

  const suggestPool = [...declaredGroups, "stack"];
  const reportUnresolved = (name: string, location: string): void => {
    const suggestion = suggest(name, suggestPool);
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
    errors.push({
      kind: "ref",
      location,
      message: `env_group "${name}" not declared${hint}`,
    });
  };

  const checkRef = (name: string, location: string): void => {
    if (name === "stack") return;
    if (declaredGroups.has(name)) return;
    reportUnresolved(name, location);
  };

  for (const [cmdName, cmd] of Object.entries(config.commands ?? {})) {
    if (cmd && typeof cmd.env_group === "string") {
      checkRef(
        cmd.env_group,
        `${path} (/commands/${cmdName}/env_group)`,
      );
    }
  }

  const topLifecycle = config.lifecycle;
  if (topLifecycle) {
    for (const phase of [
      "before_up",
      "after_up",
      "before_down",
      "after_down",
    ] as const) {
      const entries = topLifecycle[phase];
      if (!entries) continue;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (typeof entry === "string") continue;
        if (entry && typeof entry.env_group === "string") {
          checkRef(
            entry.env_group,
            `${path} (/lifecycle/${phase}/${i}/env_group)`,
          );
        }
      }
    }
  }

  for (const [svcName, svc] of Object.entries(config.owned ?? {})) {
    const svcLifecycle = svc?.lifecycle;
    if (!svcLifecycle) continue;
    for (const phase of [
      "before_start",
      "after_ready",
      "before_down",
    ] as const) {
      const entries = svcLifecycle[phase];
      if (!entries) continue;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (typeof entry === "string") continue;
        if (entry && typeof entry.env_group === "string") {
          checkRef(
            entry.env_group,
            `${path} (/owned/${svcName}/lifecycle/${phase}/${i}/env_group)`,
          );
        }
      }
    }
  }

  for (const [groupName, group] of Object.entries(config.env_groups ?? {})) {
    if (group && typeof group.extends === "string") {
      checkRef(
        group.extends,
        `${path} (/env_groups/${groupName}/extends)`,
      );
    }
  }
}

/**
 * Refuse `profiles.<name>.services` / `.owned` entries that don't reference
 * a declared service. Surfaces dead config that would fail at `lich up` time.
 */
function checkProfiles(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const profiles = config.profiles;
  if (!profiles) return;

  const composeNames = Object.keys(config.services ?? {});
  const ownedNames = Object.keys(config.owned ?? {});
  const composeSet = new Set(composeNames);
  const ownedSet = new Set(ownedNames);

  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!profile) continue;

    const services = profile.services;
    if (Array.isArray(services)) {
      for (let i = 0; i < services.length; i++) {
        const target = services[i];
        if (typeof target !== "string") continue;
        if (composeSet.has(target)) continue;
        const suggestion = suggest(target, composeNames);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "ref",
          location: `${path} (/profiles/${profileName}/services/${i})`,
          message: `references unknown compose service "${target}"${hint}`,
        });
      }
    }

    const owned = profile.owned;
    if (Array.isArray(owned)) {
      const discoverParents = config._discoverParents;
      for (let i = 0; i < owned.length; i++) {
        const target = owned[i];
        if (typeof target !== "string") continue;
        if (ownedSet.has(target)) continue;
        if (discoverParents?.has(target)) continue;
        const suggestion = suggest(target, ownedNames);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "ref",
          location: `${path} (/profiles/${profileName}/owned/${i})`,
          message: `references unknown owned service "${target}"${hint}`,
        });
      }
    }
  }
}

/** Cycle detection in `profiles.<name>.extends`. Must run before reference check (see runValidate). */
function checkProfileExtendsCycles(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const profiles = config.profiles;
  if (!profiles) return;

  const result = detectProfileExtendsCycle(profiles);
  if (!result) return;

  errors.push({
    kind: "cycle",
    location: path,
    message: `cycle in profiles extends: ${result.cycle.join(" → ")}`,
  });
}

/**
 * Validate `profiles.<name>.extends` references and the single-`default: true`
 * invariant. Reuses `pickDefaultProfile` so this and `lich up` agree.
 */
function checkProfileDefaultsAndExtends(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const profiles = config.profiles;
  if (!profiles || Object.keys(profiles).length === 0) return;

  const declared = Object.keys(profiles);
  const declaredSet = new Set(declared);

  for (const [profileName, profile] of Object.entries(profiles)) {
    if (!profile) continue;
    const ext = profile.extends;
    if (ext === undefined) continue;

    if (typeof ext === "string") {
      if (declaredSet.has(ext)) continue;
      const suggestion = suggest(ext, declared);
      const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
      errors.push({
        kind: "ref",
        location: `${path} (/profiles/${profileName}/extends)`,
        message: `extends unknown profile "${ext}"${hint}`,
      });
      continue;
    }

    if (Array.isArray(ext)) {
      for (let i = 0; i < ext.length; i++) {
        const parent = ext[i];
        if (typeof parent !== "string") continue;
        if (declaredSet.has(parent)) continue;
        const suggestion = suggest(parent, declared);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        errors.push({
          kind: "ref",
          location: `${path} (/profiles/${profileName}/extends/${i})`,
          message: `extends unknown profile "${parent}"${hint}`,
        });
      }
    }
  }

  // Multi-default-only check; absent/single both yield no error here
  // (the no-default case is decided by `lich up`'s call site).
  const pick = pickDefaultProfile(config);
  if (pick.error) {
    errors.push({
      kind: "schema",
      location: path,
      message: pick.error,
    });
  }
}

/**
 * Warn (don't fail) for services not included by any profile's fully-resolved
 * services/owned lists. "Fully resolved" = union over the extends chain;
 * cycle-guards because cycle detection ordering can be bypassed.
 *
 * Skips when `config.profiles` is empty (every service is implicitly always-on).
 */
function checkProfileUnusedServices(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const profiles = config.profiles;
  if (!profiles || Object.keys(profiles).length === 0) return;

  const declaredCompose = Object.keys(config.services ?? {});
  const declaredOwned = Object.keys(config.owned ?? {});
  if (declaredCompose.length === 0 && declaredOwned.length === 0) return;

  const usedCompose = new Set<string>();
  const usedOwned = new Set<string>();
  const discoverParents = config._discoverParents;

  for (const profileName of Object.keys(profiles)) {
    const resolved = resolveProfileServiceSet(profileName, profiles, discoverParents);
    for (const s of resolved.services) usedCompose.add(s);
    for (const o of resolved.owned) usedOwned.add(o);
  }

  for (const name of declaredCompose) {
    if (usedCompose.has(name)) continue;
    errors.push({
      kind: "warning",
      location: `${path} (/services/${name})`,
      message:
        `compose service "${name}" is not included by any profile and ` +
        `will never start; add it to a profile's \`services:\` list or ` +
        `remove the declaration`,
    });
  }
  for (const name of declaredOwned) {
    if (usedOwned.has(name)) continue;
    errors.push({
      kind: "warning",
      location: `${path} (/owned/${name})`,
      message:
        `owned service "${name}" is not included by any profile and ` +
        `will never start; add it to a profile's \`owned:\` list or ` +
        `remove the declaration`,
    });
  }
}

/**
 * Union of services+owned for a profile, walking the extends chain
 * parents-first (matches `profiles/resolve.ts`). Cycle-guarded so this
 * terminates even when cycle detection ordering is bypassed.
 */
function resolveProfileServiceSet(
  name: string,
  profiles: Record<string, ProfileDef>,
  discoverParents?: Map<string, string[]>,
): { services: string[]; owned: string[] } {
  const services: string[] = [];
  const owned: string[] = [];
  const seenServices = new Set<string>();
  const seenOwned = new Set<string>();
  const visited = new Set<string>();

  walk(name);

  return { services, owned };

  function walk(node: string): void {
    if (visited.has(node)) return;
    visited.add(node);
    const profile = profiles[node];
    if (!profile) return;

    const parents = normalizeExtends(profile.extends);
    for (const parent of parents) walk(parent);

    if (Array.isArray(profile.services)) {
      for (const s of profile.services) {
        if (typeof s !== "string" || seenServices.has(s)) continue;
        seenServices.add(s);
        services.push(s);
      }
    }
    if (Array.isArray(profile.owned)) {
      for (const o of profile.owned) {
        if (typeof o !== "string") continue;
        const children = discoverParents?.get(o);
        if (children !== undefined) {
          for (const child of children) {
            if (!seenOwned.has(child)) {
              seenOwned.add(child);
              owned.push(child);
            }
          }
        } else if (!seenOwned.has(o)) {
          seenOwned.add(o);
          owned.push(o);
        }
      }
    }
  }
}

function normalizeExtends(
  ext: string | string[] | undefined,
): string[] {
  if (ext === undefined) return [];
  if (typeof ext === "string") return [ext];
  return ext.filter((e): e is string => typeof e === "string");
}

/**
 * Per-profile interpolation simulation. Catches `${owned.X.port}` refs that
 * point at services declared at top level but EXCLUDED by a profile —
 * structurally valid (caught nowhere by `checkInterpolations`) yet failing
 * at `lich up` time because the profile's allocated-ports map excludes them.
 *
 * Dedupes against `checkInterpolations`: refs that fail in the "max" context
 * (every declared service present) are structural problems already flagged.
 */
function checkProfileInterpolations(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  const profiles = config.profiles;
  if (!profiles || Object.keys(profiles).length === 0) return;

  // Max context = every declared service present, ports stubbed as 1.
  // Used to discriminate "fails anywhere" (structural, already flagged) from
  // "fails only under this profile" (the case this check exists to catch).
  const maxCtx = buildMaxInterpolationContext(config);

  for (const profileName of Object.keys(profiles)) {
    let resolved;
    try {
      resolved = resolveProfile(profileName, config);
    } catch {
      // Resolution errors (cycle, missing extends) flagged by sibling
      // checks. Skip rather than double-report.
      continue;
    }

    const profileCtx = buildProfileInterpolationContext(resolved, config);

    // Surviving merged env: top-level + profile.env, no per-service.
    // Profile env wins; track origin per key for the error location.
    const surviving = mergeWithOrigin(config.env, resolved.env);

    for (const [key, entry] of surviving) {
      if (typeof entry.value !== "string") continue;
      if (entry.value.indexOf("$") === -1) continue;

      const location =
        entry.origin === "profile"
          ? `${path} (/profiles/${profileName}/env/${key})`
          : `${path} (/env/${key})`;

      try {
        interpolateString(entry.value, profileCtx, `validate:${profileName}:${key}`);
      } catch (e) {
        if (!(e instanceof InterpolationError)) throw e;

        // Dedupe with the structural top-level check.
        if (failsInContext(entry.value, maxCtx)) continue;

        errors.push({
          kind: "interp",
          location,
          message: profileInterpMessage(e, profileName),
        });
      }
    }

    const cmdSites = collectProfileCmdSites(profileName, resolved, config, path);
    for (const site of cmdSites) {
      if (site.value.indexOf("$") === -1) continue;
      try {
        interpolateString(
          site.value,
          profileCtx,
          `validate:${profileName}:${site.location}`,
          true,
        );
      } catch (e) {
        if (!(e instanceof InterpolationError)) throw e;
        if (failsInContext(site.value, maxCtx, true)) continue;
        errors.push({
          kind: "interp",
          location: site.location,
          message: profileInterpMessage(e, profileName),
        });
      }
    }
  }
}

interface CmdSite {
  value: string;
  location: string;
}

function collectProfileCmdSites(
  profileName: string,
  resolved: ReturnType<typeof resolveProfile>,
  config: LichConfig,
  path: string,
): CmdSite[] {
  const sites: CmdSite[] = [];

  for (const [name, cmd] of Object.entries(config.commands ?? {})) {
    if (cmd && typeof cmd.cmd === "string") {
      sites.push({
        value: cmd.cmd,
        location: `${path} (/commands/${name}/cmd)`,
      });
    }
  }

  if (config.lifecycle) {
    collectTopLifecycleSites(config.lifecycle, path, `/lifecycle`, sites);
  }
  const profile = config.profiles?.[profileName];
  if (profile?.lifecycle) {
    collectTopLifecycleSites(
      profile.lifecycle,
      path,
      `/profiles/${profileName}/lifecycle`,
      sites,
    );
  }

  for (const name of resolved.owned) {
    const svc = config.owned?.[name];
    if (!svc) continue;
    if (typeof svc.cmd === "string") {
      sites.push({
        value: svc.cmd,
        location: `${path} (/owned/${name}/cmd)`,
      });
    }
    if (typeof svc.stop_cmd === "string") {
      sites.push({
        value: svc.stop_cmd,
        location: `${path} (/owned/${name}/stop_cmd)`,
      });
    }
    if (svc.lifecycle) {
      collectPerServiceLifecycleSites(
        svc.lifecycle,
        path,
        `/owned/${name}/lifecycle`,
        sites,
      );
    }
  }

  return sites;
}

function collectTopLifecycleSites(
  lifecycle: TopLevelLifecycle,
  path: string,
  yamlPath: string,
  sites: CmdSite[],
): void {
  for (const phase of ["before_up", "after_up", "before_down", "after_down"] as const) {
    const entries = lifecycle[phase];
    if (!entries) continue;
    collectLifecycleListSites(entries, path, `${yamlPath}/${phase}`, sites);
  }
}

function collectPerServiceLifecycleSites(
  lifecycle: PerServiceLifecycle,
  path: string,
  yamlPath: string,
  sites: CmdSite[],
): void {
  for (const phase of ["before_start", "after_ready", "before_down"] as const) {
    const entries = lifecycle[phase];
    if (!entries) continue;
    collectLifecycleListSites(entries, path, `${yamlPath}/${phase}`, sites);
  }
}

function collectLifecycleListSites(
  entries: LifecycleList,
  path: string,
  yamlPath: string,
  sites: CmdSite[],
): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry === "string") {
      sites.push({ value: entry, location: `${path} (${yamlPath}/${i})` });
    } else if (entry && typeof entry.cmd === "string") {
      sites.push({ value: entry.cmd, location: `${path} (${yamlPath}/${i}/cmd)` });
    }
  }
}

/**
 * Synthetic interpolation context covering only the profile's resolved set.
 * Honours declared `port:` vs `ports:` shape so multi-port refs get the
 * right diagnostic. Owned services with no port shape are still registered
 * so `${owned.X.captured.Y}` refs reach the engine's capture-specific error.
 */
function buildProfileInterpolationContext(
  resolved: ReturnType<typeof resolveProfile>,
  config: LichConfig,
): InterpolationContext {
  const services: InterpolationContext["services"] = {};
  for (const name of resolved.services) {
    services[name] = {
      host_port: 1,
      ports: stubServicePorts(config.services?.[name]?.ports),
    };
  }

  const owned: InterpolationContext["owned"] = {};
  for (const name of resolved.owned) {
    const svc = config.owned?.[name];
    const entry: { port?: number; ports?: Record<string, number> } = {};
    if (svc) {
      if (svc.ports && typeof svc.ports === "object") {
        const stubbed: Record<string, number> = {};
        for (const key of Object.keys(svc.ports)) {
          stubbed[key] = 1;
        }
        entry.ports = stubbed;
      }
      if (svc.port !== undefined) {
        entry.port = 1;
      }
    }
    owned[name] = entry;
  }

  return {
    worktree: { name: "stub", id: "stub", path: "/stub" },
    services,
    owned,
  };
}

/**
 * Max interpolation context — every declared service present, ports stubbed
 * as 1. Used to discriminate structural failures from profile-specific ones.
 */
function buildMaxInterpolationContext(
  config: LichConfig,
): InterpolationContext {
  const services: InterpolationContext["services"] = {};
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    services[name] = {
      host_port: 1,
      ports: stubServicePorts(svc?.ports),
    };
  }

  const owned: InterpolationContext["owned"] = {};
  for (const [name, svc] of Object.entries(config.owned ?? {})) {
    const entry: { port?: number; ports?: Record<string, number> } = {};
    if (svc?.ports && typeof svc.ports === "object") {
      const stubbed: Record<string, number> = {};
      for (const key of Object.keys(svc.ports)) {
        stubbed[key] = 1;
      }
      entry.ports = stubbed;
    }
    if (svc?.port !== undefined) {
      entry.port = 1;
    }
    owned[name] = entry;
  }

  return {
    worktree: { name: "stub", id: "stub", path: "/stub" },
    services,
    owned,
  };
}

/**
 * Stub a compose `ports:` declaration into the allocator's `Record<string,number>`
 * shape so synthetic contexts can resolve both array-form (`host_port_<idx>`)
 * and record-form (`ports.<key>`) lookups.
 */
function stubServicePorts(
  portsDecl: ComposeService["ports"] | undefined,
): Record<string, number> | undefined {
  if (!portsDecl) return undefined;
  const stub: Record<string, number> = {};
  if (Array.isArray(portsDecl)) {
    for (let i = 0; i < portsDecl.length; i++) {
      stub[String(i)] = 1;
    }
  } else {
    for (const key of Object.keys(portsDecl)) {
      stub[key] = 1;
    }
  }
  return stub;
}

/** Does `interpolateString` throw against `ctx`? Used to dedupe vs the structural check. */
function failsInContext(
  value: string,
  ctx: InterpolationContext,
  passUnknownShapes = false,
): boolean {
  try {
    interpolateString(value, ctx, undefined, passUnknownShapes);
    return false;
  } catch (e) {
    return e instanceof InterpolationError;
  }
}

/**
 * Per-key merge of top-level env + profile env, tracking origin per key.
 * Profile env wins on collision. Map preserves top-level-first insertion order.
 */
function mergeWithOrigin(
  topLevel: EnvMap | undefined,
  profile: EnvMap,
): Map<string, { value: unknown; origin: "top" | "profile" }> {
  const out = new Map<string, { value: unknown; origin: "top" | "profile" }>();
  if (topLevel) {
    for (const [k, v] of Object.entries(topLevel)) {
      out.set(k, { value: v, origin: "top" });
    }
  }
  for (const [k, v] of Object.entries(profile)) {
    out.set(k, { value: v, origin: "profile" });
  }
  return out;
}

/**
 * Prefix with the profile name; strip the engine's `(source: ...)` suffix
 * since the validation error's `location` carries that info more readably.
 */
function profileInterpMessage(
  err: InterpolationError,
  profileName: string,
): string {
  const stripped = err.message.replace(/\s*\(source: [^)]*\)$/u, "");
  return `under profile "${profileName}": ${stripped}`;
}

function computeSummary(config: LichConfig): ValidationSummary {
  const compose = Object.keys(config.services ?? {}).length;
  const owned = Object.keys(config.owned ?? {}).length;
  const profiles = Object.keys(config.profiles ?? {}).length;

  let hooks = 0;
  const top = config.lifecycle;
  if (top) {
    hooks += top.before_up?.length ?? 0;
    hooks += top.after_up?.length ?? 0;
    hooks += top.before_down?.length ?? 0;
    hooks += top.after_down?.length ?? 0;
  }
  for (const svc of Object.values(config.owned ?? {})) {
    const lc = svc?.lifecycle;
    if (!lc) continue;
    hooks += lc.before_start?.length ?? 0;
    hooks += lc.after_ready?.length ?? 0;
    hooks += lc.before_down?.length ?? 0;
  }
  for (const svc of Object.values(config.services ?? {})) {
    const lc = svc?.lifecycle;
    if (!lc) continue;
    hooks += lc.before_start?.length ?? 0;
    hooks += lc.after_ready?.length ?? 0;
    hooks += lc.before_down?.length ?? 0;
  }
  return { compose, owned, lifecycle_hooks: hooks, profiles };
}

function renderPretty(
  report: JsonReport,
  sink: (line: string) => void,
  warnSink?: (line: string) => void,
): void {
  const warnings = (report.errors ?? []).filter((e) => e.kind === "warning");
  const hard = (report.errors ?? []).filter((e) => e.kind !== "warning");
  const warnOut = warnSink ?? sink;

  if (report.ok) {
    sink(`✓ ${report.path}`);
    const s = report.summary;
    if (s) {
      sink(`  • ${plural(s.compose, "compose service")}`);
      sink(`  • ${plural(s.owned, "owned service")}`);
      sink(`  • ${plural(s.lifecycle_hooks, "lifecycle hook")}`);
      // Suppress "0 profile(s)" noise; JSON summary still reports zero.
      if (s.profiles !== undefined && s.profiles > 0) {
        sink(`  • ${plural(s.profiles, "profile")}`);
      }
    }
    for (const w of warnings) {
      warnOut(`${warnPrefix()} ${w.location}: ${w.message}`);
    }
    return;
  }
  sink(`✗ ${report.path}`);
  for (const e of hard) {
    sink(`  ${e.location}: ${e.message}`);
  }
  for (const w of warnings) {
    warnOut(`${warnPrefix()} ${w.location}: ${w.message}`);
  }
}

/** Yellow `!` on color-capable TTYs; plain `!` otherwise. */
function warnPrefix(): string {
  const stream = process.stderr as
    | (NodeJS.WriteStream & { hasColors?: () => boolean })
    | undefined;
  const colored =
    !!stream && typeof stream.hasColors === "function" && stream.hasColors();
  return colored ? "\x1b[33m!\x1b[0m" : "!";
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function suggest(needle: string, haystack: string[]): string | null {
  if (haystack.length === 0) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of haystack) {
    const d = levenshtein(needle, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  const threshold = Math.max(1, Math.floor(needle.length / 3));
  if (best && bestDist <= threshold) return best;
  return null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
