import type { OutputFormat } from '../output';
import type { ProgressReporter } from '../ui/progress';

export interface CommandContext {
  cwd: string;
  format: OutputFormat;
  args: string[];
  flags: Record<string, string | boolean>;
  /**
   * Per-invocation progress reporter (LEV-217). Optional so existing test
   * sites that hand-roll a `CommandContext` keep compiling and commands
   * fall back to a silent no-op when none is supplied. Production
   * dispatch in `runCli` always wires one in via {@link detectProgressMode}
   * — `silent` for `--json`, `plain` for non-TTY/CI/NO_COLOR, `tty`
   * interactive otherwise. Output goes to stderr by default so it never
   * collides with stdout JSON or `runCli`-style consumers that parse the
   * command's structured result.
   */
  reporter?: ProgressReporter;
}

export interface Command {
  /** Dot-separated name, e.g. "stacks.current". */
  name: string;
  describe: string;
  run(ctx: CommandContext): Promise<unknown>;
}
