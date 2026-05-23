import { access } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CLIError } from '../errors';
import { reverseDeps } from '../impact/graph';
import type { Command } from './types';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const impactCommand: Command = {
  name: 'impact',
  describe: 'List files that depend on the given TS/JS file (reverse dependencies)',
  async run(ctx) {
    const rawTarget = ctx.args[0];
    if (!rawTarget) {
      throw new CLIError(
        'CONFIG_INVALID',
        'impact requires a path argument',
        'usage: lich impact <path>',
      );
    }

    const targetAbs = isAbsolute(rawTarget) ? rawTarget : resolve(ctx.cwd, rawTarget);
    if (!(await fileExists(targetAbs))) {
      throw new CLIError(
        'CONFIG_INVALID',
        `path does not exist: ${rawTarget}`,
        'pass a path to a TS/JS file inside the project',
      );
    }

    const tsconfigFlag = ctx.flags['tsconfig'];
    const tsconfigPath = typeof tsconfigFlag === 'string'
      ? (isAbsolute(tsconfigFlag) ? tsconfigFlag : resolve(ctx.cwd, tsconfigFlag))
      : resolve(ctx.cwd, 'tsconfig.json');
    const projectRoot = dirname(tsconfigPath);

    const deps = await reverseDeps(targetAbs, { projectRoot });
    if (ctx.format === 'json') return deps;
    if (deps.length === 0) return 'no reverse dependencies\n';
    return deps.join('\n') + '\n';
  },
};
