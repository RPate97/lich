import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../../src/commands/init';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-init-')));
});

describe('levelzero init (no name)', () => {
  it('creates levelzero.config.ts in cwd if not present', async () => {
    const result = await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    const path = join(tmp, 'levelzero.config.ts');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/export default/);
    expect(result).toMatchObject({ created: true, configPath: path });
  });

  it('refuses to overwrite an existing config without --force', async () => {
    await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    await expect(
      initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/already exists/);
  });

  it('--force overwrites an existing config', async () => {
    await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    const result = await initCommand.run({
      cwd: tmp, format: 'json', args: [], flags: { force: true },
    });
    expect(result).toMatchObject({ created: true });
  });
});

async function writeFakeTemplate(root: string): Promise<void> {
  await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    '{\n  "name": "{{projectName}}",\n  "version": "0.0.0"\n}\n',
  );
  await writeFile(join(root, 'README.md'), '# {{projectName}}\n');
  await writeFile(
    join(root, 'apps', 'web', 'src', 'index.ts'),
    "export const name = '{{projectName}}';\n",
  );
}

describe('levelzero init <name>', () => {
  it('throws CLIError pointing at create-stack-v0 when no --template-dir is supplied (LEV-174)', async () => {
    await expect(
      initCommand.run({
        cwd: tmp,
        format: 'json',
        args: ['my-app'],
        flags: { 'skip-install': true },
      }),
    ).rejects.toThrow(/template-dir|create-stack-v0/);
  });

  it('copies the v0 template into ./<name>/ with projectName substitution', async () => {
    const templateDir = join(tmp, 'template');
    await writeFakeTemplate(templateDir);

    const result = await initCommand.run({
      cwd: tmp,
      format: 'json',
      args: ['my-app'],
      flags: { 'skip-install': true, 'template-dir': templateDir },
    });

    const targetDir = join(tmp, 'my-app');
    expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'README.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'apps', 'web', 'src', 'index.ts'))).toBe(true);

    // Project name substitution applied to file contents.
    const pkg = readFileSync(join(targetDir, 'package.json'), 'utf8');
    expect(pkg).toContain('"name": "my-app"');
    expect(readFileSync(join(targetDir, 'README.md'), 'utf8')).toBe('# my-app\n');
    expect(readFileSync(join(targetDir, 'apps', 'web', 'src', 'index.ts'), 'utf8'))
      .toContain("'my-app'");

    expect(result).toMatchObject({
      created: true,
      projectName: 'my-app',
      targetDir,
      installed: false,
    });
    // Files list returned and includes the copied paths.
    expect((result as { files: string[] }).files).toEqual(
      expect.arrayContaining(['package.json', 'README.md', 'apps/web/src/index.ts']),
    );
    // Next-steps printed in pretty mode — included in result for tests.
    expect((result as { nextSteps: string[] }).nextSteps.length).toBeGreaterThan(0);
  });

  it('--skip-install skips running bun install', async () => {
    const templateDir = join(tmp, 'template');
    await writeFakeTemplate(templateDir);

    const result = await initCommand.run({
      cwd: tmp,
      format: 'json',
      args: ['my-app'],
      flags: { 'skip-install': true, 'template-dir': templateDir },
    });

    expect((result as { installed: boolean }).installed).toBe(false);
  });

  it('refuses when target directory already exists without --force', async () => {
    const templateDir = join(tmp, 'template');
    await writeFakeTemplate(templateDir);
    await mkdir(join(tmp, 'my-app'));

    await expect(
      initCommand.run({
        cwd: tmp,
        format: 'json',
        args: ['my-app'],
        flags: { 'skip-install': true, 'template-dir': templateDir },
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('--force overwrites an existing target directory', async () => {
    const templateDir = join(tmp, 'template');
    await writeFakeTemplate(templateDir);
    await mkdir(join(tmp, 'my-app'));

    const result = await initCommand.run({
      cwd: tmp,
      format: 'json',
      args: ['my-app'],
      flags: { 'skip-install': true, 'template-dir': templateDir, force: true },
    });

    expect(result).toMatchObject({ created: true, projectName: 'my-app' });
    expect(existsSync(join(tmp, 'my-app', 'package.json'))).toBe(true);
  });
});
