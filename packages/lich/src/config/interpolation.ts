/**
 * `${...}` interpolation engine for env values.
 *
 * Plan 1 (this file) does EAGER resolution: callers compute the full
 * runtime context (worktree info + allocated ports for compose services
 * and owned services) up-front and pass it in once.
 *
 * Plan 3 (profiles) will refactor to lazy per-key resolution so that a
 * value whose `${...}` reference points at a service not in the active
 * profile is allowed to exist as long as nothing in the resolved env
 * actually pulls it.
 *
 * Plan 4 (LEV-361, Task 12) extends the supported reference set to
 * include `${owned.<name>.captured.<key>}` — regex-captured values pulled
 * from a service's log stream after `ready_when` fires. The engine itself
 * is unchanged in shape: capture values live alongside `port`/`ports` on
 * the per-owned-service context entry, and the resolver routes through
 * an extra branch when the third segment is `captured`. The capture
 * values are populated at runtime by `src/commands/up.ts` (Task 14) from
 * the output of `src/ready/capture.ts` (Task 6).
 *
 * Supported reference shapes:
 *   ${worktree.name}                    -> ctx.worktree.name
 *   ${worktree.id}                      -> ctx.worktree.id
 *   ${worktree.path}                    -> ctx.worktree.path
 *   ${services.<name>.host_port}        -> ctx.services[name].host_port
 *   ${owned.<name>.port}                -> ctx.owned[name].port
 *   ${owned.<name>.ports.<key>}         -> ctx.owned[name].ports[key]
 *   ${owned.<name>.captured.<key>}      -> ctx.owned[name].captured[key]
 *
 * Escape sequence:
 *   $$ -> literal $
 *
 * The escape is handled by tokenising the string into literal `$$` runs
 * and `${...}` reference runs in a single regex pass, so a literal
 * sequence like `$$VAR` cannot be misread as a reference and a real
 * reference cannot be accidentally escaped by adjacent `$` characters.
 *
 * NOTE: this module is a pure substitution engine. The env pipeline
 * (Task 13) is responsible for auto-exporting LICH_WORKTREE and
 * LICH_STACK_ID into every service's env — do not inject them here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InterpolationContext {
  worktree: { name: string; id: string; path: string };
  services: Record<string, { host_port?: number }>;
  owned: Record<
    string,
    {
      port?: number;
      ports?: Record<string, number>;
      /**
       * Plan-4 captured values keyed by the capture name declared in
       * `owned.<name>.ready_when.capture`. Populated at runtime once a
       * service's ready_when fires; absent on the context entry until
       * then. Resolving `${owned.<name>.captured.<key>}` reads from
       * this map.
       */
      captured?: Record<string, string>;
    }
  >;
}

export class InterpolationError extends Error {
  /** The full reference that failed (e.g. `${services.foo.host_port}`). */
  readonly reference: string;
  /**
   * Optional source hint — usually the env key (or `<prefix>.<key>`) that
   * contained the offending reference, so the surfaced error can point at
   * a specific line in the user's config.
   */
  readonly source?: string;

