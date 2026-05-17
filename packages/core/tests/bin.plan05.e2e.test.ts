import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-home-')));
  // Wire `@levelzero/plugin-prisma` so the bin's dispatcher registers the
  // db.* commands. Post-LEV-149 they live in the plugin, not inline in
  // bin.ts, so the test's expectations (commands resolve past
  // UNKNOWN_COMMAND) only hold when the plugin is declared.
  writeFileSync(
    join(projectDir, 'levelzero.config.ts'),
    `export default { plugins: ['@levelzero/plugin-prisma'] };\n`,
  );
});

function run(args: string[], cwd: string = projectDir) {
  return spawnSync('bun', [BIN, ...args], {
    cwd,
    env: { ...process.env, LEVELZERO_HOME: homeDir },
    encoding: 'utf8',
  });
}

/**
 * Plan-05 (db.*) end-to-end: prove each of the four db subcommands —
 * `db migrate`, `db migration new`, `db seed`, `db inspect` — is registered
 * in `bin.ts` and reachable via the CLI when `@levelzero/plugin-prisma` is
 * declared in the project config (LEV-149 moved them out of core's inline
 * registrations).
 *
 * We deliberately do NOT spin up Postgres here: the live docker-backed flow is
 * covered by per-command tests, and the docker stacks are flaky in CI. The
 * assertion we care about for wiring is that the bin reaches the command's
 * own validation/stack-resolution logic (NO_PROJECT or CONFIG_INVALID) rather
 * than bouncing back UNKNOWN_COMMAND.
 */
describe('bin: plan-05 db.* commands end-to-end', () => {
  it('db migrate is registered when plugin-prisma is configured (errors NO_PROJECT, not UNKNOWN_COMMAND)', () => {
    const res = run(['db', 'migrate']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });

  it('db migration new <name> is registered (errors NO_PROJECT, not UNKNOWN_COMMAND)', () => {
    // Pass a valid snake_case name so name-validation passes and we reach the
    // stack-resolution step — the failure mode we want to observe.
    const res = run(['db', 'migration', 'new', 'add_users']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });

  it('db migration new without a name fails CONFIG_INVALID (command is wired and validates args)', () => {
    // A missing <name> trips the command's own arg-validation before
    // resolveStackContext — proving the command is wired *and* its body executed.
    const res = run(['db', 'migration', 'new']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('db seed is registered (errors NO_PROJECT, not UNKNOWN_COMMAND)', () => {
    const res = run(['db', 'seed']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });

  it('db inspect with no mode fails CONFIG_INVALID (command body reached, --schema/--rows required)', () => {
    // `db inspect` validates flags before stack lookup, so this proves the
    // command is wired regardless of project state.
    const res = run(['db', 'inspect']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('db inspect --schema is registered (errors NO_PROJECT, not UNKNOWN_COMMAND)', () => {
    const res = run(['db', 'inspect', '--schema']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });

  it('db migrate is NOT registered when the plugin is absent from the config (UNKNOWN_COMMAND)', () => {
    // Sanity check: extraction means the command only appears when the
    // plugin is declared. With no plugin in the config, the dispatcher
    // should fall back to bare `buildCommands()` — UNKNOWN_COMMAND.
    const bareDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-bare-')));
    writeFileSync(join(bareDir, 'levelzero.config.ts'), 'export default {};');
    const res = run(['db', 'migrate'], bareDir);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).toBe('UNKNOWN_COMMAND');
  });
});
