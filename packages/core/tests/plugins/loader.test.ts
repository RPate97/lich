import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlugin,
  loadPlugins,
  resolvePluginEntry,
  deriveNamespace,
} from '../../src/plugins/loader';
import type { Plugin, PluginContext } from '../../src/plugins/types';

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

  // Plugin default-exported as a zero-arg factory (Plan 16 / LEV-186 shape).
  // `loadPlugin` must invoke it and unwrap to the returned Plugin.
  writeFileSync(
    join(projectRoot, 'plugins', 'factory-default.mjs'),
    `export default function makePlugin() {
  return {
    name: 'factory-default',
    version: '4.0.0',
    register(_api, _ctx) {},
  };
}
`,
  );

  // Async factory variant — the resolver must await it.
  writeFileSync(
    join(projectRoot, 'plugins', 'async-factory.mjs'),
    `export default async function makePlugin() {
  return {
    name: 'async-factory',
    version: '5.0.0',
    register(_api, _ctx) {},
  };
}
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

  // LEV-186: v0 plugins are factories. The string-specifier path needs to
  // invoke a factory default export and unwrap to the produced Plugin so
  // existing `plugins: ['@levelzero/plugin-x']` configs keep working after
  // the conversion.
  it('invokes a factory default export and unwraps the returned Plugin', async () => {
    const plugin = await loadPlugin('./plugins/factory-default.mjs', ctx);
    expect(plugin.name).toBe('factory-default');
    expect(plugin.version).toBe('4.0.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('awaits an async factory default export', async () => {
    const plugin = await loadPlugin('./plugins/async-factory.mjs', ctx);
    expect(plugin.name).toBe('async-factory');
    expect(plugin.version).toBe('5.0.0');
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

describe('deriveNamespace', () => {
  it('strips the @scope/plugin- prefix from a scoped package name', () => {
    expect(deriveNamespace('@levelzero/plugin-postgres')).toBe('postgres');
    expect(deriveNamespace('@my-org/plugin-foo')).toBe('foo');
  });

  it('strips a bare plugin- prefix from an unscoped package name', () => {
    expect(deriveNamespace('plugin-bar')).toBe('bar');
  });

  it('preserves digits and hyphens inside the namespace tail', () => {
    expect(deriveNamespace('@levelzero/plugin-typed-client')).toBe('typed-client');
    expect(deriveNamespace('plugin-redis-7')).toBe('redis-7');
  });

  it('returns the package name unchanged when no plugin- prefix matches', () => {
    expect(deriveNamespace('whatever-else')).toBe('whatever-else');
    expect(deriveNamespace('@levelzero/core')).toBe('@levelzero/core');
  });
});

describe('resolvePluginEntry', () => {
  /** Minimal valid plugin reused across the resolver cases. */
  const samplePlugin: Plugin = {
    name: '@levelzero/plugin-sample',
    version: '0.0.1',
    register() {},
  };

  it('returns a pre-built Plugin object as-is', async () => {
    const out = await resolvePluginEntry(samplePlugin, ctx, 0);
    expect(out).toBe(samplePlugin);
  });

  it('invokes a sync factory and uses its return value', async () => {
    let calls = 0;
    const factory = (): Plugin => {
      calls++;
      return { name: 'factory-sync', version: '1.0.0', register() {} };
    };
    const out = await resolvePluginEntry(factory, ctx, 0);
    expect(calls).toBe(1);
    expect(out.name).toBe('factory-sync');
  });

  it('awaits an async factory and uses its resolved value', async () => {
    const factory = async (): Promise<Plugin> => ({
      name: 'factory-async',
      version: '2.0.0',
      register() {},
    });
    const out = await resolvePluginEntry(factory, ctx, 0);
    expect(out.name).toBe('factory-async');
    expect(out.version).toBe('2.0.0');
  });

  it('auto-derives the namespace for a scoped plugin package when omitted', async () => {
    const factory = (): Plugin => ({
      name: '@levelzero/plugin-postgres',
      version: '0.0.1',
      register() {},
    });
    const out = await resolvePluginEntry(factory, ctx, 0);
    expect(out.namespace).toBe('postgres');
  });

  it('keeps an explicit `namespace` field over the auto-derived one', async () => {
    const factory = (): Plugin => ({
      name: '@levelzero/plugin-postgres',
      namespace: 'pg',
      version: '0.0.1',
      register() {},
    });
    const out = await resolvePluginEntry(factory, ctx, 0);
    expect(out.namespace).toBe('pg');
  });

  it('auto-derives the namespace on plain Plugin entries too', async () => {
    const plugin: Plugin = {
      name: '@levelzero/plugin-foo',
      version: '0.0.1',
      register() {},
    };
    const out = await resolvePluginEntry(plugin, ctx, 0);
    expect(out.namespace).toBe('foo');
  });

  it('unwraps a Promise resolving to { default: Plugin }', async () => {
    const entry = Promise.resolve({ default: samplePlugin });
    const out = await resolvePluginEntry(entry, ctx, 0);
    expect(out).toBe(samplePlugin);
  });

  it('throws with the array index when a factory returns garbage', async () => {
    const badFactory = (): unknown => ({ not: 'a plugin' });
    await expect(
      resolvePluginEntry(badFactory as () => Plugin, ctx, 3),
    ).rejects.toThrow(/plugins\[3\]/);
  });

  it('throws with the array index when a factory itself throws', async () => {
    const exploding = (): Plugin => {
      throw new Error('boom in factory');
    };
    await expect(resolvePluginEntry(exploding, ctx, 2)).rejects.toThrow(
      /plugins\[2\].*boom in factory/,
    );
  });

  it('routes a string entry through loadPlugin', async () => {
    const out = await resolvePluginEntry('./plugins/default-export.mjs', ctx, 0);
    expect(out.name).toBe('default-export');
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
