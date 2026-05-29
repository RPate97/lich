/**
 * `lich init` — write a minimal commented yaml skeleton to cwd. No
 * auto-detection, no framework awareness. Refuses to overwrite without
 * `--force`. Adds `.lich/` to `.gitignore` (idempotent) unless `--no-gitignore`.
 */
import {
  accessSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

export const SKELETON_YAML = `# yaml-language-server: $schema=https://raw.githubusercontent.com/RPate97/lich/main/packages/lich/schema/v1.json
# The schema URL above resolves to the live JSON Schema for lich.yaml. IDEs
# with yaml-language-server (VS Code's YAML extension, IntelliJ, etc.) pick
# it up automatically and provide inline validation + autocomplete. The URL
# is currently served from the GitHub raw path; once lich.sh exists it will
# move to https://lich.sh/schema/v1.json.

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

const GITIGNORE_ENTRY = ".lich/";

export interface InitOptions {
  force?: boolean;
  noGitignore?: boolean;
}

export interface InitResult {
  exitCode: number;
  /** Stdout on success, stderr on failure. */
  messages: string[];
}

/** Async wrapper around {@link runInitSync} that prints messages itself. */
export async function runInit(
  options: InitOptions,
  cwd: string
): Promise<number> {
  const result = runInitSync(options, cwd);
  const sink = result.exitCode === 0 ? console.log : console.error;
  for (const line of result.messages) sink(line);
  return result.exitCode;
}

/** Performs file work and returns a structured result. Caller decides where to print. */
export function runInitSync(options: InitOptions, cwd: string): InitResult {
  const messages: string[] = [];
  const yamlPath = path.join(cwd, "lich.yaml");
  const gitignorePath = path.join(cwd, ".gitignore");

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
        break;
    }
  }

  messages.push(`next: edit lich.yaml for your stack, then \`lich validate\``);

  return { exitCode: 0, messages };
}

type GitignoreOutcome = "created" | "appended" | "already-present";

/**
 * Ensure `.lich/` appears as a line in `.gitignore`. Idempotent.
 * Does not handle negation (`!.lich/`) or glob-equivalent (`.lich`) patterns
 * — users with those can pass `--no-gitignore`.
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
