import { spawnSync } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

  // After LEV-174 core no longer imports `@lich/template-v0-stack`
  // directly — that cross-package dep was the last reason core had a
  // hard-coded knowledge of any template. Project scaffolding now goes
  // through `bunx create-stack-v0 <name>`, which owns the template root and
  // delegates to `lich init <name> --template-dir <root>` under the
  // hood. Running `lich init <name>` standalone (without a template
  // override) surfaces a clear error pointing users at the right entry
  // point.
  const templateDirFlag = ctx.flags['template-dir'];
  if (typeof templateDirFlag !== 'string') {
    throw new CLIError(
      'CONFIG_INVALID',
      `cannot scaffold "${name}": no --template-dir supplied`,
      'run `bunx create-stack-v0 ' +
        name +
        '` to scaffold the v0 stack, or pass --template-dir <path>',
    );
  }
  const templateDir = resolve(ctx.cwd, templateDirFlag);

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
  const result = {
    created: true as const,
    projectName: name,
    targetDir,
    files,
    installed,
    nextSteps,
  };
  if (ctx.format === 'json') return result;
  return (
    `\nScaffolded ${name} at ${targetDir}\n\nNext steps:\n` +
    nextSteps.map((l) => `  ${l}`).join('\n') +
    '\n'
  );
}

export const initCommand: Command = {
  name: 'init',
  describe: 'Scaffold a lich.config.ts (or a full v0 project when given a name)',
  async run(ctx) {
    const name = ctx.args[0];
    if (name !== undefined && name !== '') {
      return initWithName(ctx, name);
    }

    const path = join(ctx.cwd, 'lich.config.ts');
    if ((await exists(path)) && !ctx.flags['force']) {
      throw new CLIError(
        'CONFIG_INVALID',
        `lich.config.ts already exists at ${path}`,
        'pass --force to overwrite',
      );
    }
    await writeFile(path, STUB, 'utf8');
    const result = { created: true as const, configPath: path };
    if (ctx.format === 'json') return result;
    return `Wrote lich.config.ts at ${path}\n`;
  },
};
