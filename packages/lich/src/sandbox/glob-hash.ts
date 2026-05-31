import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

// Deterministic content hash of all files matching the given globs, relative to
// root. Sorted by path so filesystem enumeration order never affects the result.
// A glob matching nothing still contributes a stable marker, so "glob added but
// empty" differs from "glob absent".
export async function hashGlobs(root: string, globs: ReadonlyArray<string>): Promise<string> {
  const h = createHash('sha256');
  for (const glob of [...globs].sort()) {
    h.update(`\nglob:${glob}\n`);
    const g = new Glob(glob);
    const matches: string[] = [];
    for await (const m of g.scan({ cwd: root, onlyFiles: true, dot: true })) {
      matches.push(m);
    }
    matches.sort();
    if (matches.length === 0) {
      h.update('<<empty>>');
      continue;
    }
    for (const rel of matches) {
      h.update(`file:${rel}\n`);
      h.update(readFileSync(`${root}/${rel}`));
      h.update('\n');
    }
  }
  return h.digest('hex');
}
