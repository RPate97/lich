/**
 * `lich env <group>` — print a named env_group as dotenv-format on stdout.
 *
 * The output is intended for shell sourcing — `source <(lich env stack)`
 * loads the stack's resolved env into the current shell. To make that work
 * reliably, the emitted format MUST round-trip cleanly through the in-tree
 * dotenv parser used by `env_from` shell-out (`env/shell-out.ts`'s
 * `parseDotenv`). The round-trip is the SLO; the unit test asserts it.
 *
 * Sequence:
 *
 *   1. If no group name → usage on stderr, exit 2.
 *   2. Load `lich.yaml`, detect worktree, restore allocated ports from
 *      `state.json` (mirror of how `lich exec` will work in LEV-330).
 *      If no state file exists, allocated ports are empty — that's fine
 *      for groups that don't reference `${owned.X.port}` style refs; the
 *      `resolveEnvGroup` resolver only fails when an interpolation
 *      actually misses, which surfaces as a clear error to the user.
 *   3. Resolve the group via `resolveEnvGroup`.
 *   4. Serialize as dotenv, keys sorted alphabetically, write to stdout.
 *   5. Exit 0.
 *
 * Quoting rules (mirror `env/shell-out.ts`'s parser):
 *
 *   - Empty values: `KEY=` (unquoted; the parser returns "" for empty
 *     unquoted values).
 *   - Bare-alnum values (`^[A-Za-z0-9_./@:+-]+$`, no surrounding whitespace):
 *     unquoted, `KEY=value`.
 *   - Anything else: double-quoted, with these escapes applied to the body:
 *       `\` → `\\`,  `"` → `\"`,  `$` → `\$`,
 *       `\n` → `\n`, `\r` → `\r`, `\t` → `\t`.
 *     Other control chars are emitted as `\xNN` is NOT supported by the
 *     parser, so we conservatively still wrap them in double quotes and
 *     emit a literal `\\x..` sequence is wrong too — instead we wrap them
 *     in the literal bytes (the parser preserves them as-is inside double
 *     quotes when no escape sequence applies). In practice env values are
 *     printable strings; the round-trip test pins this for the common cases.
 *
 * NOTE: `lich env` is a discovery / shell-glue surface, not a diagnostic
 * surface — it does NOT load the config when the user runs it without a
 * group name (we emit usage and exit before touching the filesystem).
 *
 * Spec source: docs/superpowers/specs/2026-05-23-lich-v1-design.md (section 5).
 */

import { join } from "node:path";

import { parseConfig } from "../config/parse.js";
import { detectWorktree } from "../worktree/detect.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  type AllocatedPorts,
} from "../state/snapshot.js";
import {
  resolveEnvGroup,
  GroupResolveError,
  GroupCycleError,
} from "../groups/resolve.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnvCmdOptions {
  /** First positional after `env`. When absent → usage + exit 2. */
  groupName?: string;
  /** Directory to resolve `lich.yaml` from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Sink for normal output (defaults to console.log). */
  stdout?: (line: string) => void;
  /** Sink for error output (defaults to console.error). */
  stderr?: (line: string) => void;
  /**
   * Optional process.env override. Defaults to the live `process.env`.
   * Threaded into `resolveEnvGroup` so the `process_env: false` policy on
   * isolated groups still blocks the right env layer.
   */
  processEnv?: NodeJS.ProcessEnv;
}

export interface EnvCmdResult {
  exitCode: 0 | 1 | 2;
}

/**
 * Run the `lich env <group>` command. See the file-level JSDoc for behavior
 * summary; see {@link serializeDotenv} for the quoting/escaping rules.
 */
