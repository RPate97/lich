import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../src/errors';
import {
  genCommand,
  makeGenCommand,
  type GenListResult,
  type GenRunResult,
} from '../../src/commands/gen';
import { GeneratorRegistry } from '../../src/plugins/boot';
import { AdapterRegistry } from '../../src/adapters/registry';
import { EnvSourceRegistry } from '../../src/env/registry';
import type { Generator } from '../../src/gen/types';

interface RunCtxOpts {
  json?: boolean;
  flags?: Record<string, string | boolean>;
  cwd?: string;
}

function ctx(opts?: RunCtxOpts) {
  const flags: Record<string, string | boolean> = { ...(opts?.flags ?? {}) };
  if (opts?.json) flags['json'] = true;
  return {
    cwd: opts?.cwd ?? '/tmp/lz-gen-test',
    // LEV-168: pretty default, JSON opt-in via `--json` — matches the
    // shape `runCli`'s `pickFormat` produces.
    format: (opts?.json ? 'json' : 'pretty') as 'json' | 'pretty',
    args: [] as string[],
    flags,
  };
}

/** Build a registry populated with one or more generators. */
function registry(...gens: Generator[]): GeneratorRegistry {
  const r = new GeneratorRegistry();
  for (const g of gens) r.register(g);
  return r;
}

function stubGen(
  id: string,
  outcome:
    | { status: 'ok'; filesWritten?: string[]; message?: string }
    | { status: 'skip'; message: string }
    | { status: 'fail'; message: string }
    | { throws: string },
  describe = `${id} (stub)`,
): Generator {
  return {
    id,
    describe,
    async generate() {
      if ('throws' in outcome) throw new Error(outcome.throws);
      return outcome;
    },
  };
}

let projectDir: string;

beforeEach(() => {
  // A "real" project root so `resolveStackContext` finds a worktree. The
  // command resolves the worktree before any generator dispatch.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-gen-proj-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
});

