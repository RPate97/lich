import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AdapterRegistry } from '../src/adapters/registry';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p13-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p13-home-')));
  // resolveStackContext walks up looking for lich.config.ts — provide one
  // so adapter swap (which requires being inside a project) succeeds.
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

interface ListEntry {
  slot: string;
  name: string;
  active: boolean;
}

describe('bin: plan-13 adapter commands end-to-end', () => {
  describe('adapter list', () => {
    it('exits 0 and returns JSON listing every known adapter with its slot', () => {
      const res = run(['adapter', 'list', '--json']);
      expect(res.status, res.stderr).toBe(0);

      const out = JSON.parse(res.stdout) as { adapters: ListEntry[] };
      expect(Array.isArray(out.adapters)).toBe(true);

      // After Plan 14 the built-in registry is empty — every slot is now
      // contributed by an extracted plugin and only appears in `adapter list`
      // when its plugin is declared in `lich.config.ts`:
      //   - orm         → @lich/plugin-prisma (LEV-149)
      //   - auth        → @lich/plugin-better-auth (LEV-152)
      //   - ui          → @lich/plugin-shadcn (LEV-153)
      //   - browser     → @lich/plugin-playwright (LEV-156)
      //   - backend     → @lich/plugin-hono (LEV-150)
      //   - frontend    → @lich/plugin-typed-client (LEV-151)
      //   - portless    → @lich/plugin-portless (LEV-145)
      //   - test-runner → @lich/plugin-vitest / @lich/plugin-playwright
      // With an empty config the list is empty. The next test covers the
      // loader path.
      const byKey = new Map(
        out.adapters.map((a) => [`${a.slot}:${a.name}`, a]),
      );

      // Extracted slots are absent with an empty config.
      expect(byKey.has('orm:prisma')).toBe(false);
      expect(byKey.has('auth:better-auth')).toBe(false);
      expect(byKey.has('ui:shadcn')).toBe(false);
      expect(byKey.has('browser:playwright')).toBe(false);
      expect(byKey.has('backend:hono')).toBe(false);
      expect(byKey.has('frontend:typed-client')).toBe(false);
      expect(byKey.get('portless:portless')).toBeUndefined();
      expect(byKey.get('portless:noop')).toBeUndefined();
      expect(out.adapters).toEqual([]);

      // All eight slot identifiers should be valid (i.e. anything listed must
      // belong to one of the eight). This guards against a slot being silently
      // renamed or dropped.
      const knownSlots = new Set([
        'orm',
        'auth',
        'ui',
        'browser',
        'backend',
        'frontend',
        'test-runner',
        'portless',
      ]);
      for (const a of out.adapters) {
        expect(knownSlots.has(a.slot)).toBe(true);
      }
    });

    it('surfaces plugin-contributed portless adapters when the plugin is declared in config (LEV-146)', () => {
      // Replace the empty config with one that loads the extracted plugin.
      // The loader resolves the npm specifier through Node's algorithm rooted
      // at the project — bun's workspace symlinks under `node_modules/@lich/`
      // make this resolve from any cwd within the workspace.
      writeFileSync(
        join(projectDir, 'lich.config.ts'),
        `export default { plugins: ['@lich/plugin-portless'] };`,
      );

      const res = run(['adapter', 'list', '--json']);
      expect(res.status, res.stderr).toBe(0);

      const out = JSON.parse(res.stdout) as { adapters: ListEntry[] };
      const byKey = new Map(
        out.adapters.map((a) => [`${a.slot}:${a.name}`, a]),
      );

      // Post-Plan-14 the merged registry contains only what the loaded
      // plugins contribute — portless adds two impls, neither of which the
      // empty built-in registry shadows. Both portless impls show up; `noop`
      // is active per the plugin's `setActiveAdapter('portless', 'noop')`
      // default.
      expect(byKey.get('portless:portless')?.active).toBe(false);
      expect(byKey.get('portless:noop')?.active).toBe(true);
      // No other slots leak in.
      expect(byKey.has('auth:better-auth')).toBe(false);
    });
  });

  describe('adapter swap', () => {
    it('writes .lich/adapter.json with the chosen {slot: name}', () => {
      // Post-LEV-149: orm/prisma is only present when `@lich/plugin-prisma`
      // is loaded. The swap command validates against the merged registry
      // (built-ins + plugin contributions) so without the plugin declared in
      // `lich.config.ts` the swap would fail with "unknown adapter slot
      // 'orm'".
      writeFileSync(
        join(projectDir, 'lich.config.ts'),
        `export default { plugins: ['@lich/plugin-prisma'] };`,
      );

      const res = run(['adapter', 'swap', 'orm', 'prisma', '--json']);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as {
        ok: boolean;
        slot: string;
        name: string;
        path: string;
      };
      expect(out.ok).toBe(true);
      expect(out.slot).toBe('orm');
      expect(out.name).toBe('prisma');

      const adapterJson = join(projectDir, '.lich', 'adapter.json');
      expect(existsSync(adapterJson)).toBe(true);
      expect(out.path).toBe(adapterJson);
      const parsed = JSON.parse(readFileSync(adapterJson, 'utf8'));
      expect(parsed).toEqual({ orm: 'prisma' });
    });

    it('errors with usage when slot/name missing', () => {
      const res = run(['adapter', 'swap', '--json']);
      expect(res.status).toBe(1);
      const err = JSON.parse(res.stderr);
      expect(err.message).toMatch(/slot/i);
    });
  });

  describe('plugin loader smoke', () => {
    it('loads a project-local custom plugin written to tmpdir', async () => {
      // Drop a tiny adapter module into the project so the loader has a real
      // file to dynamic-import. Backend shape (extractRoutes) is detected via
      // the shape sniffer in AdapterRegistry.loadCustomPlugins.
      const pluginRel = join('plugins', 'tiny-backend.mjs');
      mkdirSync(join(projectDir, 'plugins'), { recursive: true });
      writeFileSync(
        join(projectDir, pluginRel),
        `export default {
           name: 'tiny-backend',
           async extractRoutes() { return { generatedAt: '', routes: [] }; },
         };`,
        'utf8',
      );

      // Drive the loader directly (the CLI binary does not yet auto-load
      // project plugins from lich.config.ts — that wiring lands in a
      // later wave). The smoke check is: the loader resolves the file,
      // detects the slot, and registers the entry under that slot.
      const registry = new AdapterRegistry();
      await registry.loadCustomPlugins({
        projectRoot: projectDir,
        paths: { 'tiny-backend': pluginRel },
      });

      const backend = registry.listBySlot('backend');
      expect(backend).toHaveLength(1);
      expect(backend[0]!.name).toBe('tiny-backend');
    });
  });
});
