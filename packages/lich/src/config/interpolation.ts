/**
 * `${...}` interpolation engine for env values.
 *
 * Supported reference shapes:
 *   ${worktree.name}                    -> ctx.worktree.name
 *   ${worktree.id}                      -> ctx.worktree.id
 *   ${worktree.path}                    -> ctx.worktree.path
 *   ${services.<name>.host_port}        -> ctx.services[name].host_port (primary)
 *   ${services.<name>.host_port_<idx>}  -> ctx.services[name].ports[<idx>]
 *   ${services.<name>.ports.<key>}      -> ctx.services[name].ports[key]
 *   ${owned.<name>.port}                -> ctx.owned[name].port
 *   ${owned.<name>.ports.<key>}         -> ctx.owned[name].ports[key]
 *   ${owned.<name>.captured.<key>}      -> ctx.owned[name].captured[key]
 *
 * Multi-port compose-service syntax: `host_port_<idx>` indexes the array-form
 * `ports:` block (numeric keys); `ports.<key>` looks up the Record-form
 * (logical-name keys). Footgun: the two forms are NOT interchangeable.
 *
 * Escape: `$$` -> literal `$`. Tokenized in one regex pass so `$${foo}` is
 * a literal `${foo}`, not an interpolation.
 */

import { suggestProperty } from "../util/levenshtein.js";

export interface InterpolationContext {
  worktree: { name: string; id: string; path: string };
  services: Record<
    string,
    {
      /** Primary host port — first declared port (insertion order). */
      host_port?: number;
      /**
       * Full per-service host-port map. Keys are numeric strings for
       * array-form `ports:` declarations, logical names for Record-form.
       */
      ports?: Record<string, number>;
    }
  >;
  owned: Record<
    string,
    {
      port?: number;
      ports?: Record<string, number>;
      /** Populated at runtime once ready_when.capture regexes fire. */
      captured?: Record<string, string>;
    }
  >;
}

export class InterpolationError extends Error {
  /** The full reference that failed (e.g. `${services.foo.host_port}`). */
  readonly reference: string;
  /** Source hint — usually the env key that contained the reference. */
  readonly source?: string;

  constructor(reference: string, message: string, source?: string) {
    const suffix = source ? ` (source: ${source})` : "";
    super(`${message}${suffix}`);
    this.name = "InterpolationError";
    this.reference = reference;
    this.source = source;
  }
}

/**
 * Token scanner: matches either a literal `$$` escape OR a `${...}`
 * reference in one pass so `$$` is always a literal even when followed
 * by `{...}`.
 */
const TOKEN_RE = /\$\$|\$\{([^}]*)\}/g;

const SUPPORTED_SHAPES = [
  "worktree.name",
  "worktree.id",
  "worktree.path",
  "services.<name>.host_port",
  "services.<name>.host_port_<idx>",
  "services.<name>.ports.<key>",
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
    if (rest.length === 2 && rest[1].startsWith("host_port")) {
      const name = rest[0];
      const svc = ctx.services[name];
      if (!svc) {
        unresolved(
          fullRef,
          `no compose service named "${name}" in runtime context`,
          source,
        );
      }

      // Suffix-less `host_port` returns the primary port.
      if (rest[1] === "host_port") {
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

      // host_port_<idx> — positional index into array-form ports.
      if (rest[1].startsWith("host_port_")) {
        const suffix = rest[1].slice("host_port_".length);
        // Non-numeric suffixes (e.g. `host_port_admin`) are a typo —
        // they should route to `ports.<key>` instead.
        if (suffix.length === 0 || !/^\d+$/.test(suffix)) {
          unknownShape(fullRef, source);
        }
        const ports = svc.ports;
        if (!ports) {
          unresolved(
            fullRef,
            `compose service "${name}" has no allocated ports map ` +
              `(allocation may not have run yet)`,
            source,
          );
        }
        const port = ports[suffix];
        if (port === undefined || port === null) {
          // Distinguish out-of-range (array form) from unknown numeric key.
          const declaredKeys = Object.keys(ports);
          const allNumeric =
            declaredKeys.length > 0 &&
            declaredKeys.every((k) => /^\d+$/.test(k));
          if (allNumeric) {
            unresolved(
              fullRef,
              `service "${name}" has only ${declaredKeys.length} port(s) ` +
                `declared; ${fullRef} is out of range (valid indices: ` +
                `0..${declaredKeys.length - 1})`,
              source,
            );
          }
          unresolved(
            fullRef,
            `compose service "${name}" has no port at index "${suffix}" ` +
              `(use \${services.${name}.ports.<key>} for Record-form ports)`,
            source,
          );
        }
        return String(port);
      }

      unknownShape(fullRef, source);
    }

    // services.<name>.ports.<key> — logical-name lookup (Record form).
    if (rest.length === 3 && rest[1] === "ports") {
      const name = rest[0];
      const key = rest[2];
      const svc = ctx.services[name];
      if (!svc) {
        unresolved(
          fullRef,
          `no compose service named "${name}" in runtime context`,
          source,
        );
      }
      const ports = svc.ports;
      if (!ports) {
        unresolved(
          fullRef,
          `compose service "${name}" has no allocated ports map ` +
            `(allocation may not have run yet)`,
          source,
        );
      }
      const port = ports[key];
      if (port === undefined || port === null) {
        const hint = suggestProperty(key, Object.keys(ports)) ?? "";
        unresolved(
          fullRef,
          `port "${key}" is not declared on compose service "${name}" ` +
            `(declared keys: ${Object.keys(ports).join(", ") || "<none>"})` +
            hint,
          source,
        );
      }
      return String(port);
    }

    unknownShape(fullRef, source);
  }

  if (root === "owned") {
    // owned.<name>.port — single-port shape.
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

    // owned.<name>.ports.<key> — logical-name lookup (multi-port shape).
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
        const declaredKeys = Object.keys(ports);
        const declaredList = declaredKeys.join(", ") || "<none>";
        const hint = suggestProperty(key, declaredKeys) ?? "";
        unresolved(
          fullRef,
          `port "${key}" for owned service "${name}" is not allocated yet ` +
            `(declared keys: ${declaredList})` +
            hint,
          source,
        );
      }
      return String(port);
    }

    // owned.<name>.captured.<key> — capture-name lookup (not env-name).
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
      // `in` check accepts empty-string capture matches as legitimate.
      if (!(key in captured)) {
        const declaredKeys = Object.keys(captured);
        const declaredList = declaredKeys.join(", ") || "<none>";
        const hint = suggestProperty(key, declaredKeys) ?? "";
        unresolved(
          fullRef,
          `capture "${key}" is not declared on owned service "${name}" ` +
            `(declared keys: ${declaredList}; check ` +
            `\`owned.${name}.ready_when.capture\` for the key)` +
            hint,
          source,
        );
      }
      return captured[key];
    }

    unknownShape(fullRef, source);
  }

  unknownShape(fullRef, source);
}

/**
 * Resolve every `${...}` reference in `value` against `ctx`. `$$` is
 * unescaped to a literal `$`. Throws {@link InterpolationError} on the
 * first reference that can't be resolved. Strings with no `$` are returned
 * by reference.
 */
export function interpolateString(
  value: string,
  ctx: InterpolationContext,
  source?: string,
): string {
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
 * Interpolate every value in a `Record<string, string>`. On failure, the
 * thrown {@link InterpolationError}'s `source` is set to
 * `sourcePrefix ? `${sourcePrefix}.${key}` : key`.
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
