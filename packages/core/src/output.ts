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

/** Hard cap on a single rendered blob (e.g. stderr capture) in pretty mode. */
const PRETTY_BLOB_LIMIT = 4 * 1024;

/**
 * Format a CLIError for stderr (LEV-168 / LEV-197). Pretty mode emits a
 * short `error: <message>` line plus, when present, an indented
 * `caused by:` block walking the Node native `Error.cause` chain, a
 * `details:` block with each structured key on its own line, and an
 * optional `hint: <text>` line. JSON mode preserves the structured shape
 * from {@link CLIError.toJSON}.
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
    return JSON.stringify(fallbackJsonShape(err));
  }
  const lines: string[] = [];
  lines.push(`error: ${err.message}`);
  // Walk the cause chain inline. Each link adds a `caused by:` line plus
  // any nested cause indented further. Limit depth defensively (the
  // serializer caps at 8; the pretty renderer caps at 4 to keep terminal
  // output scannable).
  const causeLines = renderCauseChainPretty((err as { cause?: unknown }).cause, '  ');
  if (causeLines.length > 0) lines.push(...causeLines);
  // Structured details — print one key per line. Multi-line string values
  // get indented under their key so e.g. captured `stderr` reads as a
  // proper block.
  const details = (err as { details?: Record<string, unknown> }).details;
  if (details && Object.keys(details).length > 0) {
    const rendered = renderDetailsPretty(details, '  ');
    if (rendered.length > 0) {
      lines.push('details:');
      lines.push(...rendered);
    }
  }
  if (err.hint) lines.push(`hint: ${err.hint}`);
  return lines.join('\n');
}

function fallbackJsonShape(err: CLIError): Record<string, unknown> {
  const code = (err as unknown as { code?: string }).code ?? 'INTERNAL';
  const details = (err as unknown as { details?: unknown }).details;
  const out: Record<string, unknown> = {
    code,
    message: err.message,
    hint: err.hint ?? null,
  };
  if (details !== undefined) out.details = details;
  const cause = (err as unknown as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) {
    out.cause = serializeFallbackCause(cause);
  }
  return out;
}

function serializeFallbackCause(cause: unknown, depth = 0): unknown {
  if (depth > 4 || cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) {
    const nested = (cause as { cause?: unknown }).cause;
    const out: Record<string, unknown> = {
      name: cause.name || 'Error',
      message: cause.message,
    };
    if (cause.stack) out.stack = cause.stack;
    if (nested !== undefined && nested !== null) {
      const sub = serializeFallbackCause(nested, depth + 1);
      if (sub !== undefined) out.cause = sub;
    }
    return out;
  }
  return { name: 'Error', message: String(cause) };
}

/**
 * Render the cause chain as a sequence of indented lines.
 *
 *   caused by: Error: Could not resolve @prisma/client
 *     caused by: Error: ENOENT...
 *
 * Each link uses the parent indent + 2 spaces. We stop after a small depth
 * to keep terminal output scannable; the JSON path preserves the full
 * chain via `serializeCauseChain` (deeper limit) for tooling that needs it.
 */
function renderCauseChainPretty(cause: unknown, indent: string, depth = 0): string[] {
  if (depth > 4 || cause === undefined || cause === null) return [];
  const lines: string[] = [];
  const { name, message, nested } = describeCauseLink(cause);
  const head = name === 'Error' ? `Error: ${message}` : `${name}: ${message}`;
  lines.push(...indentMultiline(`caused by: ${head}`, indent));
  if (nested !== undefined && nested !== null) {
    lines.push(...renderCauseChainPretty(nested, indent + '  ', depth + 1));
  }
  return lines;
}

function describeCauseLink(cause: unknown): {
  name: string;
  message: string;
  nested?: unknown;
} {
  if (cause instanceof Error) {
    return {
      name: cause.name || 'Error',
      message: cause.message,
      nested: (cause as { cause?: unknown }).cause,
    };
  }
  return { name: 'Error', message: typeof cause === 'string' ? cause : String(cause) };
}

/**
 * Render the `details` map as `key: value` lines. String values that span
 * multiple lines (e.g. a captured stderr blob) are emitted as a folded
 * block:
 *
 *   stderr: |
 *     line one
 *     line two
 *
 * Other types fall through to a single-line JSON stringification so the
 * output stays compact and unambiguous.
 */
function renderDetailsPretty(details: Record<string, unknown>, indent: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const truncated = truncateBlob(v);
      if (truncated.includes('\n')) {
        out.push(`${indent}${k}: |`);
        for (const line of truncated.split('\n')) {
          out.push(`${indent}  ${line}`);
        }
      } else if (truncated.length === 0) {
        // Skip empty strings — they add noise without information.
        continue;
      } else {
        out.push(`${indent}${k}: ${truncated}`);
      }
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out.push(`${indent}${k}: ${String(v)}`);
    } else if (Array.isArray(v)) {
      // Per-generator results (etc.) — print one item per line with status
      // + id + message inline so the failing generator's underlying error
      // is impossible to miss.
      const arrLines = renderArrayPretty(v, indent + '  ');
      if (arrLines.length === 0) continue;
      out.push(`${indent}${k}:`);
      out.push(...arrLines);
    } else {
      // Compact JSON for anything else.
      out.push(`${indent}${k}: ${safeStringify(v)}`);
    }
  }
  return out;
}

function renderArrayPretty(arr: unknown[], indent: string): string[] {
  const out: string[] = [];
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      // Generator-result-shaped: { id, status, message } — render inline
      // so a per-generator failure reads as `- prisma [fail]: <reason>`.
      if (
        typeof obj['id'] === 'string' &&
        typeof obj['status'] === 'string'
      ) {
        const status = obj['status'] as string;
        const msg = obj['message'];
        let line = `${indent}- ${String(obj['id'])} [${status}]`;
        if (typeof msg === 'string' && msg.length > 0) {
          const truncated = truncateBlob(msg);
          if (truncated.includes('\n')) {
            line += ':';
            out.push(line);
            for (const m of truncated.split('\n')) {
              out.push(`${indent}    ${m}`);
            }
            continue;
          }
          line += `: ${truncated}`;
        }
        out.push(line);
        continue;
      }
    }
    out.push(`${indent}- ${safeStringify(item)}`);
  }
  return out;
}

function indentMultiline(s: string, indent: string): string[] {
  const parts = s.split('\n');
  return parts.map((p, i) => (i === 0 ? `${indent}${p}` : `${indent}  ${p}`));
}

function truncateBlob(s: string): string {
  if (s.length <= PRETTY_BLOB_LIMIT) return s.trimEnd();
  return `${s.slice(0, PRETTY_BLOB_LIMIT).trimEnd()}\n... [truncated, ${s.length - PRETTY_BLOB_LIMIT} bytes omitted]`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
