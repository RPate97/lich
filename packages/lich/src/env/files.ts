/**
 * `env_files` loader. Reads dotenv-style files in declared order and merges
 * them; later files win on collision. Missing files are silently skipped
 * (`.env.local` etc. are commonly absent from fresh clones). Caller passes
 * already-absolute paths.
 *
 * Dotenv subset implemented (standard, inlined to avoid a dependency):
 *   - `KEY=value` assignments; one per line
 *   - blank lines and `#`-prefixed comment lines ignored
 *   - leading `export ` stripped
 *   - double-quoted values: `\n` `\t` `\\` `\"` escapes processed
 *   - single-quoted values: literal contents (POSIX shell behavior)
 *   - unquoted: trailing whitespace trimmed; inline `# comment` NOT stripped
 *
 * NOT implemented: multi-line / continuation values; `${OTHER_KEY}` expansion
 * (lich's own `${...}` runs later against the runtime context, not other vars).
 */

import { promises as fs } from "node:fs";

export interface LoadEnvFilesInput {
  /** Absolute paths to dotenv files, in priority order (earlier loses to later). */
  files: string[];
}

// see CLEANUP-HINTS.md: extract when next touched
/**
 * Parse a dotenv file into a flat env map. Throws on malformed lines.
 * `file` is used only for error messages.
 */
function parseDotenv(text: string, file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;

    let line = rawLine.replace(/^[\t ]+/, "");

    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;

    if (line.startsWith("export ")) {
      line = line.slice("export ".length).replace(/^[\t ]+/, "");
    }

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

function parseValue(raw: string, file: string, lineNo: number): string {
  // Strip leading whitespace between `=` and value (trailing depends on quoting).
  const v = raw.replace(/^[\t ]+/, "");

  if (v.length === 0) return "";

  const first = v[0];

  if (first === '"') {
    const closeIdx = findClosingDoubleQuote(v, 1);
    if (closeIdx === -1) {
      throw new Error(
        `env_files: ${file}:${lineNo}: unbalanced double quote`,
      );
    }
    // After the closing quote, only whitespace is allowed — garbage is
    // almost certainly a bug in the user's file.
    const tail = v.slice(closeIdx + 1);
    if (tail.replace(/[\t ]+$/, "").length > 0) {
      throw new Error(
        `env_files: ${file}:${lineNo}: unexpected content after closing quote`,
      );
    }
    return unescapeDoubleQuoted(v.slice(1, closeIdx));
  }

  if (first === "'") {
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

  // Unquoted: inline `# comment` is NOT stripped — conventional dotenv puts
  // comments on their own line.
  return v.replace(/[\t ]+$/, "");
}

/** Find the closing unescaped `"`. Backslash-escaped `\"` does not close. */
function findClosingDoubleQuote(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') return i;
  }
  return -1;
}

/** Process \n \t \r \\ \" inside a double-quoted value. Unknown escapes kept as-is. */
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
        out += "\\" + next;
        break;
    }
    i++;
  }
  return out;
}

/**
 * Load and merge dotenv files. Missing files silently skipped; later files
 * override earlier ones. Throws on parse failure of a present file, or read
 * errors other than ENOENT.
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
