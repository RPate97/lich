import { describe, it, expect } from 'vitest';
import { bootPlugins } from '../../src/plugins/boot';
import type { LichConfig } from '../../src/config';
import type { Plugin } from '../../src/plugins/types';
import type { OwnedService } from '../../src/services/types';
import type { Rule } from '../../src/check/types';

const PROJECT_ROOT = '/tmp/lz-boot-test';

/** Trivial adapter object — registry doesn't introspect impl shape. */
const fakeOrm = { kind: 'fake-orm' };

/** Plugin that registers an `orm` adapter and marks it active. */
const adapterPlugin: Plugin = {
  name: 'fixture-adapter-plugin',
  version: '0.0.1',
  register(api) {
    api.addAdapter('orm', 'fake-orm', fakeOrm);
    api.setActiveAdapter('orm', 'fake-orm');
  },
};

/** Plugin that registers a single command. */
const commandPlugin: Plugin = {
  name: 'fixture-command-plugin',
  version: '0.0.1',
  register(api) {
    api.addCommand({
      name: 'fixture.hello',
      describe: 'fixture command',
      async run() {
        return 'ok';
      },
    });
  },
};

describe('bootPlugins', () => {
  it('returns empty registries when config has no plugins', async () => {
    const result = await bootPlugins({} as LichConfig, PROJECT_ROOT);
    expect(result.commands.all()).toEqual([]);
    expect(result.adapters.list()).toEqual([]);
    expect(result.generators.all()).toEqual([]);
    expect(result.rules.listAll()).toEqual([]);
    expect(result.ownedServices).toEqual([]);
    expect(result.compose).toEqual({ services: {}, volumes: {}, networks: {} });
    expect(result.skillsDirs).toEqual([]);
  });

  it('assembles contributions from two plugins (adapter + command)', async () => {
    const config: LichConfig = { plugins: [adapterPlugin, commandPlugin] };
    const result = await bootPlugins(config, PROJECT_ROOT);

    // adapter contribution landed and is active
    expect(result.adapters.listBySlot('orm')).toHaveLength(1);
    expect(result.adapters.get('orm', 'fake-orm')).toBe(fakeOrm);
    expect(result.adapters.getActive('orm')).toBe(fakeOrm);

    // command contribution landed
    expect(result.commands.all()).toHaveLength(1);
    expect(result.commands.lookup('fixture.hello')?.describe).toBe('fixture command');
  });

  it('respects plugin order: later setActiveAdapter wins (last-write-wins)', async () => {
    const aImpl = { kind: 'a' };
    const bImpl = { kind: 'b' };
    const pluginA: Plugin = {
      name: 'plugin-a',
      version: '0.0.1',
      register(api) {
        api.addAdapter('orm', 'a', aImpl);
        api.setActiveAdapter('orm', 'a');
      },
    };
    const pluginB: Plugin = {
      name: 'plugin-b',
      version: '0.0.1',
      register(api) {
        api.addAdapter('orm', 'b', bImpl);
        api.setActiveAdapter('orm', 'b');
      },
    };

    const result = await bootPlugins(
      { plugins: [pluginA, pluginB] },
      PROJECT_ROOT,
    );
    expect(result.adapters.getActive('orm')).toBe(bImpl);

    // Reverse order: A wins.
    const result2 = await bootPlugins(
      { plugins: [pluginB, pluginA] },
      PROJECT_ROOT,
    );
    expect(result2.adapters.getActive('orm')).toBe(aImpl);
  });

  it('runs plugin register() in declared order (observable via call order)', async () => {
    const calls: string[] = [];
    const p1: Plugin = {
      name: 'first',
      version: '0.0.1',
      async register() {
        calls.push('first');
      },
    };
    const p2: Plugin = {
      name: 'second',
      version: '0.0.1',
      async register() {
        calls.push('second');
      },
    };
    const p3: Plugin = {
      name: 'third',
      version: '0.0.1',
      async register() {
        calls.push('third');
      },
    };
    await bootPlugins({ plugins: [p1, p2, p3] }, PROJECT_ROOT);
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('accumulates contributions across the full PluginAPI surface', async () => {
    const rule: Rule = {
      id: 'fixture.rule',
      describe: 'fixture rule',
      async check() {
        return { status: 'pass' };
      },
    };
    const ownedService: OwnedService = {
      name: 'api',
      kind: 'owned',
      portNames: ['http'],
      cwd: 'apps/api',
      command: 'bun run dev',
      envContributions: () => ({}),
    };

    const kitchenSink: Plugin = {
      name: 'kitchen-sink',
      version: '0.0.1',
      register(api) {
        api.addRule(rule);
        api.addOwnedService(ownedService);
        api.addComposeService('postgres', { image: 'postgres:16-alpine' });
        api.addComposeVolume('pg-data', { driver: 'local' });
        api.addComposeNetwork('lz-net', { driver: 'bridge' });
        api.addGenerator({
          id: 'fixture.gen',
          describe: 'fixture generator',
          // LEV-124 tightened `Generator.generate` to return a structured
          // `GeneratorResult` (status + optional message/files). The fixture
          // returns a minimal `ok` shape — boot only cares that the
          // registration round-trips, not what `generate()` does.
          async generate() {
            return { status: 'ok' as const };
          },
        });
        api.addSkillsDir('/abs/path/to/skills');
      },
    };

    const result = await bootPlugins({ plugins: [kitchenSink] }, PROJECT_ROOT);

    expect(result.rules.listAll()).toHaveLength(1);
    expect(result.ownedServices).toEqual([ownedService]);
    expect(result.compose.services.postgres).toEqual({ image: 'postgres:16-alpine' });
    expect(result.compose.volumes['pg-data']).toEqual({ driver: 'local' });
    expect(result.compose.networks['lz-net']).toEqual({ driver: 'bridge' });
    expect(result.generators.all()).toHaveLength(1);
    expect(result.generators.lookup('fixture.gen')?.describe).toBe('fixture generator');
    expect(result.skillsDirs).toEqual(['/abs/path/to/skills']);
  });

  it('passes projectRoot + config into each plugin context', async () => {
    let seen: { projectRoot?: string; config?: unknown } = {};
    const inspector: Plugin = {
      name: 'inspector',
      version: '0.0.1',
      register(_api, ctx) {
        seen = { projectRoot: ctx.projectRoot, config: ctx.config };
      },
    };
    const config: LichConfig = { name: 'my-project', plugins: [inspector] };
    await bootPlugins(config, PROJECT_ROOT);
    expect(seen.projectRoot).toBe(PROJECT_ROOT);
    expect(seen.config).toBe(config);
  });

  it('unwraps a Promise<{ default: Plugin }> entry', async () => {
    const config: LichConfig = {
      plugins: [Promise.resolve({ default: commandPlugin })],
    };
    const result = await bootPlugins(config, PROJECT_ROOT);
    expect(result.commands.lookup('fixture.hello')?.describe).toBe('fixture command');
  });

  it('accepts a Promise<Plugin> entry directly', async () => {
    const config: LichConfig = {
      plugins: [Promise.resolve(adapterPlugin)],
    };
    const result = await bootPlugins(config, PROJECT_ROOT);
    expect(result.adapters.getActive('orm')).toBe(fakeOrm);
  });

  it('attaches plugin name to errors thrown during register()', async () => {
    const exploding: Plugin = {
      name: 'kaboom',
      version: '0.0.1',
      register() {
        throw new Error('boom inside register');
      },
    };
    await expect(bootPlugins({ plugins: [exploding] }, PROJECT_ROOT)).rejects.toThrow(
      /kaboom.*boom inside register/,
    );
  });

  it('rejects a Promise entry that resolves to something other than a Plugin', async () => {
    const config: LichConfig = {
      // Cast: this is exactly the misuse the runtime check is for.
      plugins: [Promise.resolve({ not: 'a plugin' }) as unknown as Promise<Plugin>],
    };
    await expect(bootPlugins(config, PROJECT_ROOT)).rejects.toThrow(/plugins\[0\]/);
  });
});
