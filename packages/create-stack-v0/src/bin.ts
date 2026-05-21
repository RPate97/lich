#!/usr/bin/env bun
/**
 * `@levelzero/create-stack-v0` — the canonical entry point for starting a
 * fresh levelzero v0 project via `npx @levelzero/create-stack-v0 <name>`.
 *
 * This is a thin wrapper: it resolves the bundled v0 template path from
 * `@levelzero/template-v0-stack`, then hands it to `copyTemplate` from
 * `@levelzero/core`. The same helper powers `levelzero init <name>` so both
 * entry points produce byte-identical output for the same `<name>`.
 *
 * Out of scope (deliberate, see LEV-159):
 *   - Publishing to npm (Tier 7 / LEV-167).
 *   - Running `bun install` post-scaffold (kept here so the wrapper stays
 *     side-effect free; the printed next-steps tell users to run it).
 *   - Interactive prompts. `<name>` is positional and required.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { templateRoot } from '@levelzero/template-v0-stack';
import { scaffoldStackV0 } from './index';

/** Names must start with a letter and contain only letters, digits, hyphens. */
const NAME_RE = /^[a-z][a-z0-9-]*$/i;

function printHelp(): void {
  process.stdout.write(
    `Usage: npx @levelzero/create-stack-v0 <project-name> [--template-from <dir>]\n\n` +
      `Scaffolds a new levelzero v0 stack (postgres + prisma + hono + next + better-auth\n` +
      `+ shadcn + playwright + vitest) into ./<project-name>/.\n\n` +
      `Examples:\n` +
      `  npx @levelzero/create-stack-v0 my-app\n` +
      `  npx @levelzero/create-stack-v0 /absolute/path/my-app\n\n` +
      `Flags:\n` +
      `  --template-from <dir>  Override the bundled template root with an absolute\n` +
      `                         path. Intended for tests that need to pin the\n` +
      `                         template to a specific on-disk state (e.g.\n` +
      `                         worktree-local) rather than the node_modules-\n` +
      `                         resolved \`@levelzero/template-v0-stack\`. Production\n` +
      `                         users should not need this flag.\n`,
  );
}

/**
 * Walk up from `startDir` (exclusive) looking for any `package.json` that
 * declares a `workspaces` field. Returns the directory of the nearest such
 * package, or `null` if none found before hitting the filesystem root.
 *
 * Used to warn users (LEV-216) that scaffolding inside an existing monorepo
 * workspace can cause confusing dependency resolution issues — the scaffolded
 * project is typically expected to be standalone.
 */
function findMonorepoAncestor(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const pkgPath = join(current, 'package.json');
    try {
      const raw = readFileSync(pkgPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'workspaces' in parsed &&
        (parsed as { workspaces: unknown }).workspaces !== undefined
      ) {
        return current;
      }
    } catch {
      // No package.json here, or it's unreadable/unparseable — keep walking.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function printMonorepoWarning(ancestorDir: string): void {
  process.stdout.write(
    `\n⚠ Heads up: this directory is inside a monorepo workspace at ${ancestorDir}.\n` +
      `  Consider adding the new project to ${ancestorDir}'s workspaces array,\n` +
      `  or scaffold to a directory outside any monorepo.\n`,
  );
}

function printNextSteps(name: string, destDir: string): void {
  process.stdout.write(
    `\nScaffolded ${name} at ${destDir}\n\n` +
      `Next steps:\n` +
      `  cd ${name}\n` +
      `  bun install\n` +
      `  bun run levelzero dev\n`,
  );
}

/**
 * Parse `--template-from <dir>` (LEV-210) out of the raw argv tail and return
 * the override value plus the remaining positional args. Absent flag → null.
 *
 * Why a flag and not env: tests spawn the bin and a flag is self-documenting
 * in failure output; env would be invisible. Production users never need
 * this; the bundled template via `@levelzero/template-v0-stack` is correct.
 */
function extractTemplateFrom(args: string[]): {
  templateFrom: string | null;
  rest: string[];
  error: string | null;
} {
  const rest: string[] = [];
  let templateFrom: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--template-from') {
      const next = args[i + 1];
      if (next === undefined) {
        return { templateFrom: null, rest: [], error: '--template-from requires a directory argument' };
      }
      if (!isAbsolute(next)) {
        return {
          templateFrom: null,
          rest: [],
          error: `--template-from requires an absolute path, got: ${next}`,
        };
      }
      templateFrom = next;
      i++; // skip the value
    } else {
      rest.push(a);
    }
  }
  return { templateFrom, rest, error: null };
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0) {
    printHelp();
    return 1;
  }
  if (args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return 0;
  }

  const parsed = extractTemplateFrom(args);
  if (parsed.error !== null) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.rest.length === 0) {
    printHelp();
    return 1;
  }

  const arg = parsed.rest[0]!;
  // For an absolute path, validate the trailing directory name (which becomes
  // the project's `name` field). For a bare name, validate the whole thing.
  const projectName = isAbsolute(arg) ? basename(arg) : arg;
  if (!NAME_RE.test(projectName)) {
    process.stderr.write(
      `Invalid project name "${projectName}". Use letters, digits, and hyphens; ` +
        `must start with a letter.\n`,
    );
    return 1;
  }

  const destDir = isAbsolute(arg) ? arg : join(process.cwd(), arg);
  // LEV-210: `--template-from` lets tests pin the template root to an absolute
  // worktree path, bypassing the node_modules-resolved `@levelzero/template-v0-stack`
  // (which in a multi-worktree dev setup can route to a sibling worktree's
  // template). Absent the flag, behavior is unchanged: use the bundled root.
  const effectiveTemplateRoot = parsed.templateFrom ?? templateRoot;
  await scaffoldStackV0({ to: destDir, projectName, templateDir: effectiveTemplateRoot });

  // Defense in depth (LEV-216): warn if the scaffold lands inside another
  // monorepo, which historically caused confusing install/resolve issues.
  // Walk from the *parent* of destDir so we don't match our own freshly
  // scaffolded root.
  const ancestor = findMonorepoAncestor(dirname(destDir));
  if (ancestor !== null) {
    printMonorepoWarning(ancestor);
  }

  printNextSteps(projectName, destDir);
  return 0;
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  });