describe('levelzero gen', () => {
  it('exports a top-level command named "gen"', () => {
    expect(genCommand.name).toBe('gen');
    expect(typeof genCommand.describe).toBe('string');
    expect(typeof genCommand.run).toBe('function');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-gen-outside-')));
    const cmd = makeGenCommand({
      getGeneratorRegistry: () => registry(stubGen('foo', { status: 'ok' })),
    });
    await expect(cmd.run(ctx({ cwd: outside }))).rejects.toThrow(CLIError);
  });

  describe('--list', () => {
    it('renders a friendly message when no generators are registered (pretty)', async () => {
      const cmd = makeGenCommand({ getGeneratorRegistry: () => new GeneratorRegistry() });
      const out = (await cmd.run(ctx({ flags: { list: true }, cwd: projectDir }))) as string;
      expect(out).toBe('no generators registered\n');
    });

    it('returns an empty generators array with --json when none are registered', async () => {
      const cmd = makeGenCommand({ getGeneratorRegistry: () => new GeneratorRegistry() });
      const out = (await cmd.run(
        ctx({ json: true, flags: { list: true }, cwd: projectDir }),
      )) as GenListResult;
      expect(out).toEqual({ generators: [] });
    });

    it('lists every registered generator sorted by id (--json)', async () => {
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry(
            stubGen('prisma', { status: 'ok' }, 'Run prisma generate'),
            stubGen('api-client', { status: 'ok' }, 'Typed API client'),
          ),
      });
      const out = (await cmd.run(
        ctx({ json: true, flags: { list: true }, cwd: projectDir }),
      )) as GenListResult;
      expect(out.generators).toEqual([
        { id: 'api-client', describe: 'Typed API client' },
        { id: 'prisma', describe: 'Run prisma generate' },
      ]);
    });

    it('--list does NOT invoke any generator', async () => {
      let called = false;
      const gen: Generator = {
        id: 'side-effect',
        describe: 'should not run',
        async generate() {
          called = true;
          return { status: 'ok' };
        },
      };
      const cmd = makeGenCommand({ getGeneratorRegistry: () => registry(gen) });
      await cmd.run(ctx({ flags: { list: true }, cwd: projectDir }));
      expect(called).toBe(false);
    });
  });

  describe('default invocation (no --only)', () => {
    it('runs every registered generator and returns per-id results (--json)', async () => {
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry(
            stubGen('a', { status: 'ok', filesWritten: ['/x/a.ts'] }),
            stubGen('b', { status: 'ok' }),
          ),
      });
      const out = (await cmd.run(ctx({ json: true, cwd: projectDir }))) as GenRunResult;
      expect(out.ok).toBe(2);
      expect(out.skipped).toBe(0);
      expect(out.failed).toBe(0);
      expect(out.results.map((r) => r.id)).toEqual(['a', 'b']);
      expect(out.results[0]?.filesWritten).toEqual(['/x/a.ts']);
    });

    it('renders pretty status table with per-id rows and a summary line', async () => {
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry(
            stubGen('api-client', { status: 'ok', filesWritten: ['/a.ts', '/b.ts'] }),
            stubGen('prisma', { status: 'skip', message: 'no schema' }),
          ),
      });
      const out = (await cmd.run(ctx({ cwd: projectDir }))) as string;
      expect(out).toContain('[OK] api-client (2 files)');
      expect(out).toContain('[SKIP] prisma: no schema');
      expect(out).toContain('gen: 1/2 ok (1 skipped)');
    });

    it('reports an empty run when no generators are registered (pretty)', async () => {
      const cmd = makeGenCommand({ getGeneratorRegistry: () => new GeneratorRegistry() });
      const out = (await cmd.run(ctx({ cwd: projectDir }))) as string;
      expect(out).toBe('no generators registered\n');
    });

    it('returns an empty zeroed run shape with --json when no generators are registered', async () => {
      const cmd = makeGenCommand({ getGeneratorRegistry: () => new GeneratorRegistry() });
      const out = (await cmd.run(ctx({ json: true, cwd: projectDir }))) as GenRunResult;
      expect(out).toEqual({ results: [], ok: 0, skipped: 0, failed: 0 });
    });

    it('captures a thrown error as status: "fail" without short-circuiting siblings', async () => {
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry(
            stubGen('boom', { throws: 'kaboom' }),
            stubGen('after', { status: 'ok' }),
          ),
      });
      // Failures escalate to a CLIError so the CLI driver returns non-zero
      // exit, but siblings still run before the throw.
      await expect(cmd.run(ctx({ json: true, cwd: projectDir }))).rejects.toThrow(CLIError);
      // Re-run with one good generator only to confirm the success path
      // doesn't escalate.
      const cmd2 = makeGenCommand({
        getGeneratorRegistry: () => registry(stubGen('after', { status: 'ok' })),
      });
      const out = (await cmd2.run(ctx({ json: true, cwd: projectDir }))) as GenRunResult;
      expect(out.failed).toBe(0);
    });

    it('embeds per-generator results in CLIError.details on failure', async () => {
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry(
            stubGen('a', { status: 'ok' }),
            stubGen('b', { status: 'fail', message: 'nope' }),
          ),
      });
      try {
        await cmd.run(ctx({ json: true, cwd: projectDir }));
        expect.fail('expected CLIError');
      } catch (err) {
        const e = err as CLIError;
        expect(e).toBeInstanceOf(CLIError);
        const details = e.details as GenRunResult & { pretty: string };
        expect(details.failed).toBe(1);
        expect(details.results.map((r) => r.status)).toEqual(['ok', 'fail']);
        expect(typeof details.pretty).toBe('string');
      }
    });
  });

  describe('--only', () => {
    it('runs only the listed ids (single id)', async () => {
      const calls: string[] = [];
      const trackingGen = (id: string): Generator => ({
        id,
        describe: id,
        async generate() {
          calls.push(id);
          return { status: 'ok' };
        },
      });
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry(trackingGen('a'), trackingGen('b'), trackingGen('c')),
      });
      const out = (await cmd.run(
        ctx({ json: true, flags: { only: 'b' }, cwd: projectDir }),
      )) as GenRunResult;
      expect(out.results.map((r) => r.id)).toEqual(['b']);
      expect(calls).toEqual(['b']);
    });

    it('runs only the listed ids (comma-separated, order-preserving)', async () => {
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry(stubGen('a', { status: 'ok' }), stubGen('b', { status: 'ok' })),
      });
      const out = (await cmd.run(
        ctx({ json: true, flags: { only: 'b,a' }, cwd: projectDir }),
      )) as GenRunResult;
      // `--only` preserves the user-supplied order so callers can drive
      // sequencing when a generator's output feeds another's input.
      expect(out.results.map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('errors CONFIG_INVALID on unknown id and surfaces the known ids in the hint', async () => {
      const cmd = makeGenCommand({
        getGeneratorRegistry: () => registry(stubGen('a', { status: 'ok' })),
      });
      try {
        await cmd.run(ctx({ flags: { only: 'doesnotexist' }, cwd: projectDir }));
        expect.fail('expected CLIError');
      } catch (err) {
        const e = err as CLIError;
        expect(e).toBeInstanceOf(CLIError);
        expect(e.code).toBe('CONFIG_INVALID');
        expect(e.message).toContain('doesnotexist');
        expect(e.hint).toContain('a');
      }
    });
  });

  describe('GeneratorContext threading', () => {
    it('passes projectRoot + flags + registries into Generator.generate', async () => {
      let captured: {
        projectRoot?: string;
        flagsKeys?: string[];
        envSources?: unknown;
        adapters?: unknown;
      } = {};
      const envSources = new EnvSourceRegistry();
      const adapters = new AdapterRegistry();
      const cmd = makeGenCommand({
        getGeneratorRegistry: () =>
          registry({
            id: 'inspector',
            describe: 'records ctx',
            async generate(c) {
              captured = {
                projectRoot: c.projectRoot,
                flagsKeys: Object.keys(c.flags),
                envSources: c.envSources,
                adapters: c.adapters,
              };
              return { status: 'ok' };
            },
          }),
        getEnvSourceRegistry: () => envSources,
        getAdapterRegistry: () => adapters,
      });

      await cmd.run(
        ctx({
          json: true,
          flags: { 'api-dir': 'apps/api', out: '/tmp/x' },
          cwd: projectDir,
        }),
      );

      expect(captured.projectRoot).toBe(projectDir);
      expect(captured.flagsKeys).toContain('api-dir');
      expect(captured.flagsKeys).toContain('out');
      // The exact same registry instances flow through (no copy / wrap).
      expect(captured.envSources).toBe(envSources);
      expect(captured.adapters).toBe(adapters);
    });
  });

  describe('standalone export (default wiring)', () => {
    it('falls back to "no generators registered" when no registry is wired', async () => {
      const out = (await genCommand.run(ctx({ cwd: projectDir }))) as string;
      expect(out).toBe('no generators registered\n');
    });
  });
});
