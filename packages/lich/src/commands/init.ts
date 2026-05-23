/**
 * `lich init` — write a heavily-commented yaml skeleton to cwd.
 *
 * Per spec section 7 (onramp), `lich init` is intentionally dumb:
 *   - No auto-detection.
 *   - No framework awareness.
 *   - Same minimal-but-valid yaml every time.
 *
 * The skeleton has every section commented out except `version: "1"`, which
 * is the only required field per the v1 schema. The user (or the
 * `lich:instrument` agent skill in Plan 6) fills in the rest.
 *
 * Side effects:
 *   - Writes `lich.yaml` to cwd. Refuses to overwrite unless `--force`.
 *   - Adds `.lich/` to `.gitignore` (creates the file if missing). Skipped
 *     when `--no-gitignore` is passed. Idempotent — never duplicates the
 *     entry.
 *
 * Implementation uses synchronous fs so the operation can be driven from
 * either the sync CLI dispatch path (`packages/lich/src/bin/lich.ts`) or an
 * async caller (e.g. tests via `runInit`) with the same core logic.
 */
import {
  accessSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// The skeleton content. Lives as a module-level constant so tests can import
// it if they want to assert on substrings.
// ---------------------------------------------------------------------------

export const SKELETON_YAML = `# yaml-language-server: $schema=https://lich.dev/schema/v1.json
# TODO: schema URL is not hosted yet (Plan 6 will publish it).
# See docs/superpowers/specs/2026-05-23-lich-v1-design.md for the schema.

version: "1"

# Container services managed by docker compose (or podman/nerdctl).
# services:
#   db:
#     compose_file: ./docker-compose.yml
#     service: db                   # name in the compose file
#     ports:
#       postgres:
#         container: 5432

# Host processes managed by lich directly.
# owned:
#   web:
#     cmd: pnpm dev
#     cwd: ./apps/web
#     port: { env: PORT }
#     env:
#       NODE_ENV: development
#     ready_when:
#       http_get: http://localhost:\${owned.web.port}

# Environment shared by every service. Per-service env can override.
# env:
#   LOG_LEVEL: info

# env_files:
#   - .env.local

# env_from:
#   - infisical run --command "printenv"

# Top-level lifecycle hooks (run for the whole stack).
# lifecycle:
#   before_up:
#     - echo "starting up"
#   after_up:
#     - echo "stack ready"
#   before_down:
#     - echo "tearing down"

# Runtime knobs. Defaults shown.
# runtime:
#   compose_cli: docker      # docker | podman | nerdctl (autodetected if omitted)
#   port_range: [9000, 9999] # range to allocate from
#   proxy_port: 3300         # friendly-URL reverse proxy port (Plan 5)
`;

// The line we append to (or create) .gitignore.
const GITIGNORE_ENTRY = ".lich/";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Overwrite an existing lich.yaml. Default: false. */
  force?: boolean;
  /** Skip the .gitignore mutation entirely. Default: false. */
  noGitignore?: boolean;
}

export interface InitResult {
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Lines to print to stdout (success path) or stderr (failure path). */
  messages: string[];
}

/**
 * Run `lich init` against `cwd`. Returns the process exit code; the function
 * itself prints messages along the way (success → stdout, failure → stderr).
 *
 * Async signature for API ergonomics — the underlying fs ops are sync so
 * the work is always complete before this resolves.
 */
export async function runInit(
  options: InitOptions,
  cwd: string
): Promise<number> {
  const result = runInitSync(options, cwd);
  const sink = result.exitCode === 0 ? console.log : console.error;
  for (const line of result.messages) sink(line);
  return result.exitCode;
}

/**
 * Sync core. Performs the file work and returns a structured result. Pure
 * w.r.t. console — caller decides where to print. Used by both `runInit`
 * (the async API) and the CLI dispatch table.
 */
export function runInitSync(options: InitOptions, cwd: string): InitResult {
  const messages: string[] = [];
  const yamlPath = path.join(cwd, "lich.yaml");
  const gitignorePath = path.join(cwd, ".gitignore");

  // ---- lich.yaml --------------------------------------------------------
  const yamlExists = pathExistsSync(yamlPath);
  if (yamlExists && !options.force) {
    return {
      exitCode: 1,
      messages: [`lich.yaml already exists in this directory`],
    };
  }

  writeFileSync(yamlPath, SKELETON_YAML, "utf8");
  if (yamlExists && options.force) {
    messages.push(`! overwrote existing lich.yaml (--force)`);
  } else {
    messages.push(`✓ wrote lich.yaml`);
  }

  // ---- .gitignore -------------------------------------------------------
  if (!options.noGitignore) {
    const outcome = ensureGitignoreEntrySync(gitignorePath);
    switch (outcome) {
      case "created":
        messages.push(`✓ created .gitignore with .lich/`);
        break;
      case "appended":
        messages.push(`✓ added .lich/ to .gitignore`);
        break;
      case "already-present":
        // Silent: nothing changed, no need to report.
        break;
    }
  }

  // ---- next-steps hint --------------------------------------------------
  messages.push(`next: edit lich.yaml for your stack, then \`lich validate\``);

  return { exitCode: 0, messages };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type GitignoreOutcome = "created" | "appended" | "already-present";

/**
 * Ensure `.lich/` appears as a line in the .gitignore at `gitignorePath`.
 *
 *   - file doesn't exist        → create with just `.lich/\n`
 *   - file exists, no match     → append `.lich/\n` (preserves prior
 *                                  contents; inserts a separating newline if
 *                                  the existing file didn't end with one)
 *   - file exists, has match    → no-op
 *
 * "match" = a non-comment line equal to `.lich/` after stripping surrounding
 * whitespace. We intentionally don't try to handle negation (`!.lich/`) or
 * glob-equivalent patterns (`.lich`); users with those can pass
 * `--no-gitignore`.
 */
function ensureGitignoreEntrySync(gitignorePath: string): GitignoreOutcome {
  let existing: string | null = null;
  try {
    existing = readFileSync(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = null;
  }

  if (existing === null) {
    writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`, "utf8");
    return "created";
  }

  if (hasGitignoreEntry(existing, GITIGNORE_ENTRY)) {
    return "already-present";
  }

  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(gitignorePath, `${sep}${GITIGNORE_ENTRY}\n`, "utf8");
  return "appended";
}

/** Does `contents` already contain a non-comment line equal to `entry`? */
export function hasGitignoreEntry(contents: string, entry: string): boolean {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line === entry) return true;
  }
  return false;
}

function pathExistsSync(p: string): boolean {
  try {
    accessSync(p);
    return true;
  } catch {
    return false;
  }
}
