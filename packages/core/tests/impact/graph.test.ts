import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reverseDeps } from '../../src/impact/graph';

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-impact-')));
  // tsconfig.json
  writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true },
    include: ['src/**/*'],
  }));
  mkdirSync(join(tmp, 'src'), { recursive: true });
  // src/a.ts (target)
  writeFileSync(join(tmp, 'src', 'a.ts'), 'export const A = 1;\n');
  // src/b.ts (imports a directly)
  writeFileSync(join(tmp, 'src', 'b.ts'), "import { A } from './a';\nexport const B = A + 1;\n");
  // src/c.ts (imports b — transitively depends on a)
  writeFileSync(join(tmp, 'src', 'c.ts'), "import { B } from './b';\nexport const C = B + 1;\n");
  // src/d.ts (unrelated)
  writeFileSync(join(tmp, 'src', 'd.ts'), 'export const D = 99;\n');
});

describe('reverseDeps', () => {
  it('returns direct + transitive dependents by default', async () => {
    const r = await reverseDeps(join(tmp, 'src', 'a.ts'), { projectRoot: tmp });
    expect(r.map((p) => p.replace(tmp, ''))).toEqual(['/src/b.ts', '/src/c.ts']);
  });

  it('transitive: false returns only direct dependents', async () => {
    const r = await reverseDeps(join(tmp, 'src', 'a.ts'), { projectRoot: tmp, transitive: false });
    expect(r.map((p) => p.replace(tmp, ''))).toEqual(['/src/b.ts']);
  });

  it('returns empty array when nothing imports the target', async () => {
    const r = await reverseDeps(join(tmp, 'src', 'd.ts'), { projectRoot: tmp });
    expect(r).toEqual([]);
  });
});
