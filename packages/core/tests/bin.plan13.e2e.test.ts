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
  // resolveStackContext walks up looking for levelzero.config.ts — provide one
  // so adapter swap (which requires being inside a project) succeeds.
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LEVELZERO_HOME: homeDir },
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
      const res = run(['adapter', 'list']);
      expect(res.status, res.stderr).toBe(0);

      const out = JSON.parse(res.stdout) as { adapters: ListEntry[] };
      expect(Array.isArray(out.adapters)).toBe(true);

      // The four built-in impls cover four of the eight declared AdapterSlot
      // values (orm, auth, ui, browser). The other four slots
      // (backend, frontend, test-runner, portless) are reserved but have no
      // active impl yet, so they simply do not appear in the list output.
      const byKey = new Map(
        out.adapters.map((a) => [`${a.slot}:${a.name}`, a]),
      );
      expect(byKey.get('orm:prisma')?.active).toBe(true);
      expect(byKey.get('auth:better-auth')?.active).toBe(true);
      expect(byKey.get('ui:shadcn')?.active).toBe(true);
      expect(byKey.get('browser:playwright')?.active).toBe(true);

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
  });

  describe('adapter swap', () => {
    it('writes .levelzero/adapter.json with the chosen {slot: name}', () => {
      const res = run(['adapter', 'swap', 'orm', 'prisma']);
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

      const adapterJson = join(projectDir, '.levelzero', 'adapter.json');
      expect(existsSync(adapterJson)).toBe(true);
      expect(out.path).toBe(adapterJson);
      const parsed = JSON.parse(readFileSync(adapterJson, 'utf8'));
      expect(parsed).toEqual({ orm: 'prisma' });
    });

    it('errors with usage when slot/name missing', () => {
      const res = run(['adapter', 'swap']);
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
      // project plugins from levelzero.config.ts — that wiring lands in a
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
