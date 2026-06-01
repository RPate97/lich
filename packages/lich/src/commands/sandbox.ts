import type { CommandHandler } from './index.js';
import { sandboxStatus } from './sandbox/status.js';
import { sandboxPurge } from './sandbox/purge.js';
import { sandboxRefresh } from './sandbox/refresh.js';
import { sandboxSnapshot } from './sandbox/snapshot.js';

const SUBCOMMANDS: Record<string, CommandHandler> = {
  status: sandboxStatus,
  purge: sandboxPurge,
  refresh: sandboxRefresh,
  snapshot: sandboxSnapshot,
};

export const sandboxCommand: CommandHandler = async (ctx) => {
  const sub = ctx.argv._[0];
  if (!sub) {
    return {
      ok: false,
      message: `usage: lich sandbox <${Object.keys(SUBCOMMANDS).join('|')}>`,
      exitCode: 2,
    };
  }
  const handler = SUBCOMMANDS[sub];
  if (!handler) {
    return {
      ok: false,
      message: `unknown subcommand 'sandbox ${sub}'. Available: ${Object.keys(SUBCOMMANDS).join(', ')}`,
      exitCode: 2,
    };
  }
  return handler({ ...ctx, argv: { ...ctx.argv, _: ctx.argv._.slice(1) } });
};
