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

export interface CLIErrorOptions {
  hint?: string;
  /** Structured payload included in toJSON() for machine consumers. */
  details?: unknown;
}

export class CLIError extends Error {
  public readonly hint?: string;
  public readonly details?: unknown;

  constructor(
    public readonly code: CLIErrorCode,
    message: string,
    hintOrOptions?: string | CLIErrorOptions,
  ) {
    super(message);
    this.name = 'CLIError';
    if (typeof hintOrOptions === 'string') {
      this.hint = hintOrOptions;
    } else if (hintOrOptions) {
      this.hint = hintOrOptions.hint;
      this.details = hintOrOptions.details;
    }
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint ?? null,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}
