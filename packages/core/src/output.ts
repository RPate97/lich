import type { CLIError } from './errors';

export type OutputFormat = 'json' | 'pretty';

/**
 * Format a command's structured result for stdout.
 *
 * `pretty` is the LEV-168 default — when the command itself produced a
 * string (the common case for commands that ship their own
 * `renderPretty()`), we pass it through unchanged so the rendered output
 * lands on stdout with no extra quoting. For commands that haven't yet
 * grown a pretty renderer the fallback is indented JSON, which is at least
 * readable; consumers that need a stable shape should pass `--json`.
 */
export function formatOutput(value: unknown, format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(value);
  if (typeof value === 'string') {
    // Strip a trailing newline so the bin caller's single appended newline
    // doesn't produce a double-blank tail line. Most pretty renderers end
    // with `\n` by convention; this keeps the on-screen output tight.
    return value.endsWith('\n') ? value.slice(0, -1) : value;
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Format a CLIError for stderr (LEV-168). Pretty mode emits a short
 * `error: <message>` line plus an optional `hint: <text>` line — matches
 * the LEV-117 help-command style with no ANSI colors (we don't have a
 * color library wired up yet). `json` mode preserves the prior structured
 * payload so machine consumers that pass `--json` get the same shape they
 * used to get by default.
 *
 * Accepts either a real {@link CLIError} or a structurally compatible
 * object (see `isCLIErrorLike` in `cli.ts`) so plugins that throw a
 * CLIError from their own copy of the class — dynamic imports cross the
 * module boundary — still serialize correctly.
 */
export function formatError(err: CLIError, format: OutputFormat): string {
  if (format === 'json') {
    if (typeof (err as { toJSON?: () => unknown }).toJSON === 'function') {
      return JSON.stringify((err as unknown as { toJSON: () => unknown }).toJSON());
    }
    // Fallback shape mirrors CLIError.toJSON() for cross-boundary throws.
    const code = (err as unknown as { code?: string }).code ?? 'INTERNAL';
    const details = (err as unknown as { details?: unknown }).details;
    return JSON.stringify({
      code,
      message: err.message,
      hint: err.hint ?? null,
      ...(details !== undefined ? { details } : {}),
    });
  }
  const lines: string[] = [];
  lines.push(`error: ${err.message}`);
  if (err.hint) lines.push(`hint: ${err.hint}`);
  return lines.join('\n');
}
