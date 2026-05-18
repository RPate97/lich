import { describe, it, expect } from 'vitest';
import { defineConfig } from '../src/define-config';
import type { Plugin } from '../src/plugins/types';

// Plugin fixtures with explicit NS + SourceManifest so the typed branches of
// `envInjection` (named keys + importAll) accept the runtime test values.
const postgres: Plugin<'postgres', { named: 'url' | 'host'; bulk: false }> = {
  name: '@levelzero/plugin-postgres',
  version: '1.0.0',
  namespace: 'postgres',
  register() {
    // no-op
  },
};
const infisical: Plugin<'infisical', { bulk: true }> = {
  name: '@levelzero/plugin-infisical',
  version: '1.0.0',
  namespace: 'infisical',
  register() {
    // no-op
  },
};

describe('defineConfig — runtime behavior', () => {
  it('returns its argument unchanged (identity at runtime)', () => {
    const cfg = { plugins: [] as const, name: 'demo' };
    const result = defineConfig(cfg);
    // `defineConfig` is a no-op at runtime — same reference, not a copy.
    expect(result).toBe(cfg);
  });

  it('preserves all top-level fields verbatim', () => {
    const cfg = defineConfig({
      name: 'project',
      plugins: [postgres, infisical] as const,
      adapters: { orm: 'prisma' },
      envInjection: {
        DATABASE_URL: 'postgres.url',
        importAll: ['infisical'],
      },
    });
    expect(cfg.name).toBe('project');
    expect(cfg.adapters).toEqual({ orm: 'prisma' });
    expect(cfg.envInjection?.DATABASE_URL).toBe('postgres.url');
    expect(cfg.envInjection?.importAll).toEqual(['infisical']);
  });

  it('accepts an empty envInjection block', () => {
    const cfg = defineConfig({ plugins: [] as const, envInjection: {} });
    expect(cfg.envInjection).toEqual({});
  });

  it('accepts a real Plugin tuple at runtime', () => {
    const cfg = defineConfig({
      plugins: [postgres] as const,
      envInjection: { DATABASE_URL: 'postgres.url' },
    });
    expect(cfg.plugins[0]?.name).toBe('@levelzero/plugin-postgres');
  });
});
