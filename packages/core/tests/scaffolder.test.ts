import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { copyTemplate } from '../src/scaffolder';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-scaffold-')));
});

async function writeFixture(root: string): Promise<void> {
  await mkdir(join(root, 'apps', 'api', 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'foo'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, '.turbo'), { recursive: true });

  await writeFile(
    join(root, 'package.json'),
    '{\n  "name": "{{projectName}}",\n  "version": "0.0.0"\n}\n'
  );
  await writeFile(join(root, 'README.md'), '# {{projectName}}\n\nHello {{projectName}}!\n');
  await writeFile(
    join(root, 'apps', 'api', 'package.json'),
    '{\n  "name": "{{projectName}}-api"\n}\n'
  );
  await writeFile(
    join(root, 'apps', 'api', 'src', 'index.ts'),
    "export const name = '{{projectName}}';\n"
  );
  // Files that should be filtered out by directory skip rules.
  await writeFile(join(root, 'node_modules', 'foo', 'index.js'), '// should be skipped');
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(root, 'dist', 'bundle.js'), '// should be skipped');
  await writeFile(join(root, '.turbo', 'log'), 'should be skipped');
}

describe('copyTemplate', () => {
  it('copies every non-skipped file to the destination', async () => {
    const from = join(tmp, 'template');
    const to = join(tmp, 'project');
    await writeFixture(from);

    const result = await copyTemplate({ from, to, vars: { projectName: 'demo' } });

    const expected = [
      'README.md',
      'apps/api/package.json',
      'apps/api/src/index.ts',
      'package.json',
    ];
    expect(result.files.slice().sort()).toEqual(expected.slice().sort());

    // Every reported file exists on disk under `to`.
    for (const rel of result.files) {
      const st = await stat(join(to, rel));
      expect(st.isFile()).toBe(true);
    }
  });

  it('substitutes {{projectName}} placeholders in file contents', async () => {
    const from = join(tmp, 'template');
    const to = join(tmp, 'project');
    await writeFixture(from);

    await copyTemplate({ from, to, vars: { projectName: 'demo' } });

    const pkg = await readFile(join(to, 'package.json'), 'utf8');
    expect(pkg).toContain('"name": "demo"');
    expect(pkg).not.toContain('{{projectName}}');

    const readme = await readFile(join(to, 'README.md'), 'utf8');
    expect(readme).toBe('# demo\n\nHello demo!\n');

    const apiPkg = await readFile(join(to, 'apps', 'api', 'package.json'), 'utf8');
    expect(apiPkg).toContain('"name": "demo-api"');

    const apiIndex = await readFile(join(to, 'apps', 'api', 'src', 'index.ts'), 'utf8');
    expect(apiIndex).toBe("export const name = 'demo';\n");
  });

  it('skips node_modules/, .git/, dist/, and .turbo/ directories', async () => {
    const from = join(tmp, 'template');
    const to = join(tmp, 'project');
    await writeFixture(from);

    const result = await copyTemplate({ from, to, vars: { projectName: 'demo' } });

    for (const rel of result.files) {
      // Normalize path separators so the assertion works on any platform.
      const segs = rel.split(/[\\/]/);
      expect(segs).not.toContain('node_modules');
      expect(segs).not.toContain('.git');
      expect(segs).not.toContain('dist');
      expect(segs).not.toContain('.turbo');
    }

    // Doubly check the directories were not even materialized at `to`.
    await expect(stat(join(to, 'node_modules'))).rejects.toThrow();
    await expect(stat(join(to, '.git'))).rejects.toThrow();
    await expect(stat(join(to, 'dist'))).rejects.toThrow();
    await expect(stat(join(to, '.turbo'))).rejects.toThrow();
  });

  it('supports multiple substitution vars', async () => {
    const from = join(tmp, 'template');
    const to = join(tmp, 'project');
    await mkdir(from, { recursive: true });
    await writeFile(
      join(from, 'config.txt'),
      'project={{projectName}}\nversion={{projectVersion}}\n'
    );

    await copyTemplate({
      from,
      to,
      vars: { projectName: 'demo', projectVersion: '1.2.3' },
    });

    const contents = await readFile(join(to, 'config.txt'), 'utf8');
    expect(contents).toBe('project=demo\nversion=1.2.3\n');
  });

  it('returns paths with forward-slash separators for stability', async () => {
    const from = join(tmp, 'template');
    const to = join(tmp, 'project');
    await mkdir(join(from, 'a', 'b'), { recursive: true });
    await writeFile(join(from, 'a', 'b', 'c.txt'), 'hello');

    const result = await copyTemplate({ from, to, vars: {} });
    expect(result.files).toEqual(['a/b/c.txt']);
  });

  it('creates the destination directory if it does not exist', async () => {
    const from = join(tmp, 'template');
    const to = join(tmp, 'nested', 'deeper', 'project');
    await mkdir(from, { recursive: true });
    await writeFile(join(from, 'hello.txt'), 'hi {{projectName}}\n');

    const result = await copyTemplate({ from, to, vars: { projectName: 'demo' } });

    expect(result.files).toEqual(['hello.txt']);
    const out = await readFile(join(to, 'hello.txt'), 'utf8');
    expect(out).toBe('hi demo\n');
  });
});
