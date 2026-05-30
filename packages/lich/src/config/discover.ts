/**
 * Glob-based `owned:` service discovery. A `discover:` block on an owned
 * entry expands at parse time into N synthetic owned services (one per
 * matched file). Every other field on the parent is copied verbatim into
 * each instance; the original `discover:` key is removed so downstream
 * code only sees regular owned services.
 *
 * Template grammar:
 *   `${var}` or `${var | filter1 | filter2:arg}`
 *   Vars: `basename`, `basename_no_ext`, `dirname`
 *   Filters: `kebab`, `snake`, `strip_suffix:X`, `strip_prefix:X`
 *
 * Matches are sorted alphabetically by materialized service name for
 * deterministic ordering.
 */

import { resolve, basename as pathBasename, dirname as pathDirname, sep } from "node:path";

import type { LichConfig, OwnedDiscover, OwnedService } from "./types.js";
import { suggestProperty } from "../util/levenshtein.js";

/**
 * Discover-block failure. Caught by parse.ts and surfaced as a `ParseError`.
 * `location` is a JSON-pointer-style path into the original config
 * (e.g. `/owned/workers/discover/cmd_template`).
 */
export class DiscoverError extends Error {
  constructor(
    message: string,
    public readonly location: string,
  ) {
    super(message);
    this.name = "DiscoverError";
  }
}

const KNOWN_VARS = ["basename", "basename_no_ext", "dirname"] as const;
type KnownVar = (typeof KNOWN_VARS)[number];

const KNOWN_FILTERS = [
  "kebab",
  "snake",
  "strip_suffix",
  "strip_prefix",
] as const;
type KnownFilter = (typeof KNOWN_FILTERS)[number];

/** Per-file context fed into template expansion. */
export interface DiscoverContext {
  /** Filename including extension. Example: `AlphaTemporalWorker.ts`. */
  basename: string;
  /** Filename minus the final extension. Example: `AlphaTemporalWorker`. */
  basename_no_ext: string;
  /** Parent dir, relative to the glob root. Empty string when at the root. */
  dirname: string;
}

/**
 * Expand every `owned.<name>.discover:` block. Mutates `config.owned` in
 * place. Zero matches is NOT an error. Throws {@link DiscoverError} on
 * template / glob / collision failures.
 *
 * @param config   the parsed config (post-AJV).
 * @param configDir absolute directory the lich.yaml lives in.
 */
export async function expandDiscover(
  config: LichConfig,
  configDir: string,
): Promise<void> {
  if (!config.owned) return;

  const originalNames = Object.keys(config.owned);

  // Carry non-discover entries verbatim; merge expanded output in below.
  const expanded: Record<string, OwnedService> = {};
  for (const name of originalNames) {
    const svc = config.owned[name];
    if (!svc?.discover) {
      expanded[name] = svc;
    }
  }

  const discoverParents = new Map<string, string[]>();

  for (const parentName of originalNames) {
    const parent = config.owned[parentName];
    if (!parent?.discover) continue;

    // Glob root precedence: discover.cwd > parent.cwd > configDir.
    const globRootRel = parent.discover.cwd ?? parent.cwd ?? ".";
    const globRoot = resolve(configDir, globRootRel);

    let instances: { name: string; svc: OwnedService }[];
    try {
      instances = await expandOne(parent, parentName, globRoot);
    } catch (err) {
      if (err instanceof DiscoverError) throw err;
      throw new DiscoverError(
        `failed to expand discover block: ${(err as Error).message ?? String(err)}`,
        `/owned/${parentName}/discover`,
      );
    }

    instances.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const childNames: string[] = [];
    for (const { name, svc } of instances) {
      if (name in expanded) {
        throw new DiscoverError(
          `discovered service "${name}" collides with another owned service (from "${parentName}" discover block). ` +
            `Rename the existing entry or adjust the name_template to disambiguate.`,
          `/owned/${parentName}/discover/name_template`,
        );
      }
      expanded[name] = svc;
      childNames.push(name);
    }
    discoverParents.set(parentName, childNames);
  }

  config.owned = expanded;
  config._discoverParents = discoverParents;
}

/**
 * Expand one `discover:` block: walk glob, build per-file context, render
 * templates, copy parent fields into each instance.
 */
