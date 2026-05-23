import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  containerName,
  networkName,
  volumeName,
  composeProjectName,
  activeNamingPrefix,
  LICH_PREFIX,
  TEST_RUN_PREFIX,
} from '../../src/compose/naming';

const KEY = 'a3f8c1234567';

// LEV-202 — these production-default tests run with TEST_RUN_ID cleared so
// the assertions match the historical name shape. The dedicated
// "TEST_RUN_ID prefix" describe below covers the prefix flow.
describe('compose naming', () => {
  let PREV: string | undefined;
  beforeEach(() => {
    PREV = process.env.TEST_RUN_ID;
    delete process.env.TEST_RUN_ID;
  });
  afterEach(() => {
    if (PREV === undefined) delete process.env.TEST_RUN_ID;
    else process.env.TEST_RUN_ID = PREV;
  });

  it('LICH_PREFIX is "lich-"', () => {
    expect(LICH_PREFIX).toBe('lich-');
  });

  it('containerName produces "lich-<key>-<service>"', () => {
    expect(containerName(KEY, 'postgres')).toBe(`lich-${KEY}-postgres`);
  });

  it('networkName produces "lich-<key>"', () => {
    expect(networkName(KEY)).toBe(`lich-${KEY}`);
  });

  it('volumeName produces "lich-<key>-<service>-data"', () => {
    expect(volumeName(KEY, 'postgres')).toBe(`lich-${KEY}-postgres-data`);
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

/**
 * LEV-202 — TEST_RUN_ID prefix flow. Vitest's globalSetup stamps this
 * env var once per process so test-owned compose stacks are namespaced
 * away from real user stacks AND from sibling test processes (parallel
 * agents). Production code paths (TEST_RUN_ID unset) must emit the
 * historical names verbatim.
 */
describe('compose naming — TEST_RUN_ID prefix (LEV-202)', () => {
  const PREV = process.env.TEST_RUN_ID;
  afterEach(() => {
    if (PREV === undefined) delete process.env.TEST_RUN_ID;
    else process.env.TEST_RUN_ID = PREV;
  });

  it('without TEST_RUN_ID, names are unchanged (production path)', () => {
    delete process.env.TEST_RUN_ID;
    expect(networkName(KEY)).toBe(`lich-${KEY}`);
    expect(containerName(KEY, 'postgres')).toBe(`lich-${KEY}-postgres`);
    expect(volumeName(KEY, 'postgres')).toBe(`lich-${KEY}-postgres-data`);
    expect(composeProjectName(KEY)).toBe(`lich-${KEY}`);
    expect(activeNamingPrefix()).toBe(LICH_PREFIX);
  });

  it('with TEST_RUN_ID set, every name carries the test-<id>- infix', () => {
    process.env.TEST_RUN_ID = 'abc123';
    expect(networkName(KEY)).toBe(`lich-${TEST_RUN_PREFIX}abc123-${KEY}`);
    expect(containerName(KEY, 'postgres')).toBe(
      `lich-${TEST_RUN_PREFIX}abc123-${KEY}-postgres`,
    );
    expect(volumeName(KEY, 'postgres')).toBe(
      `lich-${TEST_RUN_PREFIX}abc123-${KEY}-postgres-data`,
    );
    expect(composeProjectName(KEY)).toBe(
      `lich-${TEST_RUN_PREFIX}abc123-${KEY}`,
    );
    expect(activeNamingPrefix()).toBe(`lich-${TEST_RUN_PREFIX}abc123-`);
  });

  it('names still start with LICH_PREFIX so global sweepers catch them', () => {
    process.env.TEST_RUN_ID = 'xyz9';
    expect(networkName(KEY).startsWith(LICH_PREFIX)).toBe(true);
    expect(containerName(KEY, 'pg').startsWith(LICH_PREFIX)).toBe(true);
    expect(volumeName(KEY, 'pg').startsWith(LICH_PREFIX)).toBe(true);
  });

  it('rejects a malformed TEST_RUN_ID', () => {
    process.env.TEST_RUN_ID = 'BAD ID!';
    expect(() => networkName(KEY)).toThrow(/TEST_RUN_ID/);
    expect(() => containerName(KEY, 'pg')).toThrow(/TEST_RUN_ID/);
  });

  it('treats empty TEST_RUN_ID as unset (no prefix added)', () => {
    process.env.TEST_RUN_ID = '';
    expect(networkName(KEY)).toBe(`lich-${KEY}`);
  });
});
