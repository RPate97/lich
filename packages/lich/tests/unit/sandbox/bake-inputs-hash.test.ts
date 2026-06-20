import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBakeInputsHash } from '../../../src/sandbox/inputs-hash.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lich-bih-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function setup() {
  mkdirSync(join(root, 'migrations'), { recursive: true });
  writeFileSync(join(root, 'migrations', '001.sql'), 'create table a;');
  writeFileSync(join(root, 'lich.yaml'), 'version: "1"\n');
}

const opts = () => ({
  worktreePath: root,
  lichYamlPath: join(root, 'lich.yaml'),
  profileName: 'dev',
  bakeInputs: ['migrations/**'],
});

describe('computeBakeInputsHash', () => {
  test('identical inputs → identical hash (sharing)', async () => {
    setup();
    expect(await computeBakeInputsHash(opts())).toBe(await computeBakeInputsHash(opts()));
  });

  test('a changed bake input → different hash (divergence)', async () => {
    setup();
    const before = await computeBakeInputsHash(opts());
    writeFileSync(join(root, 'migrations', '002.sql'), 'create table b;');
    expect(await computeBakeInputsHash(opts())).not.toBe(before);
  });

  test('app-code change NOT in bake_inputs → same hash', async () => {
    setup();
    const before = await computeBakeInputsHash(opts());
    writeFileSync(join(root, 'app.ts'), 'console.log(1)');
    expect(await computeBakeInputsHash(opts())).toBe(before);
  });

  test('different profile → different hash', async () => {
    setup();
    const a = await computeBakeInputsHash(opts());
    const b = await computeBakeInputsHash({ ...opts(), profileName: 'dev:heavy' });
    expect(a).not.toBe(b);
  });
});