async function expandOne(
  parent: OwnedService,
  parentName: string,
  globRoot: string,
): Promise<{ name: string; svc: OwnedService }[]> {
  const disc = parent.discover!;
  const locBase = `/owned/${parentName}/discover`;

  // Compile templates up front so syntax errors fail before the (slower) glob walk.
  const nameTpl = compileTemplate(disc.name_template, `${locBase}/name_template`);
  const cmdTpl = compileTemplate(disc.cmd_template, `${locBase}/cmd_template`);

  const matches = await runGlob(disc.glob, globRoot, `${locBase}/glob`);

  const out: { name: string; svc: OwnedService }[] = [];
  for (const relPath of matches) {
    const ctx = buildContext(relPath);
    const name = nameTpl(ctx);
    const cmd = cmdTpl(ctx);

    if (name.length === 0) {
      throw new DiscoverError(
        `name_template expanded to an empty string for ${relPath} — adjust the template (current: ${JSON.stringify(disc.name_template)})`,
        `${locBase}/name_template`,
      );
    }
    if (cmd.length === 0) {
      throw new DiscoverError(
        `cmd_template expanded to an empty string for ${relPath} — adjust the template (current: ${JSON.stringify(disc.cmd_template)})`,
        `${locBase}/cmd_template`,
      );
    }

    // Shallow copy: `ready_when` / `fail_when` / `env` / `lifecycle` are
    // shared by reference, which is fine — runtime treats them read-only.
    const svc: OwnedService = { ...parent, cmd };
    if (disc.cwd !== undefined) svc.cwd = disc.cwd;
    delete svc.discover;

    out.push({ name, svc });
  }
  return out;
}

/**
 * Walk `glob` rooted at `globRoot`, returning file paths relative to
 * `globRoot`. Files only; doesn't cross outside the root. Dotfiles are
 * skipped by default — explicit `.*` in the glob still matches them.
 */
async function runGlob(
  pattern: string,
  globRoot: string,
  location: string,
): Promise<string[]> {
  let glob: Bun.Glob;
  try {
    glob = new Bun.Glob(pattern);
  } catch (err) {
    throw new DiscoverError(
      `invalid glob pattern ${JSON.stringify(pattern)}: ${(err as Error).message ?? String(err)}`,
      location,
    );
  }

  const matches: string[] = [];
  try {
    for await (const file of glob.scan({
      cwd: globRoot,
      onlyFiles: true,
    })) {
      matches.push(file);
    }
  } catch (err) {
    throw new DiscoverError(
      `glob scan failed for ${JSON.stringify(pattern)} (rooted at ${globRoot}): ${(err as Error).message ?? String(err)}`,
      location,
    );
  }
  return matches;
}

/**
 * Compute the {@link DiscoverContext} for a matched file. `relPath` is
 * expected to be relative to the glob root.
 */
export function buildContext(relPath: string): DiscoverContext {
  // Normalize separators — Bun.Glob returns forward slashes, but defensive
  // for testability across platforms.
  const norm = relPath.split(sep).join("/");
  const base = pathBasename(norm);
  const dir = pathDirname(norm);
  // pathDirname returns "." for root files — surface "" so templates like
  // `${dirname}/${basename_no_ext}` don't produce a stray `./` prefix.
  const dirname = dir === "." ? "" : dir;

  const dotIdx = base.lastIndexOf(".");
  // No dot OR leading dot (`.gitignore`) → no extension to strip.
  const basename_no_ext = dotIdx <= 0 ? base : base.slice(0, dotIdx);

  return {
    basename: base,
    basename_no_ext,
    dirname,
  };
}

/**
 * Compile a template string into a render function. Tokenizes once;
 * re-renders against each per-file context. Throws {@link DiscoverError}
 * at compile time for syntactic problems.
 */
export type TemplateRenderer = (ctx: DiscoverContext) => string;

export function compileTemplate(
  template: string,
  location: string,
): TemplateRenderer {
  interface LiteralPart { kind: "literal"; value: string; }
  interface ExpressionPart {
    kind: "expr";
    varName: KnownVar;
    filters: Array<{ name: KnownFilter; arg?: string }>;
  }
  type Part = LiteralPart | ExpressionPart;

  const parts: Part[] = [];

  let i = 0;
  while (i < template.length) {
    const dollarIdx = template.indexOf("${", i);
    if (dollarIdx === -1) {
      if (i < template.length) {
        parts.push({ kind: "literal", value: template.slice(i) });
      }
      break;
    }
    if (dollarIdx > i) {
      parts.push({ kind: "literal", value: template.slice(i, dollarIdx) });
    }
    const closeIdx = template.indexOf("}", dollarIdx + 2);
    if (closeIdx === -1) {
      throw new DiscoverError(
        `template has unterminated \`\${\` block (template: ${JSON.stringify(template)})`,
        location,
      );
    }
    const body = template.slice(dollarIdx + 2, closeIdx);
    parts.push(parseExpression(body, template, location));
    i = closeIdx + 1;
  }

  return (ctx: DiscoverContext): string => {
    const out: string[] = [];
    for (const part of parts) {
      if (part.kind === "literal") {
        out.push(part.value);
      } else {
        let value = ctx[part.varName];
        for (const f of part.filters) {
          value = applyFilter(f.name, f.arg, value);
        }
        out.push(value);
      }
    }
    return out.join("");
  };
}

