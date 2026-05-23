/**
 * `lich validate [path]` — static analysis of a lich.yaml.
 *
 * Plan 1 scope:
 *   1. Parse + schema-validate via `config/parse.ts` (Task 2).
 *   2. Reference checks: every `depends_on` target must be declared
 *      (compose OR owned — cross-kind allowed).
 *   3. Cycle detection via `deps/sort.ts`'s `topoLevels` (Kahn's).
 *   4. Regex compile checks on `ready_when.log_match` and
 *      `fail_when.log_match` patterns.
 *   5. Best-effort interpolation reference structural check on any
 *      env value containing `${...}` — verifies the reference prefix
 *      is a supported shape and (for service refs) the named service
 *      exists.
 *
 * What this command DOES NOT do (per spec section 5):
 *   - Execute anything (no shell-outs, no docker calls, no service starts).
 *   - Validate `env_groups` / `commands` / `profiles` — those plans (2-3)
 *     will tighten the schema. We accept those sections opaquely today.
 *   - Verify referenced files exist (env_files paths, cwd directories) —
 *     filesystem-touch validation is Plan 4 polish.
 *
 * Output:
 *   - Pretty (default): a `✓ <path>` line plus a one-line summary, OR
 *     a `✗ <path>` line followed by `<location>: <message>` lines.
 *   - `--json`: structured object — see {@link JsonReport}.
 *
 * Exit: 0 if no errors, 1 otherwise.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { parseConfig, type ParseError } from "../config/parse.js";
import { buildGraph, type NodeDecl } from "../deps/graph.js";
import { topoLevels, CycleError } from "../deps/sort.js";
import type { EnvMap, LichConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /**
   * Path to a lich.yaml file, OR a directory containing one. Defaults to
   * `lich.yaml` in `cwd`.
   */
  path?: string;
  /** Emit JSON instead of pretty output. */
  json?: boolean;
  /** Where to resolve a default `lich.yaml` from (defaults to `process.cwd()`). */
  cwd?: string;
  /** Sink for stdout (defaults to console). */
  stdout?: (line: string) => void;
  /** Sink for stderr (defaults to console.error). */
  stderr?: (line: string) => void;
}

export interface ValidationError {
  /** Coarse error category. */
  kind: "io" | "yaml" | "schema" | "ref" | "cycle" | "regex" | "interp";
  /** Source location — `<file>:<line>:<col>` when available, else just `<file>`. */
  location: string;
  /** Human-readable message, ready to print. */
  message: string;
}

