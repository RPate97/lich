import { describe, it, expect } from 'vitest';
import {
  containerName,
  networkName,
  volumeName,
  composeProjectName,
  LEVELZERO_PREFIX,
} from '../../src/compose/naming';

const KEY = 'a3f8c1234567';

describe('compose naming', () => {
  it('LEVELZERO_PREFIX is "levelzero-"', () => {
    expect(LEVELZERO_PREFIX).toBe('levelzero-');
  });

  it('containerName produces "levelzero-<key>-<service>"', () => {
    expect(containerName(KEY, 'postgres')).toBe(`levelzero-${KEY}-postgres`);
  });

  it('networkName produces "levelzero-<key>"', () => {
    expect(networkName(KEY)).toBe(`levelzero-${KEY}`);
  });

  it('volumeName produces "levelzero-<key>-<service>-data"', () => {
    expect(volumeName(KEY, 'postgres')).toBe(`levelzero-${KEY}-postgres-data`);
  });

  it('composeProjectName matches networkName', () => {
    expect(composeProjectName(KEY)).toBe(networkName(KEY));
  });

  it('rejects keys outside the expected 12-hex shape', () => {
    expect(() => containerName('bad-key', 'postgres')).toThrow(/worktree key/i);
    expect(() => networkName('')).toThrow(/worktree key/i);
    expect(() => volumeName('ZZZ', 'postgres')).toThrow(/worktree key/i);
  });

  it('rejects service names outside [a-z0-9-]', () => {
    expect(() => containerName(KEY, 'BAD NAME')).toThrow(/service name/i);
    expect(() => volumeName(KEY, 'with_underscore')).toThrow(/service name/i);
  });
});
