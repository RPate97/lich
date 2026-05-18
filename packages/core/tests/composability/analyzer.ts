/**
 * Static analyzer for the composability rule (see docs/EXTENSION.md
 * "Composability rule"): a file under `packages/plugin-X/src/**` must not
 * import from a sibling `@levelzero/plugin-*` package, nor from
 * `@levelzero/template-*`. Allowed: `@levelzero/core` (and subpaths),
 * third-party npm packages, and relative paths.
 *
 * Implementation: a regex pass over source text that has been
 * pre-processed to blank out comments and unrelated string literals.
 * That keeps false positives off JSDoc lines like
 *   `* import dotenv from '@levelzero/plugin-dotenv';`
 * and identifier strings like
 *   `name: '@levelzero/plugin-foo',`
 * while still catching real `import`/`export`/`require`/`import(...)`
 * statements.
 */

/** A single offending import in a plugin source file. */
export interface Violation {
  /** Path to the file (caller chooses absolute or relative). */
  file: string;
  /** 1-indexed line number where the offending specifier was found. */
  line: number;
  /** The module specifier that violated the rule. */
  specifier: string;
  /** Human-readable reason this specifier is forbidden. */
  reason: string;
}

/**
 * Module specifiers appear in four positions. Each alternative ends in a
 * quoted string; we anchor on the token that precedes the quote and capture
 * the specifier itself.
 *
 *   1. `import [...] from '<spec>'`     bare-side-effect: `import '<spec>'`
 *   2. `export [...] from '<spec>'`
 *   3. `import('<spec>')`               (dynamic import)
 *   4. `require('<spec>')`
 */
const IMPORT_PATTERNS: RegExp[] = [
  // import x from '...';  import {a, b} from '...';  import '...';
  /\bimport\b(?:[^'"`;]*?\bfrom\s*)?['"]([^'"]+)['"]/g,
  // export {a} from '...';  export * from '...';
  /\bexport\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // import('...')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // require('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Scan a single source file's contents and report forbidden imports.
 *
 * @param fileLabel  Filename used in returned violations (caller chooses
 *                   absolute or relative).
 * @param ownPackage The owning package's name (e.g. `@levelzero/plugin-foo`).
 *                   Imports of `ownPackage` from within `ownPackage`'s own
 *                   sources are allowed (degenerate self-reference).
 * @param source     The full text of the file.
 */
export function analyzeSource(
  fileLabel: string,
  ownPackage: string,
  source: string,
): Violation[] {
  const stripped = stripCommentsAndStrings(source);
  const violations: Violation[] = [];
  const seen = new Set<string>(); // dedupe identical (line, specifier) hits

  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripped)) !== null) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const reason = classify(specifier, ownPackage);
      if (reason === null) continue;
      // The specifier text is present in both stripped and original (we
      // only blank non-import strings). Find its position in the matched
      // chunk to compute the line.
      const specOffsetInMatch = match[0].lastIndexOf(specifier);
      const offset = match.index + specOffsetInMatch;
      const line = lineOf(source, offset);
      const key = `${line}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ file: fileLabel, line, specifier, reason });
    }
  }

  // Sort for stable output.
  violations.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
  return violations;
}

/**
 * Returns a violation reason if `specifier` is forbidden for a file inside
 * `ownPackage`, else `null`.
 */
function classify(specifier: string, ownPackage: string): string | null {
  if (specifier.startsWith('@levelzero/plugin-')) {
    // Allow self-imports — they degenerate to a relative path.
    const head = specifier.split('/').slice(0, 2).join('/');
    if (head === ownPackage) return null;
    return 'cross-plugin import: a plugin package may not import from another @levelzero/plugin-* package (use core capability lookups instead — see docs/EXTENSION.md "Composability rule")';
  }
  if (specifier.startsWith('@levelzero/template-')) {
    return 'template import: plugins must not import from @levelzero/template-* (templates are consumer artifacts, not runtime dependencies)';
  }
  return null;
}

/**
 * Blank out comments and any string literal that is NOT in module-specifier
 * position. Newlines are preserved so reported line numbers line up with
 * the original source.
 *
 * "Module-specifier position" means: the string immediately follows one of
 *   `import …(from)?`, `export … from`, `import(`, `require(`
 * (modulo whitespace). Anything else — JSDoc bodies, identifier strings,
 * error messages, etc. — gets blanked.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Line comment
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }

    // Block comment
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      for (let j = i; j < end; j++) out += src[j] === '\n' ? '\n' : ' ';
      i = end;
      continue;
    }

    // String / template literal
    if (c === '"' || c === "'" || c === '`') {
      const startQuote = i;
      const quote = c;
      i++; // past opening
      const contentStart = i;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (quote === '`' && ch === '$' && src[i + 1] === '{') {
          // Skip over ${...} interpolation.
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        if (ch === quote) break;
        i++;
      }
      const contentEnd = i; // index of closing quote (or n if unterminated)
      const hasClose = i < n;
      const literalEnd = hasClose ? i + 1 : n;

      if (isImportContext(out)) {
        // Preserve the literal verbatim so IMPORT_PATTERNS can match it.
        out += src.slice(startQuote, literalEnd);
      } else {
        // Blank the whole literal (incl. quotes), preserving newlines.
        for (let j = startQuote; j < literalEnd; j++) {
          out += src[j] === '\n' ? '\n' : ' ';
        }
      }
      i = literalEnd;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Looking at the already-emitted (stripped) buffer, decide whether the
 * cursor is at a position where a following string literal is a module
 * specifier. We accept the keyword forms `from`, `import`, and `(` when
 * preceded by `import` or `require`.
 */
function isImportContext(stripped: string): boolean {
  // Take the last ~64 chars (specifiers always sit within that distance
  // of their keyword in any sane formatting) and trim trailing whitespace.
  const tail = stripped.slice(Math.max(0, stripped.length - 64)).replace(/\s+$/, '');
  if (/\bfrom$/.test(tail)) return true;
  if (/\bimport$/.test(tail)) return true; // side-effect `import '...'`
  if (tail.endsWith('(')) {
    const before = tail.slice(0, -1).replace(/\s+$/, '');
    return /\b(?:import|require)$/.test(before);
  }
  return false;
}

/** 1-indexed line number of a 0-indexed character offset in `src`. */
function lineOf(src: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, src.length);
  for (let i = 0; i < end; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/** Format a list of violations into a single human-readable failure message. */
export function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return '';
  const lines = [
    `${violations.length} cross-plugin / template import violation${violations.length === 1 ? '' : 's'} found:`,
    '',
  ];
  for (const v of violations) {
    lines.push(`  ${v.file}:${v.line}  imports '${v.specifier}'`);
    lines.push(`    ${v.reason}`);
  }
  lines.push('');
  lines.push(
    'Plugin packages may only import from @levelzero/core, third-party npm packages, or relative paths.',
  );
  lines.push('See docs/EXTENSION.md "Composability rule" for details.');
  return lines.join('\n');
}