export async function runEnvCmd(
  opts: EnvCmdOptions = {},
): Promise<EnvCmdResult> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? ((s: string) => console.log(s));
  const err = opts.stderr ?? ((s: string) => console.error(s));

  // ---- Step 1: usage check -----------------------------------------------
  if (!opts.groupName) {
    err("usage: lich env <group>");
    return { exitCode: 2 };
  }
  const groupName = opts.groupName;

  // ---- Step 2: load config -----------------------------------------------
  const yamlPath = join(cwd, "lich.yaml");
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      err(`lich: ${e.location}: ${e.message}`);
    }
    return { exitCode: 1 };
  }
  const config = parsed.config;

  // ---- Step 3: detect worktree + restore allocated ports -----------------
  let worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch (e) {
    err(`lich: ${(e as Error).message}`);
    return { exitCode: 1 };
  }

  // No state.json is fine — the user may be asking for an env group that
  // doesn't reference any allocated ports (e.g. an isolated tools group).
  // Pass empty AllocatedPorts; if a `${owned.X.port}` ref is needed and
  // missing, the resolver's InterpolationError surfaces with a clear message.
  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  const allocatedPorts: AllocatedPorts = snap
    ? rebuildAllocatedPorts(snap)
    : { compose: {}, owned: {} };

  // ---- Step 4: resolve the group -----------------------------------------
  let env: Record<string, string>;
  try {
    env = await resolveEnvGroup({
      name: groupName,
      config,
      worktree,
      allocatedPorts,
      projectRoot: worktree.path,
      processEnv: opts.processEnv ?? process.env,
    });
  } catch (e) {
    if (e instanceof GroupResolveError || e instanceof GroupCycleError) {
      err(`lich: ${e.message}`);
    } else {
      err(`lich: ${(e as Error).message ?? String(e)}`);
    }
    return { exitCode: 1 };
  }

  // ---- Step 5: serialize + emit ------------------------------------------
  const lines = serializeDotenv(env);
  for (const line of lines) {
    out(line);
  }
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Dotenv serializer
// ---------------------------------------------------------------------------

/**
 * Characters we consider "bare-safe" — these can appear in an unquoted
 * dotenv value and still round-trip through the in-tree parser. We deliberately
 * keep this conservative; anything not on this whitelist falls into the
 * double-quoted branch so we never produce output the parser misreads.
 *
 * Notably:
 *   - whitespace, `#`, `'`, `"`, `\`, `$` are NOT bare-safe (the parser would
 *     either re-quote them, strip them as comments, or treat them as quote
 *     markers).
 *   - control chars (0x00-0x1F) and DEL (0x7F) are NOT bare-safe; they go
 *     through the quoted branch.
 *   - `,`, `(`, `)`, `=` are not bare-safe — shells may misinterpret them
 *     when re-sourcing.
 *
 * Allowed bare characters: ASCII letters/digits/`_`, plus the
 * "URL/path-friendly" set `./@:+-`. This covers the overwhelmingly common
 * cases (paths, hostnames, IDs, semver) without quoting noise.
 */
const BARE_SAFE_RE = /^[A-Za-z0-9_./@:+-]+$/;

/**
 * Serialize a resolved env map into dotenv lines, one `KEY=VALUE` per line.
 * Keys are emitted in sorted order so `lich env stack > .env.lich && git diff`
 * stays stable across runs. Each value is quoted only when it must be — see
 * {@link BARE_SAFE_RE}.
 *
 * Returns an array of lines (no trailing newline on individual entries).
 * Callers wanting a single string can `lines.join("\n")`.
 *
 * Exported for unit testing.
 */
export function serializeDotenv(env: Record<string, string>): string[] {
  const keys = Object.keys(env).sort();
  return keys.map((k) => `${k}=${formatValue(env[k])}`);
}

/**
 * Format a single value for dotenv emission. Empty string → bare `` (the
 * parser returns "" for empty unquoted values). Bare-safe → unquoted. Anything
 * else → double-quoted with escapes.
 *
 * Exported for unit testing of the quoting decisions.
 */
export function formatValue(value: string): string {
  if (value === "") return "";
  if (BARE_SAFE_RE.test(value)) return value;
  return `"${escapeDoubleQuoted(value)}"`;
}

/**
 * Escape a string for inclusion inside double-quoted dotenv. Mirrors the
 * parser's `unescapeDouble` in `env/shell-out.ts` so the output round-trips.
 *
 * Replacements (order matters — `\` must go first so we don't double-escape
 * subsequent insertions):
 *   `\` → `\\`,  `"` → `\"`,  `$` → `\$`,
 *   `\n` → `\n`, `\r` → `\r`, `\t` → `\t`.
 *
 * Other control characters (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F) are
 * passed through as their literal byte. The parser treats unknown sequences
 * inside double quotes as the literal next character, so round-trip is
 * preserved for the common case of "no control chars". Env values that
 * embed bytes like NUL or BEL are vanishingly rare in practice; if a real
 * config ships one we'll add explicit handling.
 */
function escapeDoubleQuoted(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "$":
        out += "\\$";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

