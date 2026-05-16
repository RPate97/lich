import { describe, it, expect } from 'vitest';
import { getBuiltinServices } from '../../src/services/builtins';

describe('getBuiltinServices', () => {
  it('includes postgres as a DockerService', () => {
    const list = getBuiltinServices();
    const pg = list.find((s) => s.name === 'postgres');
    expect(pg).toBeDefined();
    expect(pg!.kind).toBe('docker');
  });
});
