import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { isPortFree } from '../../src/ports/free-port';

describe('isPortFree', () => {
  it('returns true for a port nothing is bound to', async () => {
    expect(await isPortFree(57321)).toBe(true);
  });

  it('returns false for a port that is currently bound', async () => {
    const server = createServer().listen(0);
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      expect(await isPortFree(addr.port)).toBe(false);
    } finally {
      server.close();
    }
  });
});
