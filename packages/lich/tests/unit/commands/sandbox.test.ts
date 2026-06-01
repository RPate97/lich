import { describe, it, expect } from 'vitest';
import { sandboxCommand } from '../../../src/commands/sandbox.js';

describe('lich sandbox dispatcher', () => {
  it('lists snapshot in the no-subcommand usage error', async () => {
    const result = await sandboxCommand({ argv: { _: [] } });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('snapshot');
  });

  it('reports snapshot as a known subcommand on unknown input', async () => {
    const result = await sandboxCommand({ argv: { _: ['ghost'] } });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('snapshot');
  });
});
