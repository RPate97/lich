import { spawn } from 'node:child_process';
import { findWorktree } from '../worktree';
import { CLIError } from '../errors';
import type { StackContext } from './types';

export async function currentBranch(path: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const proc = spawn('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on('error', () => resolve(''));
    proc.on('close', (code) => {
      if (code !== 0) return resolve('');
      const b = stdout.trim();
      resolve(b === 'HEAD' ? '' : b);
    });
  });
}

export async function resolveStackContext(cwd: string): Promise<StackContext> {
  const wt = await findWorktree(cwd);
  if (!wt) {
    throw new CLIError(
      'NO_PROJECT',
      'not inside a lich project',
      'run `lich init` or cd into a directory with lich.config.ts',
    );
  }
  const branch = await currentBranch(wt.path);
  return { worktreeKey: wt.key, worktreePath: wt.path, branch };
}
