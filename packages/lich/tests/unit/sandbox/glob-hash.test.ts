import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashGlobs } from '../../../src/sandbox/glob-hash.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lich-glob-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

describe('hashGlobs', () => {
  test('is deterministic for the same files', async () => {
    write('migrations/001.sql', 'create table a;');
    write('migrations/002.sql', 'create table b;');
    const h1 = await hashGlobs(root, ['migrations/**']);
    const h2 = await hashGlobs(root, ['migrations/**']);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changes when a matched file content changes', async () => {
    write('migrations/001.sql', 'create table a;');
    const before = await hashGlobs(root, ['migrations/**']);
    write('migrations/001.sql', 'create table a; -- edited');
    const after = await hashGlobs(root, ['migrations/**']);
    expect(after).not.toBe(before);
  });

  test('changes when a new matched file is added', async () => {
    write('migrations/001.sql', 'x');
    const before = await hashGlobs(root, ['migrations/**']);
    write('migrations/002.sql', 'y');
    const after = await hashGlobs(root, ['migrations/**']);
    expect(after).not.toBe(before);
  });

  test('is independent of filesystem enumeration order (sorted)', async () => {
    write('b.sql', '1'); write('a.sql', '2'); write('c.sql', '3');
    const h1 = await hashGlobs(root, ['*.sql']);
    rmSync(join(root, 'a.sql')); writeFileSync(join(root, 'a.sql'), '2');
    const h2 = await hashGlobs(root, ['*.sql']);
    expect(h1).toBe(h2);
  });

  test('ignores files not matched by any glob', async () => {
    write('migrations/001.sql', 'x');
    const before = await hashGlobs(root, ['migrations/**']);
    write('README.md', 'unrelated');
    const after = await hashGlobs(root, ['migrations/**']);
    expect(after).toBe(before);
  });

  test('a glob matching zero files contributes a stable empty marker', async () => {
    const h = await hashGlobs(root, ['does-not-exist/**']);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
