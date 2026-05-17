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

  it('loads the real `@levelzero/plugin-portless` package by npm specifier (LEV-146)', () => {
    // End-to-end proof that the plugin loader path works with an *actually
    // extracted* plugin — not just a tmpdir fixture. Declares the real
    // workspace package in `levelzero.config.ts`, then runs `adapter list`
    // and asserts the plugin's `register()` populated the `portless` slot
    // with both impls and selected `noop` as the active one.
    //
    // Why the cwd is the project tmpdir but the import still resolves: the
    // bin script under test lives inside the monorepo; the loader's
    // `createRequire` falls back to dynamic import for bare specifiers, and
    // bun's workspace symlinks under the script's `node_modules/@levelzero/`
    // satisfy that import. Catches regressions in (a) the loader's
    // npm-specifier path, (b) the merge of plugin adapters into the
    // built-in registry, and (c) the plugin's own `register()` shape.
    writeFileSync(
      join(projectDir, 'levelzero.config.ts'),
      `export default { plugins: ['@levelzero/plugin-portless'] };`,
    );

    const res = run(['adapter', 'list']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      adapters: Array<{ slot: string; name: string; active: boolean }>;
    };
    const byKey = new Map(out.adapters.map((a) => [`${a.slot}:${a.name}`, a]));
    expect(byKey.get('portless:portless')).toBeDefined();
    expect(byKey.get('portless:portless')!.active).toBe(false);
    expect(byKey.get('portless:noop')).toBeDefined();
    expect(byKey.get('portless:noop')!.active).toBe(true);
    // The portless plugin doesn't touch the orm slot, and post-LEV-149
    // prisma is contributed by `@levelzero/plugin-prisma` rather than
    // builtins — so loading only the portless plugin leaves orm absent.
    expect(byKey.has('orm:prisma')).toBe(false);
    // Built-in slots not touched by the plugin remain intact.
    expect(byKey.get('auth:better-auth')?.active).toBe(true);
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
