import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A skill is a markdown document with YAML frontmatter that lives under
 * `<rootDir>/{workflow,reference}/<name>.md`. The frontmatter is a minimal
 * shape — `name`, `description`, `applies-to` — and the body is the markdown
 * content that follows the closing `---` fence.
 */
export interface Skill {
  filePath: string;
  category: SkillCategory;
  name: string;
  description: string;
  appliesTo: string;
  body: string;
}

export type SkillCategory = 'workflow' | 'reference';

const CATEGORIES: readonly SkillCategory[] = ['workflow', 'reference'];
const REQUIRED_KEYS = ['name', 'description', 'applies-to'] as const;

/**
 * Scan `<rootDir>/{workflow,reference}/*.md` and return parsed `Skill`
 * metadata for each file. Throws with the offending filepath if a skill's
 * frontmatter is malformed, missing a required key, or declares an unknown
 * `applies-to` category.
 *
 * Missing category directories are silently skipped — they're optional. Only
 * `.md` files at the top level of each category are considered.
 */
export async function scanSkills(rootDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const category of CATEGORIES) {
    const dir = join(rootDir, category);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = join(dir, entry);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      const raw = await readFile(filePath, 'utf8');
      skills.push(parseSkill(filePath, category, raw));
    }
  }
  return skills;
}

function parseSkill(filePath: string, category: SkillCategory, raw: string): Skill {
  const { frontmatter, body } = splitFrontmatter(filePath, raw);
  const fields = parseInlineYaml(filePath, frontmatter);

  for (const key of REQUIRED_KEYS) {
    if (!(key in fields)) {
      throw new Error(
        `Skill at ${filePath} is missing required frontmatter key "${key}"`,
      );
    }
  }

  const appliesTo = fields['applies-to']!;
  if (!CATEGORIES.includes(appliesTo as SkillCategory)) {
    throw new Error(
      `Skill at ${filePath} has unknown category "applies-to: ${appliesTo}" ` +
        `(expected one of: ${CATEGORIES.join(', ')})`,
    );
  }

  return {
    filePath,
    category,
    name: fields['name']!,
    description: fields['description']!,
    appliesTo,
    body,
  };
}

/**
 * Split a file's raw contents into its frontmatter block and body. The
 * frontmatter must open on the very first line with `---` and close with a
 * later `---` on its own line. Anything else is rejected with a clear message.
 */
function splitFrontmatter(
  filePath: string,
  raw: string,
): { frontmatter: string; body: string } {
  const lines = raw.split('\n');
  if (lines.length === 0 || lines[0]!.trim() !== '---') {
    throw new Error(
      `Skill at ${filePath} is missing YAML frontmatter (expected first line to be "---")`,
    );
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error(
      `Skill at ${filePath} has an unterminated YAML frontmatter block (no closing "---")`,
    );
  }

  const frontmatter = lines.slice(1, closeIdx).join('\n');
  const bodyLines = lines.slice(closeIdx + 1);
  // Drop a single leading blank line so a frontmatter that's followed by
  // `\n# Heading` doesn't render as a leading blank in `body`.
  if (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift();
  return { frontmatter, body: bodyLines.join('\n') };
}

/**
 * Parse a tiny subset of YAML: a flat map of `key: value` pairs, one per line,
 * with optional surrounding single- or double-quotes on the value. No nested
 * structures, lists, or multi-line scalars — frontmatter is intentionally
 * minimal so we don't need a full YAML library.
 */
function parseInlineYaml(filePath: string, src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `Skill at ${filePath} has malformed frontmatter on line ${i + 1}: ` +
          `expected "key: value", got ${JSON.stringify(line)}`,
      );
    }

    const key = line.slice(0, colon).trim();
    if (key === '') {
      throw new Error(
        `Skill at ${filePath} has malformed frontmatter on line ${i + 1}: empty key`,
      );
    }

    const rawValue = line.slice(colon + 1).trim();
    out[key] = unquote(rawValue);
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
