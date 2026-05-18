import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { resolveStackContext } from '../../services/context';
import { renderClaudeMd } from '../../skills/claude-md';
import { scanSkills as defaultScanSkills } from '../../skills/indexer';
import type { Skill } from '../../skills/indexer';
import type { Command } from '../types';

export interface SkillsIndexOptions {
  /** Skill scanner; defaults to the canonical filesystem scanner. */
  scanSkills?: (rootDir: string) => Promise<Skill[]>;
}

const SKILLS_SUBPATH = join('.levelzero', 'skills');
const OUTPUT_FILENAME = 'CLAUDE.md';

/**
 * Build `levelzero skills index`. Resolves the current worktree, scans
 * `.levelzero/skills/{workflow,reference}`, renders the CLAUDE.md skill index,
 * and writes it to `CLAUDE.md` at the project root.
 *
 * Skill `filePath`s from the scanner are absolute; we rewrite them to paths
 * relative to the project root before rendering so the index links to the
 * checked-in `.levelzero/skills/...` location regardless of where the project
 * lives on disk.
 */
export function makeSkillsIndexCommand(opts?: SkillsIndexOptions): Command {
  const scanSkills = opts?.scanSkills ?? defaultScanSkills;

  return {
    name: 'skills.index',
    describe: "Scan .levelzero/skills and write the CLAUDE.md skill index at the project root",
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const skillsDir = join(stackCtx.worktreePath, SKILLS_SUBPATH);

      const skills = await scanSkills(skillsDir);
      const relativized = skills.map((s) => ({
        ...s,
        filePath: relativizeFilePath(stackCtx.worktreePath, s.filePath),
      }));

      const contents = renderClaudeMd(relativized);
      const outputPath = join(stackCtx.worktreePath, OUTPUT_FILENAME);
      await writeFile(outputPath, contents, 'utf8');

      const result = { skillCount: skills.length, outputPath };
      if (ctx.format === 'json') return result;
      return `Indexed ${skills.length} skill(s) — wrote ${outputPath}\n`;
    },
  };
}

function relativizeFilePath(projectRoot: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const rel = relative(projectRoot, filePath);
  // If filePath escapes the project root (unexpected — but be safe), keep the
  // original so the index isn't silently misleading.
  if (rel.startsWith('..')) return filePath;
  return rel;
}

export const skillsIndexCommand: Command = makeSkillsIndexCommand();
