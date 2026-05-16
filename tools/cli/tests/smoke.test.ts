import { describe, it, expect } from 'vitest';

describe('package skeleton', () => {
  it('exports a placeholder version constant', async () => {
    const mod = await import('../src/bin');
    expect(mod.VERSION).toBe('0.0.0');
  });
});
