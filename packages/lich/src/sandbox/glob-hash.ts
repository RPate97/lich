import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, join } from 'node:path';

// Deterministic content hash of all files matching the given globs, relative to
// root. Sorted by path so filesystem enumeration order never affects the result.
// A glob matching nothing still contributes a stable marker, so "glob added but
// empty" differs from "glob absent". Node-native (no Bun dependency) so it loads
// under vitest as well as the bun runtime.
export async function hashGlobs(root: string, globs: ReadonlyArray<string>): Promise<string> {
  const h = createHash('sha256');
  const allFiles = walk(root, root);
  for (const glob of [...globs].sort()) {
    h.update(`\nglob:${glob}\n`);
    const re = globToRegExp(glob);
    const matches = allFiles.filter((rel) => re.test(rel)).sort();
    if (matches.length === 0) {
      h.update('<<empty>>');
      continue;
    }
    for (const rel of matches) {
      h.update(`file:${rel}\n`);
      h.update(readFileSync(join(root, rel)));
      h.update('\n');
    }
  }
  return h.digest('hex');
}

function walk(dir: string, root: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walk(full, root));
    } else if (e.isFile()) {
      out.push(relative(root, full));
    }
  }
  return out;
}

// Minimal glob → RegExp supporting `**`, `*`, `?`, matched against POSIX-style
// relative paths. `**` spans path separators; `*` does not.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // `**/` → zero or more leading path segments
        } else {
          re += '.*'; // trailing `**` → everything beneath
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
