/**
 * `env_files` loader.
 *
 * Reads dotenv-style files in declared order and returns the merged
 * env map. Later files override earlier ones on key collision. Missing
 * files are silently skipped (this is by design — `.env.local` etc. are
 * commonly absent from fresh clones; we don't want to make every caller
 * pre-flight the existence of every path).
 *
 * Callers are responsible for path resolution. The spec says env_files
 * paths are resolved relative to the *project root* (not the worktree —
 * `.env.local` typically lives in the parent repo). That resolution
 * happens at the call site; this module takes already-absolute paths.
 *
 * Plan 1 (this file) only handles the file-read + parse step. The full
 * env resolution pipeline (Task 13) layers the output of this on top of
 * literals and the output of `env_from`, applies per-service overrides,
 * and then runs the interpolation engine over the merged result.
 *
 * Dotenv parsing here is the standard subset most dotenv libraries
 * implement. We do NOT pull in a dependency for this — it's a few dozen
 * lines and inlining keeps the binary small and the behavior pinned.
 *
 * Subset implemented:
 *   - `KEY=value` assignments; one per line
 *   - Blank lines and `#`-prefixed comment lines ignored
 *   - Leading `export ` stripped (so `export KEY=value` works)
 *   - Double-quoted values: outer quotes stripped, `\n` `\t` `\\` `\"`
 *     escapes processed
 *   - Single-quoted values: outer quotes stripped; contents are literal
 *     (no escape processing — matches POSIX shell)
 *   - Unquoted values: trailing whitespace trimmed; inline `# comment`
 *     is NOT stripped (matches conventional dotenv behavior — put
 *     comments on their own line if you want them)
 *
 * Not implemented (out of scope; keep it simple):
 *   - Multi-line / continuation values
 *   - Variable expansion within values (`${OTHER_KEY}`) — lich's own
 *     `${...}` interpolation runs later in the pipeline against the
 *     runtime context, not against other env vars
 */

import { promises as fs } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoadEnvFilesInput {
  /**
   * Absolute paths to dotenv files, in priority order (earlier loses to
   * later on key collision). Relative paths should be resolved by the
   * caller against the project root before passing here.
   */
  files: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a single dotenv file's contents into a flat env map. Throws on
 * malformed lines (unbalanced quotes, missing `=`). The `file` argument
 * is used only to format error messages.
 */
function parseDotenv(text: string, file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;

    // Strip leading whitespace for comment/blank detection. We keep the
    // original line around so error positions are sensible, but the
    // parser itself operates on a trimmed-left view.
    let line = rawLine.replace(/^[\t ]+/, "");

    // Blank line or full-line comment: skip.
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;

    // Optional `export ` prefix.
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).replace(/^[\t ]+/, "");
    }

    // Split on the first `=`. Anything before is the key; anything after
    // is the raw value (we handle quoting next).
    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new Error(
        `env_files: ${file}:${lineNo}: missing '=' in assignment`,
      );
    }

    const key = line.slice(0, eq).trimEnd();
    if (key.length === 0) {
      throw new Error(`env_files: ${file}:${lineNo}: empty key`);
    }
    // Sanity: keys can't contain spaces or `=` (we already cut at the
    // first `=`, so the latter is only a real concern for embedded
    // characters). Keep this loose; users have weird env keys.
    if (/\s/.test(key)) {
      throw new Error(
        `env_files: ${file}:${lineNo}: invalid key "${key}" (contains whitespace)`,
      );
    }

    const rawValue = line.slice(eq + 1);
    out[key] = parseValue(rawValue, file, lineNo);
  }

  return out;
}

/**
 * Parse the value portion of an assignment. Handles double-quoted,
 * single-quoted, and unquoted values.
 */
function parseValue(raw: string, file: string, lineNo: number): string {
  // Strip leading whitespace between `=` and the value. (Trailing
  // whitespace handling depends on quoting — see below.)
  const v = raw.replace(/^[\t ]+/, "");

  if (v.length === 0) return "";

  const first = v[0];

  if (first === '"') {
    // Double-quoted: find the closing unescaped `"`. Process escapes.
    const closeIdx = findClosingDoubleQuote(v, 1);
    if (closeIdx === -1) {
      throw new Error(
        `env_files: ${file}:${lineNo}: unbalanced double quote`,
      );
    }
    // Anything after the closing quote should be only whitespace (we
    // don't support trailing inline comments after quoted values, and
    // garbage there is almost certainly a bug in the user's file).
    const tail = v.slice(closeIdx + 1);
    if (tail.replace(/[\t ]+$/, "").length > 0) {
      throw new Error(
        `env_files: ${file}:${lineNo}: unexpected content after closing quote`,
      );
    }
    return unescapeDoubleQuoted(v.slice(1, closeIdx));
  }

  if (first === "'") {
    // Single-quoted: literal contents, no escapes. Find the next `'`.
    const closeIdx = v.indexOf("'", 1);
    if (closeIdx === -1) {
      throw new Error(
        `env_files: ${file}:${lineNo}: unbalanced single quote`,
      );
    }
    const tail = v.slice(closeIdx + 1);
    if (tail.replace(/[\t ]+$/, "").length > 0) {
      throw new Error(
        `env_files: ${file}:${lineNo}: unexpected content after closing quote`,
      );
    }
    return v.slice(1, closeIdx);
  }

  // Unquoted: trim trailing whitespace. Inline `# comment` is NOT
  // stripped — conventional dotenv puts comments on their own line.
  return v.replace(/[\t ]+$/, "");
}

/**
 * Find the index of the closing unescaped `"` for a double-quoted
 * value, starting from `start` (the index of the first character after
 * the opening quote). Backslash-escaped `\"` does not close.
 */
function findClosingDoubleQuote(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      // Skip the next character (it's escaped). If the backslash is the
      // last char, fall through and the loop ends — the missing close
      // quote is reported by the caller.
      i++;
      continue;
    }
    if (c === '"') return i;
  }
  return -1;
}

/**
 * Process backslash escapes inside a double-quoted value:
 *   \n -> newline, \t -> tab, \r -> carriage return,
 *   \\ -> backslash, \" -> double quote.
 * Unknown escapes are kept as-is (backslash + char).
 */
function unescapeDoubleQuoted(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) {
      // Trailing backslash — keep literally (caller already validated
      // the closing quote, so this can't be an escape of the closer).
      out += "\\";
      break;
    }
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      default:
        // Unknown escape: pass through verbatim.
        out += "\\" + next;
        break;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and merge dotenv files. Missing files are silently skipped (NOT
 * an error). Files are merged in the declared order; later files
 * override earlier ones for any key collision. Throws on parse failure
 * of a present file, or on read errors other than ENOENT.
 *
 * Returns the merged env map. An empty input or a list of only-missing
 * files returns `{}`.
 */
export async function loadEnvFiles(
  input: LoadEnvFilesInput,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (const file of input.files) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        // Missing file: silently skip — by design.
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`env_files: failed to read ${file}: ${msg}`);
    }

    const parsed = parseDotenv(text, file);
    for (const key of Object.keys(parsed)) {
      merged[key] = parsed[key];
    }
  }

  return merged;
}
