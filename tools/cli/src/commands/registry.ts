import type { Command } from './types';

export class CommandRegistry {
  private readonly map = new Map<string, Command>();

  register(cmd: Command): void {
    this.map.set(cmd.name, cmd);
  }

  lookup(name: string): Command | undefined {
    return this.map.get(name);
  }

  /** Resolve a name from a positional argv prefix, longest-match first. */
  resolve(argv: string[]): { command: Command; rest: string[] } | undefined {
    for (let n = argv.length; n >= 1; n--) {
      const candidate = argv.slice(0, n).join('.');
      const cmd = this.map.get(candidate);
      if (cmd) return { command: cmd, rest: argv.slice(n) };
    }
    return undefined;
  }

  all(): Command[] {
    return [...this.map.values()];
  }
}
