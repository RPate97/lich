import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
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
 * in `bin.ts` and reachable via the CLI.
 *
 * We deliberately do NOT spin up Postgres here: the live docker-backed flow is
 * covered by per-command tests, and the docker stacks are flaky in CI. The
 * assertion we care about for wiring is that the bin reaches the command's
 * own validation/stack-resolution logic (NO_PROJECT or CONFIG_INVALID) rather
 * than bouncing back UNKNOWN_COMMAND.
 */
describe('bin: plan-05 db.* commands end-to-end', () => {
  it('db migrate is registered (errors NO_PROJECT outside a project, not UNKNOWN_COMMAND)', () => {
    // Run from a tmp dir with no levelzero.config.ts so resolveStackContext
    // throws NO_PROJECT. UNKNOWN_COMMAND would mean the bin never reached
    // the command body at all.
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-out-')));
    const res = run(['db', 'migrate'], outsideDir);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });

  it('db migration new <name> is registered (errors NO_PROJECT outside a project, not UNKNOWN_COMMAND)', () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-out-')));
    // Pass a valid snake_case name so name-validation passes and we reach the
    // stack-resolution step — the failure mode we want to observe.
    const res = run(['db', 'migration', 'new', 'add_users'], outsideDir);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });

  it('db migration new without a name fails CONFIG_INVALID (command is wired and validates args)', () => {
    // Even without a project, a missing <name> trips the command's own
    // arg-validation before resolveStackContext — proving the command is
    // wired *and* its body executed.
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-out-')));
    const res = run(['db', 'migration', 'new'], outsideDir);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('db seed is registered (errors NO_PROJECT outside a project, not UNKNOWN_COMMAND)', () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-out-')));
    const res = run(['db', 'seed'], outsideDir);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });

  it('db inspect with no mode fails CONFIG_INVALID (command body reached, --schema/--rows required)', () => {
    // `db inspect` validates flags before stack lookup, so this proves the
    // command is wired without needing a project at all.
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-out-')));
    const res = run(['db', 'inspect'], outsideDir);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('db inspect --schema is registered (errors NO_PROJECT outside a project, not UNKNOWN_COMMAND)', () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p05-out-')));
    const res = run(['db', 'inspect', '--schema'], outsideDir);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    expect(err.code).toBe('NO_PROJECT');
  });
});
