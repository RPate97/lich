import { resolveStackContext, CLIError, type Command, type UIAdapter } from '@lich/core';
import { shadcnAdapter } from '../adapter';

export interface UiAddOptions {
  /**
   * UI adapter override. When omitted, defaults to the shadcn adapter shipped
   * by this plugin. Tests can pass an explicit stub to bypass the default.
   */
  adapter?: UIAdapter;
}

/**
 * Build `lich ui add <component>`. Resolves the worktree, then hands the
 * component name to the UI adapter (shadcn by default). The `--dry-run` flag
 * is forwarded so callers can inspect the generated command without executing
 * it.
 */
export function makeUiAddCommand(opts?: UiAddOptions): Command {
  const adapter: UIAdapter = opts?.adapter ?? shadcnAdapter;

  return {
    name: 'ui.add',
    describe: 'Add a shadcn component to the project',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const component = ctx.args[0];
      if (!component) {
        throw new CLIError(
          'INTERNAL',
          'ui add requires a component name',
          'usage: lich ui add <name>',
        );
      }
      const dryRun = Boolean(ctx.flags['dry-run']);
      const result = await adapter.add(
        {
          projectRoot: stackCtx.worktreePath,
          appDir: (ctx.flags['app-dir'] as string) || 'apps/web',
        },
        component,
        { dryRun },
      );
      if (ctx.format === 'json') return result;
      const lines: string[] = [];
      const verb = result.executed ? 'Added' : 'Would add';
      lines.push(`${verb} component "${component}"`);
      lines.push(`  command: ${result.command}`);
      lines.push(`  cwd:     ${result.cwd}`);
      if (result.output) lines.push(result.output);
      return lines.join('\n') + '\n';
    },
  };
}

export const uiAddCommand: Command = makeUiAddCommand();
