import { describe, test, expect } from 'vitest';
import { computeInputsHashFromString } from '../../../src/sandbox/inputs-hash.js';

describe('inputs hash', () => {
  test('same input produces same hash', () => {
    const h1 = computeInputsHashFromString('version: "1"\n', 'dev');
    const h2 = computeInputsHashFromString('version: "1"\n', 'dev');
    expect(h1).toBe(h2);
  });

  test('different lich.yaml content produces different hash', () => {
    const h1 = computeInputsHashFromString('version: "1"\n', 'dev');
    const h2 = computeInputsHashFromString('version: "1"\nx: y\n', 'dev');
    expect(h1).not.toBe(h2);
  });

  test('different profile name produces different hash', () => {
    const h1 = computeInputsHashFromString('version: "1"\n', 'dev');
    const h2 = computeInputsHashFromString('version: "1"\n', 'dev:heavy');
    expect(h1).not.toBe(h2);
  });

  test('hash is 64 hex chars (SHA256)', () => {
    expect(computeInputsHashFromString('x', 'y')).toMatch(/^[0-9a-f]{64}$/);
  });
});
