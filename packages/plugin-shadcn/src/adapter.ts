import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  UIAdapter,
  UIContext,
  AddComponentOptions,
  AddComponentResult,
  ListComponentsResult,
} from '@lich/core';

async function shellExec(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, { shell: true, cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

export const shadcnAdapter: UIAdapter = {
  name: 'shadcn',

  async add(ctx: UIContext, component: string, opts: AddComponentOptions = {}): Promise<AddComponentResult> {
    if (!ctx.appDir) throw new Error(`shadcn add requires appDir; got ${JSON.stringify(ctx.appDir)}`);
    const cwd = join(ctx.projectRoot, ctx.appDir);
    const command = `npx -y shadcn@latest add ${component} --yes`;
    if (opts.dryRun) {
      return { command, cwd, executed: false, output: '' };
    }
    const r = await shellExec(command, cwd);
    if (r.exitCode !== 0) {
      throw new Error(`shadcn add failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return { command, cwd, executed: true, output: r.stdout + r.stderr };
  },

  async list(ctx: UIContext): Promise<ListComponentsResult> {
    const componentsJsonPath = join(ctx.projectRoot, ctx.appDir, 'components.json');
    try {
      const raw = await readFile(componentsJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { aliases?: { components?: string } };
      const componentsAlias = parsed.aliases?.components ?? '@/components/ui';
      const componentsDir = join(ctx.projectRoot, ctx.appDir, componentsAlias.replace(/^@\//, 'src/'));
      try {
        const files = await readdir(componentsDir);
        return { installed: files.filter((f) => f.endsWith('.tsx')).map((f) => f.replace(/\.tsx$/, '')) };
      } catch {
        return { installed: [] };
      }
    } catch {
      return { installed: [] };
    }
  },
};
