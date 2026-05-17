import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  Plugin,
  PluginAPI,
  PluginContext,
  ComposeServiceDef,
  ComposeVolumeDef,
  ComposeNetworkDef,
} from '../../src/plugins/types';
import type { AdapterSlot } from '../../src/adapters/registry';
import type { Command } from '../../src/commands/types';
import type { OwnedService } from '../../src/services/types';
import type { Rule } from '../../src/check/types';

describe('Plugin contract types', () => {
  it('ComposeServiceDef accepts an image-only service', () => {
    const def: ComposeServiceDef = { image: 'postgres:16-alpine' };
    expect(def.image).toBe('postgres:16-alpine');
  });

  it('ComposeServiceDef accepts a build string or build object', () => {
    const a: ComposeServiceDef = { build: './api' };
    const b: ComposeServiceDef = { build: { context: './api', dockerfile: 'Dockerfile.dev' } };
    expect(a.build).toBe('./api');
    expect(typeof b.build === 'object' && b.build.context).toBe('./api');
  });

  it('ComposeServiceDef accepts ports, env, volumes, depends_on, healthcheck', () => {
    const def: ComposeServiceDef = {
      image: 'postgres:16-alpine',
      ports: ['${PORT}:5432'],
      environment: { POSTGRES_PASSWORD: 'pw' },
      volumes: ['data:/var/lib/postgresql/data'],
      depends_on: { migrator: { condition: 'service_healthy' } },
      healthcheck: {
        test: ['CMD', 'pg_isready', '-U', 'postgres'],
        interval: '5s',
        timeout: '3s',
        retries: 20,
        start_period: '2s',
      },
    };
    expect(def.ports?.[0]).toBe('${PORT}:5432');
    expect(def.depends_on?.migrator?.condition).toBe('service_healthy');
    expect(def.healthcheck?.retries).toBe(20);
  });

  it('ComposeVolumeDef carries driver + driver_opts', () => {
    const v: ComposeVolumeDef = { driver: 'local', driver_opts: { type: 'tmpfs' } };
    expect(v.driver).toBe('local');
    expect(v.driver_opts?.type).toBe('tmpfs');
  });

  it('ComposeNetworkDef carries driver', () => {
    const n: ComposeNetworkDef = { driver: 'bridge' };
    expect(n.driver).toBe('bridge');
  });

  it('PluginContext carries projectRoot + config', () => {
    const ctx: PluginContext = { projectRoot: '/abs/path', config: {} };
    expect(ctx.projectRoot).toBe('/abs/path');
  });

  it('Plugin has name, version, register function', () => {
    const p: Plugin = {
      name: 'demo',
      version: '0.0.1',
      register: (_api, _ctx) => {
        // no-op
      },
    };
    expect(p.name).toBe('demo');
    expect(p.version).toBe('0.0.1');
    expect(typeof p.register).toBe('function');
  });

  it('Plugin.register may return a Promise', () => {
    const p: Plugin = {
      name: 'demo-async',
      version: '0.0.1',
      register: async (_api, _ctx) => {
        await Promise.resolve();
      },
    };
    expect(p.name).toBe('demo-async');
  });

  it('PluginAPI exposes the expected method surface', () => {
    expectTypeOf<PluginAPI>().toMatchTypeOf<{
      addAdapter(slot: AdapterSlot, name: string, impl: unknown): void;
      setActiveAdapter(slot: AdapterSlot, name: string): void;
      addCommand(cmd: Command): void;
      addOwnedService(service: OwnedService): void;
      addComposeService(name: string, def: ComposeServiceDef): void;
      addComposeVolume(name: string, def: ComposeVolumeDef): void;
      addComposeNetwork(name: string, def: ComposeNetworkDef): void;
      addRule(rule: Rule): void;
      addSkillsDir(absPath: string): void;
    }>();
  });
});
