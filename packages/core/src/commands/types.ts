import type { OutputFormat } from '../output';

export interface CommandContext {
  cwd: string;
  format: OutputFormat;
  args: string[];
  flags: Record<string, string | boolean>;
}

export interface Command {
  /** Dot-separated name, e.g. "stacks.current". */
  name: string;
  describe: string;
  run(ctx: CommandContext): Promise<unknown>;
}
