/**
 * env_from shell-out loader.
 *
 * Runs each `env_from` entry's command sequentially, parses its stdout as
 * dotenv (default) or JSON, and merges the results into a single env map.
 * Later entries override earlier ones on key collision.
 *
 * The spawned child inherits the caller-provided `baseEnv` so the user's
 * CLI auth context (infisical, op, doppler, etc.) is visible to secret
 * loaders without lich having to know anything about them.
 */

import { spawn } from "node:child_process";

export type EnvFromEntry =
  | string
  | {
      cmd: string;
      /** Default 'dotenv'. */
      format?: "dotenv" | "json";
      /** Working directory for the spawned command. If omitted, falls back to input.defaultCwd, else child inherits cwd. */
      cwd?: string;
    };

export interface ShellOutInput {
  entries: EnvFromEntry[];
  /** Base env passed to spawned children. Typically the host process.env so user's auth tokens are visible. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Optional: cwd for entries that don't specify one. */
  defaultCwd?: string;
}

export class ShellOutError extends Error {
  /** The cmd that failed. */
  readonly cmd: string;
  /** Exit code (non-zero) or 'parse' if stdout couldn't be parsed. */
  readonly reason: number | "parse";
  /** Captured stderr (for non-zero exits) or stdout snippet (for parse failures). */
  readonly detail: string;

  constructor(cmd: string, reason: number | "parse", detail: string) {
    const why =
      reason === "parse"
        ? `failed to parse output`
        : `exited with code ${reason}`;
    super(`env_from command ${why}: ${cmd}\n${detail}`);
    this.name = "ShellOutError";
    this.cmd = cmd;
    this.reason = reason;
    this.detail = detail;
  }
}

interface NormalizedEntry {
  cmd: string;
  format: "dotenv" | "json";
  cwd?: string;
}

function normalize(entry: EnvFromEntry, defaultCwd?: string): NormalizedEntry {
  if (typeof entry === "string") {
    return { cmd: entry, format: "dotenv", cwd: defaultCwd };
  }
  return {
    cmd: entry.cmd,
    format: entry.format ?? "dotenv",
    cwd: entry.cwd ?? defaultCwd,
  };
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runShell(
  cmd: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Minimal dotenv parser. Supports:
 *  - blank lines and `#` comment lines (ignored)
 *  - optional `export ` prefix (stripped)
 *  - KEY=value, where value may be:
 *      - unquoted (trimmed; trailing inline `# comment` stripped)
 *      - single-quoted (literal contents)
 *      - double-quoted (with backslash escapes for \n, \r, \t, \\, \", \$)
 *
 * Kept inline (~30 lines) to avoid pulling in a dotenv dep and to avoid
 * importing from sibling files owned by other agents.
 */
function parseDotenv(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = input.split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq === -1) continue; // malformed line: silently skip
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1);

    // Strip surrounding whitespace before quote detection.
    value = value.replace(/^[ \t]+/, "");

    if (value.startsWith('"')) {
      // Double-quoted: find closing quote, honour escapes.
      const end = findClosingQuote(value, '"');
      if (end === -1) {
        // No closing quote — treat rest as literal (best-effort).
        out[key] = unescapeDouble(value.slice(1));
      } else {
        out[key] = unescapeDouble(value.slice(1, end));
      }
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      if (end === -1) {
        out[key] = value.slice(1);
      } else {
        out[key] = value.slice(1, end);
      }
    } else {
      // Unquoted: strip trailing inline `# comment` and trailing whitespace.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash);
      out[key] = value.trim();
    }
  }
  return out;
}

function findClosingQuote(s: string, quote: '"' | "'"): number {
  // Walk from index 1, skip backslash-escaped characters.
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && quote === '"') {
      i += 1; // skip the next char
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

function unescapeDouble(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        case "$":
          out += "$";
          break;
        default:
          out += next;
          break;
      }
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonEnv(cmd: string, stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new ShellOutError(cmd, "parse", snippet(stdout));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ShellOutError(
      cmd,
      "parse",
      `expected a flat JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}: ${snippet(stdout)}`,
    );
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null) {
      throw new ShellOutError(
        cmd,
        "parse",
        `key ${JSON.stringify(k)} has null value; expected string|number|boolean`,
      );
    }
    if (typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else {
      // object or array — nested values aren't supported.
      throw new ShellOutError(
        cmd,
        "parse",
        `key ${JSON.stringify(k)} has non-scalar value (${Array.isArray(v) ? "array" : typeof v}); expected string|number|boolean`,
      );
    }
  }
  return out;
}

function snippet(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 200) + "...";
}

/**
 * Run each entry in order. Merge results in declared order; later entries
 * override earlier ones on key collision. Throws ShellOutError on any
 * non-zero exit OR parse failure.
 */
export async function loadEnvFromShellOut(
  input: ShellOutInput,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const rawEntry of input.entries) {
    const entry = normalize(rawEntry, input.defaultCwd);
    const result = await runShell(entry.cmd, entry.cwd, input.baseEnv);
    if (result.exitCode !== 0) {
      throw new ShellOutError(entry.cmd, result.exitCode, result.stderr.trim());
    }
    const parsed =
      entry.format === "json"
        ? parseJsonEnv(entry.cmd, result.stdout)
        : parseDotenv(result.stdout);
    Object.assign(merged, parsed);
  }
  return merged;
}