function parseExpression(
  body: string,
  fullTemplate: string,
  location: string,
): {
  kind: "expr";
  varName: KnownVar;
  filters: Array<{ name: KnownFilter; arg?: string }>;
} {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new DiscoverError(
      `template has empty \`\${}\` expression (template: ${JSON.stringify(fullTemplate)})`,
      location,
    );
  }

  // First segment is the var; rest are filters.
  const segments = trimmed.split("|").map((s) => s.trim());
  const rawVar = segments[0];
  const rawFilters = segments.slice(1);

  const varName = validateVar(rawVar, fullTemplate, location);

  const filters: Array<{ name: KnownFilter; arg?: string }> = [];
  for (const seg of rawFilters) {
    if (seg.length === 0) {
      throw new DiscoverError(
        `empty filter in template ${JSON.stringify(fullTemplate)} — remove the trailing "|" or fill in the filter name`,
        location,
      );
    }
    // Form: `<name>` or `<name>:<arg>`. Arg is everything after the first
    // colon so arg values containing colons work.
    const colonIdx = seg.indexOf(":");
    const filterName =
      colonIdx === -1 ? seg : seg.slice(0, colonIdx).trim();
    const arg = colonIdx === -1 ? undefined : seg.slice(colonIdx + 1);
    const validated = validateFilter(filterName, fullTemplate, location);
    if (filterRequiresArg(validated) && (arg === undefined || arg.length === 0)) {
      throw new DiscoverError(
        `filter ${JSON.stringify(filterName)} requires an argument (use ${filterName}:<value>) in template ${JSON.stringify(fullTemplate)}`,
        location,
      );
    }
    if (!filterRequiresArg(validated) && arg !== undefined) {
      throw new DiscoverError(
        `filter ${JSON.stringify(filterName)} does not accept an argument (template: ${JSON.stringify(fullTemplate)})`,
        location,
      );
    }
    filters.push({ name: validated, arg });
  }

  return { kind: "expr", varName, filters };
}

function validateVar(
  raw: string,
  template: string,
  location: string,
): KnownVar {
  if (KNOWN_VARS.includes(raw as KnownVar)) return raw as KnownVar;
  const hint = suggestProperty(raw, [...KNOWN_VARS]) ?? ` (known: ${KNOWN_VARS.join(", ")})`;
  throw new DiscoverError(
    `unknown template var ${JSON.stringify(raw)} in template ${JSON.stringify(template)}${hint}`,
    location,
  );
}

function validateFilter(
  raw: string,
  template: string,
  location: string,
): KnownFilter {
  if (KNOWN_FILTERS.includes(raw as KnownFilter)) return raw as KnownFilter;
  const hint = suggestProperty(raw, [...KNOWN_FILTERS]) ?? ` (known: ${KNOWN_FILTERS.join(", ")})`;
  throw new DiscoverError(
    `unknown template filter ${JSON.stringify(raw)} in template ${JSON.stringify(template)}${hint}`,
    location,
  );
}

function filterRequiresArg(name: KnownFilter): boolean {
  return name === "strip_suffix" || name === "strip_prefix";
}

function applyFilter(
  name: KnownFilter,
  arg: string | undefined,
  value: string,
): string {
  switch (name) {
    case "kebab":
      return slugify(value, "-");
    case "snake":
      return slugify(value, "_");
    case "strip_suffix":
      return value.endsWith(arg ?? "") ? value.slice(0, value.length - (arg ?? "").length) : value;
    case "strip_prefix":
      return value.startsWith(arg ?? "") ? value.slice((arg ?? "").length) : value;
  }
}

/**
 * Slugify for `kebab` / `snake`. Inserts boundaries before uppercase
 * letters so `AlphaTemporalWorker` becomes `email-temporal-worker` (not
 * `emailtemporalworker`).
 */
function slugify(input: string, sep: string): string {
  const withBoundaries = input.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const lower = withBoundaries.toLowerCase();
  const collapsed = lower.replace(/[^a-z0-9]+/g, sep);
  const trimStart = collapsed.startsWith(sep)
    ? collapsed.slice(sep.length)
    : collapsed;
  const trimEnd = trimStart.endsWith(sep)
    ? trimStart.slice(0, trimStart.length - sep.length)
    : trimStart;
  return trimEnd;
}
