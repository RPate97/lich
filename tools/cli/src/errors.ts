export type CLIErrorCode =
  | 'UNKNOWN_COMMAND'
  | 'NO_PROJECT'
  | 'CONFIG_INVALID'
  | 'REGISTRY_CORRUPT'
  | 'INTERNAL';

export class CLIError extends Error {
  constructor(public readonly code: CLIErrorCode, message: string, public readonly hint?: string) {
    super(message);
    this.name = 'CLIError';
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint ?? null };
  }
}
