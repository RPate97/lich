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
import { basename, isAbsolute, join } from 'node:path';
import { templateRoot } from '@levelzero/template-v0-stack';
import { scaffoldStackV0 } from './index';

/** Names must start with a letter and contain only letters, digits, hyphens. */
const NAME_RE = /^[a-z][a-z0-9-]*$/i;

function printHelp(): void {
  process.stdout.write(
    `Usage: npx @levelzero/create-stack-v0 <project-name>\n\n` +
      `Scaffolds a new levelzero v0 stack (postgres + prisma + hono + next + better-auth\n` +
      `+ shadcn + playwright + vitest) into ./<project-name>/.\n\n` +
      `Examples:\n` +
      `  npx @levelzero/create-stack-v0 my-app\n` +
      `  npx @levelzero/create-stack-v0 /absolute/path/my-app\n`,
  );
}

function printNextSteps(name: string, destDir: string): void {
  process.stdout.write(
    `\nScaffolded ${name} at ${destDir}\n\n` +
      `Next steps:\n` +
      `  cd ${name}\n` +
      `  bun install\n` +
      `  bun run dev\n`,
  );
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

  const arg = args[0]!;
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
  await scaffoldStackV0({ to: destDir, projectName, templateDir: templateRoot });
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
