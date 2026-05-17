import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

/** Directories that must never be copied into the scaffolded project. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo']);

export interface CopyTemplateInput {
  /** Source directory containing the template tree. */
  from: string;
  /** Destination directory; created if it does not exist. */
  to: string;
  /**
   * Map of placeholder names to substitution values. `{{name}}` occurrences in
   * file CONTENTS are replaced with the corresponding value. Filenames are not
   * substituted.
   */
  vars: Record<string, string>;
}

export interface CopyTemplateOutput {
  /**
   * Relative POSIX-style paths of every file written under `to`, sorted so the
   * output is stable across platforms.
   */
  files: string[];
}

/**
 * Recursively copy a template tree from `from` into `to`, performing
 * `{{varName}}` substitution on every file's contents. Returns the list of
 * files written, with paths relative to `to` using `/` separators.
 *
 * Directories named `node_modules`, `.git`, `dist`, or `.turbo` are skipped
 * entirely — they're never traversed or materialized in the destination.
 */
export async function copyTemplate(input: CopyTemplateInput): Promise<CopyTemplateOutput> {
  const { from, to, vars } = input;
  await mkdir(to, { recursive: true });

  const files: string[] = [];
  await walk(from, to, '', vars, files);
  files.sort();
  return { files };
}

async function walk(
  fromRoot: string,
  toRoot: string,
  relDir: string,
  vars: Record<string, string>,
  files: string[],
): Promise<void> {
  const absFromDir = relDir === '' ? fromRoot : join(fromRoot, relDir);
  const entries = await readdir(absFromDir, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = relDir === '' ? entry.name : posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(fromRoot, toRoot, relPath, vars, files);
    } else if (entry.isFile()) {
      const absFrom = join(fromRoot, relPath);
      const absTo = join(toRoot, relPath);
      const contents = await readFile(absFrom, 'utf8');
      const substituted = substitute(contents, vars);
      await mkdir(dirname(absTo), { recursive: true });
      await writeFile(absTo, substituted);
      files.push(relPath);
    }
    // Symlinks and other entry kinds are intentionally ignored — template trees
    // are expected to be plain files and directories.
  }
}

/**
 * Replace every `{{name}}` occurrence with `vars[name]`. Unknown placeholders
 * are left untouched so authors notice them in the generated output rather
 * than silently producing empty strings.
 */
function substitute(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : match;
  });
}
