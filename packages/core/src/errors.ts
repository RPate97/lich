export type CLIErrorCode =
  | 'UNKNOWN_COMMAND'
  | 'NO_PROJECT'
  | 'CONFIG_INVALID'
  | 'REGISTRY_CORRUPT'
  | 'COVERAGE_THRESHOLD'
  | 'INTERNAL'
  // Plan 16 / LEV-181 — EnvSource resolution + validation. Surfaced by
  // `packages/core/src/env/{resolve,errors}.ts` so the CLI dispatcher's
  // existing CLIError formatting picks them up unchanged.
  | 'ENV_SOURCE_MISSING'
  | 'NAMESPACE_COLLISION'
  | 'BULK_RESOLVE_FAILED'
  // Plan 15 / LEV-173 — auth-slot impls that need a database surface this
  // when no ORM plugin is loaded (and the test-mode fallback isn't active).
  // Raised by `@levelzero/plugin-better-auth`'s adapter when
  // `AuthContext.getActiveOrm()` returns undefined.
  | 'AUTH_NO_ORM';

/**
 * Options bag for {@link CLIError}. Beyond the original `hint` + `details`
 * shape, LEV-197 lets every throw carry the underlying error that caused
 * the failure so the renderer can walk the cause chain (Node native
 * `Error.cause`) all the way to the original `stderr` / `Error.message`.
 *
 * `cause` is the underlying error (a `Error` or anything thrown). Forwarded
 * to `super(message, { cause })` so `err.cause` is reachable via the standard
 * lookup the rest of the ecosystem expects (vitest's diff output, Node's
 * default formatter, etc.). The renderer walks the chain via `e.cause` and
 * truncates long blobs so a 4MB stderr can't blow the terminal.
 *
 * `details` is a structured payload included in `toJSON()` for machine
 * consumers — typical shape `{ stderr, stdout, exitCode, command }` for
 * commands that shell out, `{ generator, generators }` for `gen`, etc. The
 * pretty renderer prints the keys verbatim (one per line, multi-line values
 * indented under their key), so keep keys short and lowercased.
 */
export interface CLIErrorOptions {
  hint?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class CLIError extends Error {
  public readonly hint?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    public readonly code: CLIErrorCode,
    message: string,
    hintOrOptions?: string | CLIErrorOptions,
  ) {
    // Forwarding `cause` to `super(message, { cause })` is the Node native
    // contract: it sets the property in a way that's both enumerable AND
    // walkable by upstream error formatters (vitest, util.inspect, etc.).
    // The renderer walks `err.cause` directly so we don't need to mirror it
    // onto `this` separately.
    const cause =
      typeof hintOrOptions === 'object' && hintOrOptions !== null
        ? hintOrOptions.cause
        : undefined;
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'CLIError';
    if (typeof hintOrOptions === 'string') {
      this.hint = hintOrOptions;
    } else if (hintOrOptions) {
      this.hint = hintOrOptions.hint;
      this.details = hintOrOptions.details;
    }
  }

  /**
   * Machine-readable shape for `--json` output. Beyond the prior
   * `code`/`message`/`hint`/`details` payload, LEV-197 surfaces the cause
   * chain so consumers can inspect the underlying error (process stderr,
   * thrown exception, etc.) without parsing the pretty rendering. Each
   * link in the chain is reduced to `{ name, message, stack? }`; we only
   * include `stack` when present so non-Error throws (a thrown string,
   * etc.) round-trip cleanly.
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint ?? null,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.cause !== undefined ? { cause: serializeCauseChain(this.cause) } : {}),
    };
  }
}

/**
 * Serialized link in a cause chain — what {@link CLIError.toJSON} emits per
 * step. Walked via the optional `cause` field. We cap recursion to
 * {@link MAX_CAUSE_DEPTH} so a self-referential chain can't blow the stack.
 */
export interface SerializedCause {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedCause;
}

const MAX_CAUSE_DEPTH = 8;

/**
 * Walk an `Error.cause` chain and return a JSON-safe nested object. Non-
 * Error causes (a thrown string, a plain object) are coerced to a
 * `name: 'Error'` shape with the value stringified in `message` so the
 * output is uniform regardless of what the caller passed.
 *
 * Truncates `stack` to 4 KiB per frame — full stacks are useful for
 * debugging but a single deep stack can blow the JSON payload past 100 KiB
 * which most consumers (and our pretty renderer's "truncate after N bytes"
 * guard) can't usefully chew through.
 */
function serializeCauseChain(cause: unknown, depth = 0): SerializedCause | undefined {
  if (depth >= MAX_CAUSE_DEPTH || cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) {
    const next = (cause as { cause?: unknown }).cause;
    const out: SerializedCause = {
      name: cause.name || 'Error',
      message: cause.message,
    };
    if (cause.stack) out.stack = truncate(cause.stack, 4 * 1024);
    if (next !== undefined && next !== null) {
      const nested = serializeCauseChain(next, depth + 1);
      if (nested) out.cause = nested;
    }
    return out;
  }
  // Coerce non-Error throws into a uniform shape so consumers always see
  // `{ name, message }`.
  return { name: 'Error', message: typeof cause === 'string' ? cause : safeStringify(cause) };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated, ${s.length - max} bytes omitted]`;
}
