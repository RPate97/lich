import { describe, it, expect } from 'vitest';
import { renderClaudeMd } from '../../src/skills/claude-md';
import type { Skill } from '../../src/skills/indexer';

function makeSkill(over: Partial<Skill> & Pick<Skill, 'name' | 'category'>): Skill {
  return {
    filePath: `.levelzero/skills/${over.category}/${over.name}.md`,
    description: 'a description',
    appliesTo: over.category,
    body: 'body',
    ...over,
  };
}

describe('renderClaudeMd', () => {
  it('returns a header-only doc with no body sections when given no skills', () => {
    const out = renderClaudeMd([]);
    expect(out).toContain('# Project Skills Index');
    expect(out).not.toContain('## Workflow Skills');
    expect(out).not.toContain('## Reference Skills');
  });

  it('emits a Workflow Skills section when only workflow skills are present', () => {
    const out = renderClaudeMd([
      makeSkill({
        name: 'change',
        category: 'workflow',
        description: 'How to make a change',
      }),
    ]);
    expect(out).toContain('## Workflow Skills');
    expect(out).toContain(
      '- **change** — How to make a change. See `.levelzero/skills/workflow/change.md`.',
    );
    expect(out).not.toContain('## Reference Skills');
  });

  it('emits a Reference Skills section when only reference skills are present', () => {
    const out = renderClaudeMd([
      makeSkill({
        name: 'prisma',
        category: 'reference',
        description: 'Prisma reference',
      }),
    ]);
    expect(out).toContain('## Reference Skills');
    expect(out).toContain(
      '- **prisma** — Prisma reference. See `.levelzero/skills/reference/prisma.md`.',
    );
    expect(out).not.toContain('## Workflow Skills');
  });

  it('groups skills into Workflow and Reference sections, in that order', () => {
    const out = renderClaudeMd([
      makeSkill({ name: 'prisma', category: 'reference', description: 'Prisma reference' }),
      makeSkill({ name: 'change', category: 'workflow', description: 'How to make a change' }),
      makeSkill({ name: 'hono', category: 'reference', description: 'Hono reference' }),
    ]);

    const workflowIdx = out.indexOf('## Workflow Skills');
    const referenceIdx = out.indexOf('## Reference Skills');
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(referenceIdx).toBeGreaterThan(-1);
    expect(workflowIdx).toBeLessThan(referenceIdx);
  });

  it('sorts skills within each section by name (case-insensitive)', () => {
    const out = renderClaudeMd([
      makeSkill({ name: 'tailwind', category: 'reference', description: 'Tailwind' }),
      makeSkill({ name: 'hono', category: 'reference', description: 'Hono' }),
      makeSkill({ name: 'prisma', category: 'reference', description: 'Prisma' }),
    ]);
    const honoIdx = out.indexOf('- **hono**');
    const prismaIdx = out.indexOf('- **prisma**');
    const tailwindIdx = out.indexOf('- **tailwind**');
    expect(honoIdx).toBeGreaterThan(-1);
    expect(prismaIdx).toBeGreaterThan(honoIdx);
    expect(tailwindIdx).toBeGreaterThan(prismaIdx);
  });

  it('uses the skill filePath (relative-style) in the See link', () => {
    const out = renderClaudeMd([
      makeSkill({
        name: 'debug',
        category: 'workflow',
        description: 'Debug systematically',
        filePath: '.levelzero/skills/workflow/debug.md',
      }),
    ]);
    expect(out).toContain('See `.levelzero/skills/workflow/debug.md`');
  });

  it('terminates the document with a single trailing newline', () => {
    const out = renderClaudeMd([
      makeSkill({ name: 'a', category: 'workflow', description: 'd' }),
    ]);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});
