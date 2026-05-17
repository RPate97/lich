import { spawnSync } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIError } from '../errors';
import { copyTemplate } from '../scaffolder';
import type { Command, CommandContext } from './types';

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

/**
 * Resolve the bundled v0 template directory relative to this source file.
 * Tests may override via the `--template-dir` flag.
 */
function defaultTemplateDir(): string {
  // src/commands/init.ts -> ../../templates/v0-stack
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'templates', 'v0-stack');
}

function nextStepsLines(projectName: string, installed: boolean): string[] {
  const lines = [`cd ${projectName}`];
  if (!installed) lines.push('bun install');
  lines.push('bun run dev');
  return lines;
}

async function initWithName(ctx: CommandContext, name: string): Promise<unknown> {
  const targetDir = resolve(ctx.cwd, name);
  if ((await exists(targetDir)) && !ctx.flags['force']) {
    throw new CLIError(
      'CONFIG_INVALID',
      `target directory already exists at ${targetDir}`,
      'pass --force to scaffold into it anyway',
    );
  }

  const templateDirFlag = ctx.flags['template-dir'];
  const templateDir =
    typeof templateDirFlag === 'string' ? resolve(ctx.cwd, templateDirFlag) : defaultTemplateDir();

  const { files } = await copyTemplate({
    from: templateDir,
    to: targetDir,
    vars: { projectName: name },
  });

  let installed = false;
  if (!ctx.flags['skip-install']) {
    const r = spawnSync('bun', ['install'], { cwd: targetDir, stdio: 'inherit' });
    if (r.error || (typeof r.status === 'number' && r.status !== 0)) {
      throw new CLIError(
        'INTERNAL',
        `bun install failed in ${targetDir}` +
          (r.error ? `: ${r.error.message}` : r.status != null ? ` (exit ${r.status})` : ''),
        'install bun (https://bun.sh) or rerun with --skip-install',
      );
    }
    installed = true;
  }

  const nextSteps = nextStepsLines(name, installed);
  if (ctx.format === 'pretty') {
    process.stdout.write(
      `\nScaffolded ${name} at ${targetDir}\n\nNext steps:\n` +
        nextSteps.map((l) => `  ${l}`).join('\n') +
        '\n',
    );
  }

  return {
    created: true,
    projectName: name,
    targetDir,
    files,
    installed,
    nextSteps,
  };
}

export const initCommand: Command = {
  name: 'init',
  describe: 'Scaffold a levelzero.config.ts (or a full v0 project when given a name)',
  async run(ctx) {
    const name = ctx.args[0];
    if (name !== undefined && name !== '') {
      return initWithName(ctx, name);
    }

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
