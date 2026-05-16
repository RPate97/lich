import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLIError } from '../errors';
import type { Command } from './types';

const STUB = `export default {
  // The CLI foundation only requires a default-exported object.
  // Adapter selections, services, and other config land in later plans.
};
`;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const initCommand: Command = {
  name: 'init',
  describe: 'Scaffold a levelzero.config.ts in the current directory',
  async run(ctx) {
    const path = join(ctx.cwd, 'levelzero.config.ts');
    if ((await exists(path)) && !ctx.flags['force']) {
      throw new CLIError(
        'CONFIG_INVALID',
        `levelzero.config.ts already exists at ${path}`,
        'pass --force to overwrite',
      );
    }
    await writeFile(path, STUB, 'utf8');
    return { created: true, configPath: path };
  },
};
