import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveStackContext, currentBranch } from '../../src/services/context';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-ctx-')));
});

describe('resolveStackContext', () => {
  it('throws when no levelzero.config.ts is found', async () => {
    await expect(resolveStackContext(tmp)).rejects.toThrow(/not inside a levelzero project/i);
  });

  it('returns key, path, and branch for a worktree (empty branch if not a git repo)', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const ctx = await resolveStackContext(tmp);
    expect(ctx.worktreePath).toBe(tmp);
    expect(ctx.worktreeKey).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof ctx.branch).toBe('string');
  });

  it('reads branch from git when the worktree is a git repo on a named branch', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    spawnSync('git', ['init', '-q', '-b', 'mybranch'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    spawnSync('git', ['add', '.'], { cwd: tmp });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmp });
    const ctx = await resolveStackContext(tmp);
    expect(ctx.branch).toBe('mybranch');
  });
});

describe('currentBranch', () => {
  it('returns "" when path is not a git repo', async () => {
    expect(await currentBranch(tmp)).toBe('');
  });
});
