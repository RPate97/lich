/**
 * `lich env <group>` — print a named env_group as dotenv-format on stdout.
 *
 * Output round-trips through `env/shell-out.ts`'s `parseDotenv` — that's the
 * SLO so `source <(lich env stack)` works. See {@link serializeDotenv}.
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
import {
  resolveProfile,
  type ResolvedProfile,
} from "../profiles/resolve.js";

export interface EnvCmdOptions {
  /** First positional after `env`. Absent → usage + exit 2. */
  groupName?: string;
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  processEnv?: NodeJS.ProcessEnv;
}

export interface EnvCmdResult {
  exitCode: 0 | 1 | 2;
}

export async function runEnvCmd(
  opts: EnvCmdOptions = {},
): Promise<EnvCmdResult> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? ((s: string) => console.log(s));
  const err = opts.stderr ?? ((s: string) => console.error(s));

  if (!opts.groupName) {
    err("usage: lich env <group>");
    return { exitCode: 2 };
  }
  const groupName = opts.groupName;

  const yamlPath = join(cwd, "lich.yaml");
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      err(`lich: ${e.location}: ${e.message}`);
    }
    return { exitCode: 1 };
  }
  const config = parsed.config;

  let worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch (e) {
    err(`lich: ${(e as Error).message}`);
    return { exitCode: 1 };
  }

  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  const allocatedPorts: AllocatedPorts = snap
    ? rebuildAllocatedPorts(snap)
    : { compose: {}, owned: {} };

  // Drift-tolerant: if the recorded profile no longer resolves, fall back
  // to top-level-only env. Broken-yaml diagnosis flows through `lich validate`.
  let resolvedProfile: ResolvedProfile | undefined;
  if (snap?.active_profile && config.profiles?.[snap.active_profile]) {
    try {
      resolvedProfile = resolveProfile(snap.active_profile, config);
    } catch {
      resolvedProfile = undefined;
    }
  }

  let env: Record<string, string>;
  try {
    env = await resolveEnvGroup({
      name: groupName,
      config,
      worktree,
      allocatedPorts,
      projectRoot: worktree.path,
      processEnv: opts.processEnv ?? process.env,
      profile: resolvedProfile,
    });
  } catch (e) {
    if (e instanceof GroupResolveError || e instanceof GroupCycleError) {
      err(`lich: ${e.message}`);
    } else {
      err(`lich: ${(e as Error).message ?? String(e)}`);
    }
    return { exitCode: 1 };
  }

  const lines = serializeDotenv(env);
  for (const line of lines) {
    out(line);
  }
  return { exitCode: 0 };
}

/**
 * Conservative whitelist for "unquoted dotenv value that round-trips through
 * our parser". Anything not matching falls through to double-quoted.
 */
const BARE_SAFE_RE = /^[A-Za-z0-9_./@:+-]+$/;

/**
 * Serialize a resolved env map to sorted `KEY=VALUE` dotenv lines.
 * Exported for unit testing.
 */
export function serializeDotenv(env: Record<string, string>): string[] {
  const keys = Object.keys(env).sort();
  return keys.map((k) => `${k}=${formatValue(env[k])}`);
}

/** Format one value: empty → bare; bare-safe → unquoted; else double-quoted. */
export function formatValue(value: string): string {
  if (value === "") return "";
  if (BARE_SAFE_RE.test(value)) return value;
  return `"${escapeDoubleQuoted(value)}"`;
}

/**
 * Escape for inclusion inside double-quoted dotenv. Mirrors `unescapeDouble`
 * in `env/shell-out.ts` so the output round-trips. Order matters — `\` must
 * be escaped first so we don't double-escape subsequent insertions.
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

