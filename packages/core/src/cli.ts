import { CLIError } from './errors';
import { formatError, formatOutput, type OutputFormat } from './output';
import type { CommandRegistry } from './commands/registry';
import {
  createProgressReporter,
  detectProgressMode,
  type ProgressReporter,
} from './ui/progress';

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd: string;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * LEV-168 — default output is pretty text; `--json` opts back into structured
 * JSON. `--pretty` is still accepted as an explicit no-op alias so older
 * invocations (and the inline env-debug shim removed from `bin.ts`) keep
 * working. Both flags set to truthy → `json` wins (explicit opt-in beats the
 * default-name alias).
 */
function pickFormat(flags: Record<string, string | boolean>): OutputFormat {
  if (flags['json']) return 'json';
  return 'pretty';
}

/**
 * Structural duck-type for {@link CLIError}.
 *
 * Plugins loaded via dynamic import live in a separate module instance even
 * when they import `@levelzero/core/errors` from the workspace — `instanceof
 * CLIError` is therefore unreliable across the plugin boundary. Test it as
 * an own-property shape instead so plugin-thrown CLIErrors round-trip
 * through `runCli`'s catch with their `code`/`hint` intact rather than being
 * wrapped as `INTERNAL`.
 */
function isCLIErrorLike(err: unknown): err is CLIError {
  if (err instanceof CLIError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e.name === 'CLIError' &&
    typeof e.code === 'string' &&
    typeof e.message === 'string'
  );
}

export async function runCli(
  argv: string[],
  registry: CommandRegistry,
  opts: RunCliOptions,
): Promise<RunCliResult> {
  const { positional, flags } = parseArgs(argv);
  const format = pickFormat(flags);

  const resolved = registry.resolve(positional);
  if (!resolved) {
    const err = new CLIError(
      'UNKNOWN_COMMAND',
      positional.length === 0 ? 'no command given' : `unknown command: ${positional.join(' ')}`,
      'run with --help to see available commands',
    );
    return { exitCode: 1, stdout: '', stderr: formatError(err, format) };
  }

  // LEV-217 — per-invocation progress reporter. Mode is silent under `--json`
  // (machine consumers must see a clean stderr), plain when stderr isn't a
  // TTY or we're in CI/NO_COLOR, and TTY (spinner) for interactive humans.
  // Always shut down in `finally` so a thrown command can't leave the cursor
  // hidden or the spinner's interval timer running.
  const reporter: ProgressReporter = createProgressReporter({
    mode: detectProgressMode({ format }),
  });

  try {
    const result = await resolved.command.run({
      cwd: opts.cwd,
      format,
      args: resolved.rest,
      flags,
      reporter,
    });
    return { exitCode: 0, stdout: formatOutput(result, format), stderr: '' };
  } catch (err: unknown) {
    if (isCLIErrorLike(err)) {
      return { exitCode: 1, stdout: '', stderr: formatError(err, format) };
    }
    // LEV-197 — non-CLIError throws still flow their original Error through
    // as `cause` so the renderer walks to the real message/stack. Without
    // this, anything thrown from a command (e.g. `adapter.inspectSchema`)
    // would lose its name/stack at the dispatch boundary.
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new CLIError('INTERNAL', message, { cause: err });
    return { exitCode: 1, stdout: '', stderr: formatError(wrapped, format) };
  } finally {
    reporter.shutdown();
  }
}
