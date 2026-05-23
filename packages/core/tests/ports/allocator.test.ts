import { describe, it, expect } from 'vitest';
import { allocatePorts, PORT_RANGE_START, PORT_RANGE_END } from '../../src/ports/allocator';

describe('allocatePorts', () => {
  it('returns a PortMap with the requested names', async () => {
    const map = await allocatePorts(['postgres', 'api', 'web'], { isFree: async () => true });
    expect(Object.keys(map).sort()).toEqual(['api', 'postgres', 'web']);
  });

  it('assigns ports inside the lich range', async () => {
    const map = await allocatePorts(['postgres'], { isFree: async () => true });
    expect(map.postgres).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(map.postgres).toBeLessThanOrEqual(PORT_RANGE_END);
  });

  it('skips ports the probe reports as taken', async () => {
    const taken = new Set([PORT_RANGE_START, PORT_RANGE_START + 1]);
    const map = await allocatePorts(['postgres'], {
      isFree: async (p) => !taken.has(p),
    });
    expect(map.postgres).toBeGreaterThanOrEqual(PORT_RANGE_START + 2);
  });

  it('honors a "reservedPorts" exclusion set (ports already in another stack)', async () => {
    const map = await allocatePorts(['p'], {
      isFree: async () => true,
      reservedPorts: new Set([PORT_RANGE_START, PORT_RANGE_START + 1]),
    });
    expect(map.p).toBeGreaterThanOrEqual(PORT_RANGE_START + 2);
  });

  it('throws when no free ports remain', async () => {
    await expect(
      allocatePorts(['p'], { isFree: async () => false }),
    ).rejects.toThrow(/no free ports/i);
  });
});
