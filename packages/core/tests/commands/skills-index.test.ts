import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../src/errors';
import {
  makeSkillsIndexCommand,
  skillsIndexCommand,
} from '../../src/commands/skills/index';

let projectDir: string;

function writeSkill(name: string, category: 'workflow' | 'reference', description: string): void {
  const dir = join(projectDir, '.lich', 'skills', category);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      `applies-to: ${category}`,
      '---',
      'body',
    ].join('\n'),
  );
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-skills-idx-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
});

describe('lich skills index', () => {
  it('exports a command named "skills.index"', () => {
    expect(skillsIndexCommand.name).toBe('skills.index');
    expect(typeof skillsIndexCommand.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is not inside a lich project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-skills-idx-out-')));
    const cmd = makeSkillsIndexCommand();
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('writes CLAUDE.md at the project root and returns { skillCount, outputPath }', async () => {
    writeSkill('prisma', 'reference', 'Prisma reference');
    writeSkill('hono', 'reference', 'Hono reference');
    writeSkill('change', 'workflow', 'How to make a change');

    const cmd = makeSkillsIndexCommand();
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { skillCount: number; outputPath: string };

    expect(result.skillCount).toBe(3);
    expect(result.outputPath).toBe(join(projectDir, 'CLAUDE.md'));
    expect(existsSync(result.outputPath)).toBe(true);

    const contents = readFileSync(result.outputPath, 'utf8');
    expect(contents).toContain('# Project Skills Index');
    expect(contents).toContain('## Workflow Skills');
    expect(contents).toContain('## Reference Skills');
    expect(contents).toContain('- **change** — How to make a change.');
    expect(contents).toContain('- **hono** — Hono reference.');
    expect(contents).toContain('- **prisma** — Prisma reference.');
  });

  it('writes paths relative to the project root in the index (not absolute)', async () => {
    writeSkill('change', 'workflow', 'How to make a change');

    const cmd = makeSkillsIndexCommand();
    await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });

    const contents = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(contents).toContain('See `.lich/skills/workflow/change.md`');
    expect(contents).not.toContain(projectDir);
  });

  it('writes a header-only CLAUDE.md and skillCount 0 when no skills are present', async () => {
    const cmd = makeSkillsIndexCommand();
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { skillCount: number; outputPath: string };

    expect(result.skillCount).toBe(0);
    const contents = readFileSync(result.outputPath, 'utf8');
    expect(contents).toContain('# Project Skills Index');
    expect(contents).not.toContain('## Workflow Skills');
    expect(contents).not.toContain('## Reference Skills');
  });

  it('invokes scanSkills against <projectRoot>/.lich/skills (injectable)', async () => {
    writeSkill('change', 'workflow', 'd');
    const scan = vi.fn(async (_dir: string) => []);
    const cmd = makeSkillsIndexCommand({ scanSkills: scan });
    await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(join(projectDir, '.lich', 'skills'));
  });
});