export interface ValidationSummary {
  compose: number;
  owned: number;
  lifecycle_hooks: number;
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runValidate(
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? ((s: string) => console.log(s));
  const err = opts.stderr ?? ((s: string) => console.error(s));

  // ---- resolve target path -------------------------------------------------
  const resolvedPath = resolveYamlPath(opts.path, cwd);

  // ---- run validation ------------------------------------------------------
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
      // Run the additional reference checks (depends_on, cycles, regex,
      // interpolation references). Each pushes onto `errors`.
      checkDependsOnAndCycles(config, resolvedPath, errors);
      checkRegexes(config, resolvedPath, errors);
      checkInterpolations(config, resolvedPath, errors);
      summary = computeSummary(config);
    }
  }

  const ok = errors.length === 0;
  const report: JsonReport = ok
    ? { ok: true, path: resolvedPath, summary: summary ?? undefined }
    : { ok: false, path: resolvedPath, errors };

  // ---- emit output ---------------------------------------------------------
  if (opts.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    renderPretty(report, ok ? out : err);
  }

  return { exitCode: ok ? 0 : 1, report };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveYamlPath(input: string | undefined, cwd: string): string {
  // No arg → look up `lich.yaml` in cwd.
  if (!input) return join(cwd, "lich.yaml");

  const abs = isAbsolute(input) ? input : resolve(cwd, input);

  // If user pointed at a directory, look for lich.yaml inside it.
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return join(abs, "lich.yaml");
  } catch {
    // Doesn't exist — return as-is so the caller emits a clean "not found"
    // error pointing at the literal path they asked about.
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Parse-error → validation-error mapping
// ---------------------------------------------------------------------------

function parseErrorToValidationError(e: ParseError): ValidationError {
  return { kind: e.kind, location: e.location, message: e.message };
}

// ---------------------------------------------------------------------------
// Reference checks
// ---------------------------------------------------------------------------

/**
 * Build the dependency graph from compose `services` + `owned` and verify:
 *   - every `depends_on` target is a declared node (compose OR owned)
 *   - there are no cycles in the dependency graph
 *
 * We do BOTH checks regardless of the other's outcome: missing targets are
 * reported with their concrete locations, then cycle detection runs on the
 * subgraph of declared nodes (so a cycle within declared nodes still shows
 * up even if there are also unknown targets).
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

  // ---- missing targets ---------------------------------------------------
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

  // ---- cycles ------------------------------------------------------------
  // buildGraph throws on duplicate node names; the schema's
  // `additionalProperties` shape prevents that in practice — distinct keys
  // in `services` and `owned` could collide, but the spec is silent on
  // disallowing that and it would surface as a duplicate-node error
  // elsewhere. Wrap defensively to avoid crashing the validator.
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

// ---------------------------------------------------------------------------
// Regex checks
// ---------------------------------------------------------------------------

function checkRegexes(
  config: LichConfig,
  path: string,
  errors: ValidationError[],
): void {
  // owned.*.ready_when.log_match
  // owned.*.fail_when.log_match
  for (const [name, svc] of Object.entries(config.owned ?? {})) {
    const ready = svc?.ready_when;
    if (ready && typeof ready.log_match === "string") {
      tryCompile(
        ready.log_match,
        `${path} (/owned/${name}/ready_when/log_match)`,
        errors,
      );
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

  // services.*.ready_when.* (not common in Plan 1 but cheap to check).
  // The current compose schema doesn't define ready_when directly on a
  // compose service — compose uses healthcheck — but later plans may add
  // it. Defensive check: only walk a `ready_when` field if present.
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

// ---------------------------------------------------------------------------
// Interpolation reference checks (structural, no port allocation)
// ---------------------------------------------------------------------------

/**
 * Walk `${...}` references in every env value and verify each one is a
 * structurally supported shape and (for service refs) points at a declared
 * service of the correct kind. Does NOT actually resolve values — that's
 * runtime.
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
  // Per-owned env overrides
  for (const [name, svc] of Object.entries(config.owned ?? {})) {
    if (svc?.env) {
      sources.push({ env: svc.env, loc: `/owned/${name}/env` });
    }
  }

  // Also check `ready_when.tcp` / `ready_when.http_get` interpolations on
  // owned services — these commonly use `${owned.X.ports.Y}` and a bad
  // ref would be just as broken there as in `env`.
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
}

const REF_RE = /\$\$|\$\{([^}]*)\}/g;

function checkValueRefs(
  value: string,
  location: string,
  composeNames: Set<string>,
  ownedNames: Set<string>,
  config: LichConfig,
  errors: ValidationError[],
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
    // services.<name>.host_port
    if (rest.length !== 2 || rest[1] !== "host_port") {
      errors.push({
        kind: "interp",
        location,
        message: `unknown reference ${fullRef} (expected \${services.<name>.host_port})`,
      });
      return;
    }
    const name = rest[0];
    if (!composeNames.has(name)) {
      const suggestion = suggest(name, [...composeNames]);
      const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
      errors.push({
        kind: "interp",
        location,
        message: `${fullRef} references unknown compose service "${name}"${hint}`,
      });
    }
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
      // Cross-check shape: if the named owned service uses `ports:` (multi)
      // instead of `port:` (single), `${owned.X.port}` is wrong.
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
    errors.push({
      kind: "interp",
      location,
      message: `unknown reference ${fullRef} (expected \${owned.<name>.port} or \${owned.<name>.ports.<key>})`,
    });
    return;
  }

  errors.push({
    kind: "interp",
    location,
    message: `unknown reference ${fullRef} (supported: worktree.*, services.<name>.host_port, owned.<name>.port, owned.<name>.ports.<key>)`,
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function computeSummary(config: LichConfig): ValidationSummary {
  const compose = Object.keys(config.services ?? {}).length;
  const owned = Object.keys(config.owned ?? {}).length;

  let hooks = 0;
  const top = config.lifecycle;
  if (top) {
    hooks += top.before_up?.length ?? 0;
    hooks += top.after_up?.length ?? 0;
    hooks += top.before_down?.length ?? 0;
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
  return { compose, owned, lifecycle_hooks: hooks };
}

// ---------------------------------------------------------------------------
// Pretty output
// ---------------------------------------------------------------------------

function renderPretty(
  report: JsonReport,
  sink: (line: string) => void,
): void {
  if (report.ok) {
    sink(`✓ ${report.path}`);
    const s = report.summary;
    if (s) {
      sink(`  • ${plural(s.compose, "compose service")}`);
      sink(`  • ${plural(s.owned, "owned service")}`);
      sink(`  • ${plural(s.lifecycle_hooks, "lifecycle hook")}`);
    }
    return;
  }
  sink(`✗ ${report.path}`);
  for (const e of report.errors ?? []) {
    sink(`  ${e.location}: ${e.message}`);
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// "Did you mean" — small Levenshtein-based suggestion
// ---------------------------------------------------------------------------

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
  // Only suggest if the edit distance is small relative to the input.
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
