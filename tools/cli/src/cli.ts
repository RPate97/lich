import { CLIError } from './errors';
import { formatOutput, type OutputFormat } from './output';
import type { CommandRegistry } from './commands/registry';

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

function pickFormat(flags: Record<string, string | boolean>): OutputFormat {
  if (flags['pretty']) return 'pretty';
  if (flags['json']) return 'json';
  return 'json';
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
    return { exitCode: 1, stdout: '', stderr: formatOutput(err.toJSON(), format) };
  }

  try {
    const result = await resolved.command.run({
      cwd: opts.cwd,
      format,
      args: resolved.rest,
      flags,
    });
    return { exitCode: 0, stdout: formatOutput(result, format), stderr: '' };
  } catch (err: unknown) {
    if (err instanceof CLIError) {
      return { exitCode: 1, stdout: '', stderr: formatOutput(err.toJSON(), format) };
    }
    const wrapped = new CLIError('INTERNAL', err instanceof Error ? err.message : String(err));
    return { exitCode: 1, stdout: '', stderr: formatOutput(wrapped.toJSON(), format) };
  }
}
