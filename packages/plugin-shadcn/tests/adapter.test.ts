import { describe, it, expect } from 'vitest';
import { shadcnAdapter } from '../src/adapter';
import type { UIAdapter } from '@lich/core';

describe('shadcn UIAdapter', () => {
  it('exposes the UIAdapter interface', () => {
    const a: UIAdapter = shadcnAdapter;
    expect(a.name).toBe('shadcn');
    expect(typeof a.add).toBe('function');
    expect(typeof a.list).toBe('function');
  });

  it('add() returns the constructed command without executing when dryRun=true', async () => {
    const result = await shadcnAdapter.add(
      { projectRoot: '/abs/proj', appDir: 'apps/web' },
      'button',
      { dryRun: true },
    );
    expect(result.command).toContain('shadcn');
    expect(result.command).toContain('button');
    expect(result.cwd).toBe('/abs/proj/apps/web');
    expect(result.executed).toBe(false);
  });

  it('add() throws if appDir is missing', async () => {
    await expect(
      shadcnAdapter.add({ projectRoot: '/abs/proj', appDir: '' }, 'button', { dryRun: true }),
    ).rejects.toThrow(/appDir/i);
  });

  it('list() returns empty array when components.json is missing', async () => {
    const result = await shadcnAdapter.list({ projectRoot: '/tmp/nonexistent-' + Date.now(), appDir: 'apps/web' });
    expect(result.installed).toEqual([]);
  });
});
