import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWorktree, computeWorktreeKey } from '../src/worktree';

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-wt-')));
});

describe('findWorktree', () => {
  it('returns null when no levelzero.config.ts is found above cwd', async () => {
    const result = await findWorktree(tmp);
    expect(result).toBeNull();
  });

  it('finds the config when it is directly in cwd', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const result = await findWorktree(tmp);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(tmp);
    expect(result!.configPath).toBe(join(tmp, 'levelzero.config.ts'));
  });

  it('walks up the directory tree to find the config', async () => {
    writeFileSync(join(tmp, 'levelzero.config.ts'), 'export default {};');
    const nested = join(tmp, 'apps', 'web', 'src');
    mkdirSync(nested, { recursive: true });
    const result = await findWorktree(nested);
    expect(result!.path).toBe(tmp);
  });
});

describe('computeWorktreeKey', () => {
  it('produces a 12-char hex key from a path', () => {
    const key = computeWorktreeKey('/Users/x/projects/foo');
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });

  it('produces the same key for the same path twice', () => {
    expect(computeWorktreeKey('/a/b/c')).toBe(computeWorktreeKey('/a/b/c'));
  });

  it('produces different keys for different paths', () => {
    expect(computeWorktreeKey('/a/b/c')).not.toBe(computeWorktreeKey('/a/b/d'));
  });
});
