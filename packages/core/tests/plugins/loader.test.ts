import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin, loadPlugins } from '../../src/plugins/loader';
import type { PluginContext } from '../../src/plugins/types';

let projectRoot: string;
const ctx: PluginContext = { projectRoot: '', config: {} };

beforeAll(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lz-plugin-loader-')));
  ctx.projectRoot = projectRoot;
  mkdirSync(join(projectRoot, 'plugins'), { recursive: true });

  // Valid plugin exposed via `default` export.
  writeFileSync(
    join(projectRoot, 'plugins', 'default-export.mjs'),
    `export default {
  name: 'default-export',
  version: '1.0.0',
  register(_api, _ctx) {},
};
`,
  );

  // Valid plugin exposed via a named shorthand export matching the basename.
  writeFileSync(
    join(projectRoot, 'plugins', 'named-export.mjs'),
    `export const namedExport = {
  name: 'named-export',
  version: '2.0.0',
  register(_api, _ctx) {},
};
`,
  );

  // Valid plugin where the module itself is the Plugin shape (no default, no
  // shorthand match). Loader should fall back to `mod`.
  writeFileSync(
    join(projectRoot, 'plugins', 'module-shape.mjs'),
    `export const name = 'module-shape';
export const version = '3.0.0';
export function register(_api, _ctx) {}
`,
  );

  // Bad-shape plugin: present but missing `register`.
  writeFileSync(
    join(projectRoot, 'plugins', 'bad-shape.mjs'),
    `export default {
  name: 'bad-shape',
  version: '0.0.1',
};
`,
  );

  // Bad-shape plugin: missing `name`.
  writeFileSync(
    join(projectRoot, 'plugins', 'no-name.mjs'),
    `export default {
  version: '0.0.1',
  register() {},
};
`,
  );
});

afterAll(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

describe('loadPlugin — local path resolution', () => {
  it('loads a plugin via `default` export from a relative path', async () => {
    const plugin = await loadPlugin('./plugins/default-export.mjs', ctx);
    expect(plugin.name).toBe('default-export');
    expect(plugin.version).toBe('1.0.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('loads a plugin via a named shorthand export matching the basename', async () => {
    const plugin = await loadPlugin('./plugins/named-export.mjs', ctx);
    expect(plugin.name).toBe('named-export');
    expect(plugin.version).toBe('2.0.0');
  });

  it('loads a plugin where the module itself has the Plugin shape', async () => {
    const plugin = await loadPlugin('./plugins/module-shape.mjs', ctx);
    expect(plugin.name).toBe('module-shape');
    expect(plugin.version).toBe('3.0.0');
  });

  it('accepts an absolute path', async () => {
    const abs = join(projectRoot, 'plugins', 'default-export.mjs');
    const plugin = await loadPlugin(abs, ctx);
    expect(plugin.name).toBe('default-export');
  });
});

describe('loadPlugin — error paths', () => {
  it('throws with the specifier embedded when the file is missing', async () => {
    const spec = './plugins/does-not-exist.mjs';
    await expect(loadPlugin(spec, ctx)).rejects.toThrow(/does-not-exist\.mjs/);
  });

  it('throws with the specifier embedded when missing `register`', async () => {
    const spec = './plugins/bad-shape.mjs';
    await expect(loadPlugin(spec, ctx)).rejects.toThrow(/bad-shape\.mjs/);
  });

  it('throws with the specifier embedded when missing `name`', async () => {
    const spec = './plugins/no-name.mjs';
    await expect(loadPlugin(spec, ctx)).rejects.toThrow(/no-name\.mjs/);
  });

  it('throws with the specifier embedded for a missing npm package', async () => {
    const spec = '@levelzero/definitely-not-a-real-pkg-xyz';
    await expect(loadPlugin(spec, ctx)).rejects.toThrow(
      /@levelzero\/definitely-not-a-real-pkg-xyz/,
    );
  });
});

describe('loadPlugin — npm package resolution', () => {
  it('imports a bare specifier (mocked via a tmp node_modules entry)', async () => {
    // Place a fake npm package inside a tmp project's node_modules and load it
    // by its bare specifier — this exercises the non-path branch without
    // requiring a real npm install.
    const npmProject = realpathSync(mkdtempSync(join(tmpdir(), 'lz-plugin-npm-')));
    try {
      const pkgDir = join(npmProject, 'node_modules', 'fake-plugin');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'fake-plugin',
          version: '0.1.0',
          type: 'module',
          main: 'index.mjs',
        }),
      );
      writeFileSync(
        join(pkgDir, 'index.mjs'),
        `export default {
  name: 'fake-plugin',
  version: '0.1.0',
  register(_api, _ctx) {},
};
`,
      );

      const cwd = process.cwd();
      process.chdir(npmProject);
      try {
        const plugin = await loadPlugin('fake-plugin', { ...ctx, projectRoot: npmProject });
        expect(plugin.name).toBe('fake-plugin');
        expect(plugin.version).toBe('0.1.0');
      } finally {
        process.chdir(cwd);
      }
    } finally {
      rmSync(npmProject, { recursive: true, force: true });
    }
  });
});

describe('loadPlugins', () => {
  it('loads multiple plugins in order', async () => {
    const plugins = await loadPlugins(
      ['./plugins/default-export.mjs', './plugins/named-export.mjs'],
      ctx,
    );
    expect(plugins).toHaveLength(2);
    expect(plugins[0]!.name).toBe('default-export');
    expect(plugins[1]!.name).toBe('named-export');
  });

  it('propagates the failure (with specifier) when any plugin fails to load', async () => {
    await expect(
      loadPlugins(['./plugins/default-export.mjs', './plugins/missing.mjs'], ctx),
    ).rejects.toThrow(/missing\.mjs/);
  });

  it('returns an empty array for an empty input', async () => {
    const plugins = await loadPlugins([], ctx);
    expect(plugins).toEqual([]);
  });
});
