import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkills } from '../../src/skills/indexer';

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-skills-')));
});

function writeSkill(category: string, name: string, contents: string): string {
  const dir = join(tmp, category);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.md`);
  writeFileSync(filePath, contents);
  return filePath;
}

describe('scanSkills', () => {
  it('returns an empty list when neither workflow nor reference directories exist', async () => {
    const skills = await scanSkills(tmp);
    expect(skills).toEqual([]);
  });

  it('parses a well-formed workflow skill', async () => {
    const filePath = writeSkill(
      'workflow',
      'change',
      [
        '---',
        'name: change',
        'description: How to make a change to the codebase',
        'applies-to: workflow',
        '---',
        '',
        '# Change',
        '',
        'body content here',
        '',
      ].join('\n'),
    );

    const skills = await scanSkills(tmp);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.filePath).toBe(filePath);
    expect(skill.category).toBe('workflow');
    expect(skill.name).toBe('change');
    expect(skill.description).toBe('How to make a change to the codebase');
    expect(skill.appliesTo).toBe('workflow');
    expect(skill.body).toBe('# Change\n\nbody content here\n');
  });

  it('parses a well-formed reference skill', async () => {
    writeSkill(
      'reference',
      'api-docs',
      [
        '---',
        'name: api-docs',
        'description: API reference docs',
        'applies-to: reference',
        '---',
        'reference body',
      ].join('\n'),
    );

    const skills = await scanSkills(tmp);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.category).toBe('reference');
    expect(skills[0]!.name).toBe('api-docs');
    expect(skills[0]!.body).toBe('reference body');
  });

  it('parses multiple skills across categories and returns them all', async () => {
    writeSkill(
      'workflow',
      'change',
      '---\nname: change\ndescription: d1\napplies-to: workflow\n---\nb1',
    );
    writeSkill(
      'workflow',
      'review',
      '---\nname: review\ndescription: d2\napplies-to: workflow\n---\nb2',
    );
    writeSkill(
      'reference',
      'glossary',
      '---\nname: glossary\ndescription: d3\napplies-to: reference\n---\nb3',
    );

    const skills = await scanSkills(tmp);
    expect(skills).toHaveLength(3);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(byName['change']!.category).toBe('workflow');
    expect(byName['review']!.category).toBe('workflow');
    expect(byName['glossary']!.category).toBe('reference');
  });

  it('tolerates quoted scalar values in frontmatter', async () => {
    writeSkill(
      'workflow',
      'quoted',
      [
        '---',
        'name: "quoted"',
        "description: 'has: a colon in it'",
        'applies-to: "workflow"',
        '---',
        'body',
      ].join('\n'),
    );

    const skills = await scanSkills(tmp);
    expect(skills[0]!.name).toBe('quoted');
    expect(skills[0]!.description).toBe('has: a colon in it');
    expect(skills[0]!.appliesTo).toBe('workflow');
  });

  it('throws with the filepath when frontmatter is missing entirely', async () => {
    const filePath = writeSkill('workflow', 'no-fm', '# just a heading\n\nbody');

    await expect(scanSkills(tmp)).rejects.toThrow(filePath);
  });

  it('throws with the filepath when the opening fence is present but the closing fence is missing', async () => {
    const filePath = writeSkill(
      'workflow',
      'unclosed',
      '---\nname: unclosed\ndescription: x\napplies-to: workflow\nbody but no close',
    );

    await expect(scanSkills(tmp)).rejects.toThrow(filePath);
  });

  it('throws with the filepath when a required key is missing', async () => {
    const filePath = writeSkill(
      'workflow',
      'partial',
      '---\nname: partial\ndescription: missing applies-to\n---\nbody',
    );

    await expect(scanSkills(tmp)).rejects.toThrow(filePath);
  });

  it('throws when applies-to is not one of the known categories', async () => {
    const filePath = writeSkill(
      'workflow',
      'bad-applies-to',
      '---\nname: bad-applies-to\ndescription: d\napplies-to: nonsense\n---\nbody',
    );

    await expect(scanSkills(tmp)).rejects.toThrow(filePath);
  });
});
