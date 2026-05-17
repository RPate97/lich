export type CLIErrorCode =
  | 'UNKNOWN_COMMAND'
  | 'NO_PROJECT'
  | 'CONFIG_INVALID'
  | 'REGISTRY_CORRUPT'
  | 'COVERAGE_THRESHOLD'
  | 'INTERNAL';

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
