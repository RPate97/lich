import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p14-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p14-home-')));
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LEVELZERO_HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('bin: plan-14 bootPlugins wiring end-to-end', () => {
  it('falls back to inline registrations when no levelzero.config.ts is present (init works)', () => {
    // No config at all — the worktree lookup returns null, so bootPlugins is
    // never called and we only get the inline registrations. `init` is one of
    // those, so the command should succeed and produce a config file.
    const res = run(['init']);
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { created: boolean; configPath: string };
    expect(parsed.created).toBe(true);
    expect(parsed.configPath).toBe(join(projectDir, 'levelzero.config.ts'));
  });

  it('falls back to inline registrations when config has no plugins[] (empty config)', () => {
    // Config present but no `plugins` — bootPlugins must NOT run (or must be a
    // no-op); inline registrations remain the only source. `stacks current`
    // (an inline command) should still resolve and run.
    writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
    const res = run(['stacks', 'current']);
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { path: string; running: boolean };
    expect(parsed.path).toBe(projectDir);
    expect(parsed.running).toBe(false);
  });

  it('boots plugins from config.plugins[] and dispatches a plugin-registered command', () => {
    // Project-local plugin file. The plugin contributes a single command;
    // when bootPlugins is wired into bin.ts the dispatcher must be able to
    // resolve and run it just like an inline command.
    const pluginPath = join(projectDir, 'lz-fixture-plugin.mjs');
    writeFileSync(
      pluginPath,
      `export default {
         name: 'fixture-plugin',
         version: '0.0.1',
         register(api) {
           api.addCommand({
             name: 'fixture.hello',
             describe: 'fixture command from a plugin',
             async run() {
               return { from: 'plugin', greeting: 'hello' };
             },
           });
         },
       };`,
      'utf8',
    );

    // Config declares the plugin by relative path. The loader resolves
    // relative paths against projectRoot.
    writeFileSync(
      join(projectDir, 'levelzero.config.ts'),
      `export default { plugins: ['./lz-fixture-plugin.mjs'] };`,
    );

    const res = run(['fixture', 'hello']);
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { from: string; greeting: string };
    expect(parsed.from).toBe('plugin');
    expect(parsed.greeting).toBe('hello');
  });

  it('inline commands remain available alongside plugin commands (transitional coexistence)', () => {
    // The whole point of the transitional wiring is that both sources of
    // registrations coexist. Declare a plugin that adds one command, then
    // verify an inline command (`stacks current`) still resolves and runs.
    const pluginPath = join(projectDir, 'lz-fixture-plugin.mjs');
    writeFileSync(
      pluginPath,
      `export default {
         name: 'fixture-plugin',
         version: '0.0.1',
         register(api) {
           api.addCommand({
             name: 'fixture.hello',
             describe: 'fixture command from a plugin',
             async run() { return { ok: true }; },
           });
         },
       };`,
      'utf8',
    );
    writeFileSync(
      join(projectDir, 'levelzero.config.ts'),
      `export default { plugins: ['./lz-fixture-plugin.mjs'] };`,
    );

    // Inline command still works.
    const inlineRes = run(['stacks', 'current']);
    expect(inlineRes.status, inlineRes.stderr).toBe(0);
    const inlineParsed = JSON.parse(inlineRes.stdout) as { running: boolean };
    expect(inlineParsed.running).toBe(false);

    // Plugin command still works.
    const pluginRes = run(['fixture', 'hello']);
    expect(pluginRes.status, pluginRes.stderr).toBe(0);
    const pluginParsed = JSON.parse(pluginRes.stdout) as { ok: boolean };
    expect(pluginParsed.ok).toBe(true);
  });
});
