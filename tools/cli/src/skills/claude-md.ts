import type { Skill, SkillCategory } from './indexer';

/**
 * Render a `CLAUDE.md`-style skill index for the given skills.
 *
 * Skills are grouped by category — Workflow first, then Reference — and sorted
 * alphabetically (case-insensitive) within each section. A section is omitted
 * entirely when no skills of that category are present, so an empty input
 * produces only the top-level heading.
 *
 * Each list entry uses the format:
 *   `- **<name>** — <description>. See \`<filePath>\`.`
 *
 * The returned string always ends with a single trailing newline.
 */
export function renderClaudeMd(skills: Skill[]): string {
  const sections: { title: string; category: SkillCategory }[] = [
    { title: 'Workflow Skills', category: 'workflow' },
    { title: 'Reference Skills', category: 'reference' },
  ];

  const lines: string[] = ['# Project Skills Index'];

  for (const { title, category } of sections) {
    const inSection = skills
      .filter((s) => s.category === category)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    if (inSection.length === 0) continue;

    lines.push('', `## ${title}`, '');
    for (const skill of inSection) {
      lines.push(`- **${skill.name}** — ${skill.description}. See \`${skill.filePath}\`.`);
    }
  }

  return `${lines.join('\n')}\n`;
}
