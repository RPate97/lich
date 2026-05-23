import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { templateRoot } from '@lich/template-v0-stack';
import { scanSkills } from '../../src/skills/indexer';

// The vendored reference skills shipped with the v0-stack template must all
// parse via the canonical `scanSkills` indexer. This test guards against
// frontmatter regressions when the templates are edited.
const REFERENCE_DIR = join(templateRoot, '.lich', 'skills');

const EXPECTED = ['prisma', 'hono', 'next', 'tailwind', 'shadcn'] as const;

describe('v0-stack reference skills', () => {
  it('parses every reference skill via scanSkills', async () => {
    const skills = await scanSkills(REFERENCE_DIR);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

    for (const name of EXPECTED) {
      const skill = byName[name];
      expect(skill, `expected reference skill "${name}" to parse`).toBeDefined();
      expect(skill!.category).toBe('reference');
      expect(skill!.appliesTo).toBe('reference');
      expect(skill!.description.length).toBeGreaterThan(0);
      expect(skill!.body.trim().length).toBeGreaterThan(0);
    }

    expect(skills.length).toBeGreaterThanOrEqual(EXPECTED.length);
  });
});