  constructor(reference: string, message: string, source?: string) {
    const suffix = source ? ` (source: ${source})` : "";
    super(`${message}${suffix}`);
    this.name = "InterpolationError";
    this.reference = reference;
    this.source = source;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Token scanner: matches either a literal `$$` escape OR a `${...}`
 * reference. Anything not matched is copied verbatim. Doing it in one
 * pass means `$$` is always seen as a literal even when it precedes
 * `{...}` (`$${foo}` -> `${foo}` literal, no interpolation).
 */
const TOKEN_RE = /\$\$|\$\{([^}]*)\}/g;

const SUPPORTED_SHAPES = [
  "worktree.name",
  "worktree.id",
  "worktree.path",
  "services.<name>.host_port",
  "owned.<name>.port",
  "owned.<name>.ports.<key>",
  "owned.<name>.captured.<key>",
];

function unknownShape(ref: string, source: string | undefined): never {
  throw new InterpolationError(
    ref,
    `unknown reference path: ${ref.slice(2, -1)} ` +
      `(expected one of ${SUPPORTED_SHAPES.join(", ")})`,
    source,
  );
}

function unresolved(
  ref: string,
  detail: string,
  source: string | undefined,
): never {
  throw new InterpolationError(
    ref,
    `cannot resolve ${ref}: ${detail}`,
    source,
  );
}

/**
 * Resolve a single reference body (the part inside `${...}`) against
 * the context. Returns the string value or throws InterpolationError.
 */
function resolveReference(
  body: string,
  ctx: InterpolationContext,
  fullRef: string,
  source: string | undefined,
): string {
  const parts = body.split(".");
  if (parts.length < 2) {
    unknownShape(fullRef, source);
  }

  const [root, ...rest] = parts;

  if (root === "worktree") {
    if (rest.length !== 1) unknownShape(fullRef, source);
    const field = rest[0];
    if (field !== "name" && field !== "id" && field !== "path") {
      unknownShape(fullRef, source);
    }
    const v = ctx.worktree[field];
    if (v === undefined || v === null || v === "") {
      unresolved(fullRef, `worktree.${field} is not set`, source);
    }
    return String(v);
  }

  if (root === "services") {
    // services.<name>.host_port
    if (rest.length !== 2 || rest[1] !== "host_port") {
      unknownShape(fullRef, source);
    }
    const name = rest[0];
    const svc = ctx.services[name];
    if (!svc) {
      unresolved(
        fullRef,
        `no compose service named "${name}" in runtime context`,
        source,
      );
    }
    const port = svc.host_port;
    if (port === undefined || port === null) {
      unresolved(
        fullRef,
        `host_port for service "${name}" is not allocated yet`,
        source,
      );
    }
    return String(port);
  }

  if (root === "owned") {
    // owned.<name>.port  OR  owned.<name>.ports.<key>
    if (rest.length === 2 && rest[1] === "port") {
      const name = rest[0];
      const owned = ctx.owned[name];
      if (!owned) {
        unresolved(
          fullRef,
          `no owned service named "${name}" in runtime context`,
          source,
        );
      }
      const port = owned.port;
      if (port === undefined || port === null) {
        unresolved(
          fullRef,
          `port for owned service "${name}" is not allocated yet ` +
            `(or this service uses the multi-port \`ports:\` shape — ` +
            `use \${owned.${name}.ports.<key>} instead)`,
          source,
        );
      }
      return String(port);
    }

    if (rest.length === 3 && rest[1] === "ports") {
      const name = rest[0];
      const key = rest[2];
      const owned = ctx.owned[name];
      if (!owned) {
        unresolved(
          fullRef,
          `no owned service named "${name}" in runtime context`,
          source,
        );
      }
      const ports = owned.ports;
      if (!ports) {
        unresolved(
          fullRef,
          `owned service "${name}" has no multi-port \`ports:\` map ` +
            `(or it uses the single \`port:\` shape — ` +
            `use \${owned.${name}.port} instead)`,
          source,
        );
      }
      const port = ports[key];
      if (port === undefined || port === null) {
        unresolved(
          fullRef,
          `port "${key}" for owned service "${name}" is not allocated yet`,
          source,
        );
      }
      return String(port);
    }

    // Plan-4 (LEV-361): ${owned.<name>.captured.<key>}
    //
    // Captured values come from `ready_when.capture.<key>` regexes run
    // against the service's log buffer after ready fires. Resolution
    // happens at env-interpolation time, by which point Task-14 wiring
    // in up.ts has populated `ctx.owned[name].captured[key]`.
    //
    // Two distinct unresolved-error branches:
    //   1. The named owned service has no captured map at all — either
    //      it has no `ready_when.capture` configured, OR ready hasn't
    //      fired yet (e.g. an earlier-level service referring to a
    //      later-level service). Diagnostic mentions both possibilities.
    //   2. The map is present but the specific key is missing — capture
    //      didn't include that key (a typo or unused capture).
    if (rest.length === 3 && rest[1] === "captured") {
      const name = rest[0];
      const key = rest[2];
      const owned = ctx.owned[name];
      if (!owned) {
        unresolved(
          fullRef,
          `no owned service named "${name}" in runtime context`,
          source,
        );
      }
      const captured = owned.captured;
      if (!captured) {
        unresolved(
          fullRef,
          `owned service "${name}" has no captured values yet ` +
            `(does it declare \`ready_when.capture\`? has its ` +
            `ready_when fired? captures only become available after ` +
            `the producing service is ready)`,
          source,
        );
      }
      // `in` (not `key in captured && captured[key] !== undefined`):
      // we accept empty-string capture matches as legitimate values.
      if (!(key in captured)) {
        unresolved(
          fullRef,
          `capture "${key}" is not declared on owned service "${name}" ` +
            `(check \`owned.${name}.ready_when.capture\` for the key)`,
          source,
        );
      }
      return captured[key];
    }

    unknownShape(fullRef, source);
  }

  unknownShape(fullRef, source);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve every `${...}` reference in `value` against `ctx`. `$$` is
 * unescaped to a literal `$`. Throws {@link InterpolationError} on the
 * first reference that can't be resolved.
 *
 * Strings with no `${...}` references and no `$$` escapes are returned
 * by reference (no copy).
 */
export function interpolateString(
  value: string,
  ctx: InterpolationContext,
  source?: string,
): string {
  // Fast path: nothing to do.
  if (value.indexOf("$") === -1) return value;

  let out = "";
  let lastIndex = 0;

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(value)) !== null) {
    if (m.index > lastIndex) {
      out += value.slice(lastIndex, m.index);
    }

    if (m[0] === "$$") {
      out += "$";
    } else {
      // ${...} — m[1] is the body (possibly empty)
      const body = m[1];
      const fullRef = m[0];
      if (body.length === 0) {
        throw new InterpolationError(
          fullRef,
          `empty reference: \${} is not a valid interpolation`,
          source,
        );
      }
      out += resolveReference(body, ctx, fullRef, source);
    }

    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < value.length) {
    out += value.slice(lastIndex);
  }

  return out;
}

/**
 * Interpolate every value in a `Record<string, string>`. Throws on the
 * first failure; the thrown {@link InterpolationError}'s `source` field
 * is set to `sourcePrefix ? `${sourcePrefix}.${key}` : key` so callers
 * can point at the offending env entry.
 */
export function interpolateRecord(
  record: Record<string, string>,
  ctx: InterpolationContext,
  sourcePrefix?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    const src = sourcePrefix ? `${sourcePrefix}.${key}` : key;
    out[key] = interpolateString(record[key], ctx, src);
  }
  return out;
}
