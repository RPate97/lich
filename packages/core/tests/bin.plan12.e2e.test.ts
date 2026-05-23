import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { templateRoot } from '@lich/template-v0-stack';
import { copyTemplate } from '../src/scaffolder';

const BIN = join(__dirname, '..', 'src', 'bin.ts');
const TEMPLATE_DIR = templateRoot;

/**
 * The 13 skills shipped with the v0-stack template — 3 workflow + 10
 * reference. The plan-12 acceptance criterion requires every one of them to
 * appear in the generated CLAUDE.md index after `lich skills index`
 * runs against a freshly scaffolded project.
 */
const EXPECTED_WORKFLOW_SKILLS = ['change', 'debug', 'onboard'] as const;
const EXPECTED_REFERENCE_SKILLS = [
  'better-auth',
  'hono',
  'lich-cli',
  'next',
  'playwright',
  'prisma',
  'shadcn',
  'tailwind',
  'turbo',
  'vitest',
] as const;
const EXPECTED_SKILL_COUNT =
  EXPECTED_WORKFLOW_SKILLS.length + EXPECTED_REFERENCE_SKILLS.length;

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p12-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p12-home-')));
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('bin: plan-12 skills index end-to-end', () => {
  it('initializes a fresh project from the template, runs `skills index`, and writes a CLAUDE.md with both section headers and all 13 skills', async () => {
    // Scaffold the project from the canonical template tree. copyTemplate
    // walks the same files an end user would receive via `lich init`,
    // so the generated CLAUDE.md is exactly what they'd see.
    const result = await copyTemplate({
      from: TEMPLATE_DIR,
      to: projectDir,
      vars: { projectName: 'plan12-e2e' },
    });

    // Sanity: the template must have shipped the 13 skill source files plus
    // the lich.config.ts that resolveStackContext walks up looking for.
    expect(result.files).toContain('lich.config.ts');
    const skillFiles = result.files.filter(
      (f) =>
        f.startsWith('.lich/skills/workflow/') ||
        f.startsWith('.lich/skills/reference/'),
    );
    expect(skillFiles).toHaveLength(EXPECTED_SKILL_COUNT);

    // Run the command the user would run. Pass `--json` to parse the result
    // (LEV-168 made pretty text the default).
    const res = run(['skills', 'index', '--json']);
    expect(res.status, res.stderr).toBe(0);

    const parsed = JSON.parse(res.stdout) as {
      skillCount: number;
      outputPath: string;
    };
    expect(parsed.skillCount).toBe(EXPECTED_SKILL_COUNT);

    const claudeMdPath = join(projectDir, 'CLAUDE.md');
    expect(parsed.outputPath).toBe(claudeMdPath);
    expect(existsSync(claudeMdPath)).toBe(true);

    const contents = readFileSync(claudeMdPath, 'utf8');

    // Both section headers must be present — the acceptance criterion calls
    // them out explicitly because an empty workflow or reference set would
    // silently drop the corresponding header.
    expect(contents).toContain('## Workflow Skills');
    expect(contents).toContain('## Reference Skills');

    // Every skill must appear as a `- **<name>** —` list entry. Anchoring on
    // the bullet+bold form guards against false positives from substring
    // matches in the surrounding prose.
    for (const name of EXPECTED_WORKFLOW_SKILLS) {
      expect(contents).toContain(`- **${name}** —`);
    }
    for (const name of EXPECTED_REFERENCE_SKILLS) {
      expect(contents).toContain(`- **${name}** —`);
    }
  });
});
