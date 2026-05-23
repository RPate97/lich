import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterSlot,
  BulkEnvSource,
  Command,
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  EnvSource,
  EnvSourceContext,
  PluginAPI,
  PluginContext,
} from '@lich/core';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from '../src/index';

/**
 * Recording `PluginAPI` for the dotenv plugin. The plugin registers a single
 * bulk source — every other surface is spied so an accidental new
 * contribution would be caught by the "does not contribute" assertions
 * rather than silently passing.
 */
function makeRecordingApi(): {
  api: PluginAPI<'dotenv'>;
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
  envSources: Record<string, EnvSource>;
  bulk: BulkEnvSource[];
  adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }>;
  actives: Array<{ slot: AdapterSlot; name: string }>;
  commands: Command[];
} {
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const envSources: Record<string, EnvSource> = {};
  const bulk: BulkEnvSource[] = [];
  const adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }> = [];
  const actives: Array<{ slot: AdapterSlot; name: string }> = [];
  const commands: Command[] = [];
  const api: PluginAPI<'dotenv'> = {
    addAdapter: (slot, name, impl) => {
      adapters.push({ slot, name, impl });
    },
    setActiveAdapter: (slot, name) => {
      actives.push({ slot, name });
    },
    addCommand: (cmd) => {
      commands.push(cmd);
    },
    addOwnedService: vi.fn(),
    addComposeService: (name, def) => {
      services[name] = def;
    },
    addComposeVolume: (name, def) => {
      volumes[name] = def;
    },
    addComposeNetwork: (name, def) => {
      networks[name] = def;
    },
    addRule: vi.fn(),
    addGenerator: vi.fn(),
    addSkillsDir: vi.fn(),
    addEnvSource: (name, source) => {
      envSources[name] = source;
    },
    addBulkEnvSource: (source) => {
      bulk.push(source);
    },
  };
  return {
    api,
    services,
    volumes,
    networks,
    envSources,
    bulk,
    adapters,
    actives,
    commands,
  };
}

/**
 * `EnvSourceContext` with sane defaults; tests override `projectRoot` per case.
 * The dotenv resolver only consults `projectRoot`, but we set the other fields
 * to plausible values to catch any accidental coupling.
 */
function makeCtx(overrides: Partial<EnvSourceContext> = {}): EnvSourceContext {
  return {
    ports: {},
    projectRoot: '/nonexistent',
    worktreeKey: 'abc12345',
    consumerContext: 'host',
    ...overrides,
  };
}

/**
 * Allocate a fresh temp project root for each test that touches the disk.
 * Returning both the path and a `writeFile(rel, body)` helper keeps the test
 * bodies free of `join` boilerplate.
 */
function makeTempProject(): {
  root: string;
  writeFile: (rel: string, body: string) => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'plugin-dotenv-test-'));
  return {
    root,
    writeFile: (rel, body) => {
      const abs = join(root, rel);
      // Support nested paths like `subdir/.env` by ensuring the parent exists.
      const slash = abs.lastIndexOf('/');
      if (slash > 0) mkdirSync(abs.slice(0, slash), { recursive: true });
      writeFileSync(abs, body);
    },
  };
}

/**
 * Snapshot `process.env`, mutate it for a test, then restore in `afterEach`.
 * `process.env` is shared across tests; mutating it without restoration would
 * leak state into siblings (especially the precedence-ordering tests).
 */
const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv };
});
afterEach(() => {
  process.env = originalEnv;
});

/**
 * Drive the plugin to register, then return the single registered bulk source.
 * Throws if the plugin failed to register exactly one bulk source — that's
 * the load-bearing invariant for this whole package.
 */
async function bootAndGetBulk(plugin = dotenv()): Promise<BulkEnvSource> {
  const { api, bulk } = makeRecordingApi();
  const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
  await plugin.register(api, ctx);
  expect(bulk).toHaveLength(1);
  return bulk[0]!;
}

describe('@lich/plugin-dotenv factory (LEV-188)', () => {
  it('produces a Plugin with the canonical name + namespace + version', () => {
    const plugin = dotenv();
    expect(plugin.name).toBe('@lich/plugin-dotenv');
    expect(plugin.namespace).toBe('dotenv');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('honors an explicit namespace override', () => {
    const plugin = dotenv({ namespace: 'secrets' });
    expect(plugin.namespace).toBe('secrets');
  });

  it('registers exactly one bulk source and no named sources', async () => {
    const { api, services, envSources, bulk, volumes, networks } =
      makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await dotenv().register(api, ctx);

    expect(bulk).toHaveLength(1);
    expect(Object.keys(envSources)).toEqual([]);
    expect(Object.keys(services)).toEqual([]);
    expect(Object.keys(volumes)).toEqual([]);
    expect(Object.keys(networks)).toEqual([]);
  });

  it('does not contribute adapters, commands, owned/compose services, etc.', async () => {
    const { api, adapters, actives, commands } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await dotenv().register(api, ctx);

    expect(adapters).toEqual([]);
    expect(actives).toEqual([]);
    expect(commands).toEqual([]);
  });
});

describe('@lich/plugin-dotenv file loading', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
    // Default test isolation: disable process.env passthrough so file
    // assertions aren't polluted by ambient host vars. Tests that exercise
    // the process.env path build their own dotenv() instance.
    process.env = {};
  });

  afterEach(() => {
    rmSync(project.root, { recursive: true, force: true });
  });

  it('loads keys from the default `.env.local` resolved against projectRoot', async () => {
    project.writeFile('.env.local', 'FOO=bar\nBAZ=qux\n');
    const bulk = await bootAndGetBulk(dotenv({ fromProcessEnv: false }));
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('honors a custom `files` list', async () => {
    project.writeFile('.env', 'A=1\nB=2\n');
    project.writeFile('.env.test', 'C=3\n');
    const bulk = await bootAndGetBulk(
      dotenv({ files: ['.env', '.env.test'], fromProcessEnv: false }),
    );
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('silently skips files that do not exist', async () => {
    // No files created — `.env.local` does not exist.
    const bulk = await bootAndGetBulk(dotenv({ fromProcessEnv: false }));
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out).toEqual({});
  });

  it('mixes existing + missing files without throwing', async () => {
    project.writeFile('.env', 'PRESENT=yes\n');
    const bulk = await bootAndGetBulk(
      dotenv({
        files: ['.env', '.env.missing', '.env.also-missing'],
        fromProcessEnv: false,
      }),
    );
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out).toEqual({ PRESENT: 'yes' });
  });
});

describe('@lich/plugin-dotenv precedence', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
    process.env = {};
  });

  afterEach(() => {
    rmSync(project.root, { recursive: true, force: true });
  });

  it('lets later files in the list override earlier ones', async () => {
    project.writeFile('.env', 'KEY=from-env\nDEFAULT=base\n');
    project.writeFile('.env.local', 'KEY=from-local\n');
    const bulk = await bootAndGetBulk(
      dotenv({ files: ['.env', '.env.local'], fromProcessEnv: false }),
    );
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    // `.env.local` is listed second → its value wins for KEY; DEFAULT
    // survives untouched from `.env`.
    expect(out).toEqual({ KEY: 'from-local', DEFAULT: 'base' });
  });

  it('lets process.env override file values when enabled', async () => {
    project.writeFile('.env.local', 'API_KEY=from-file\nLEFT=alone\n');
    process.env.API_KEY = 'from-shell';
    const bulk = await bootAndGetBulk(dotenv()); // fromProcessEnv defaults to true
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out.API_KEY).toBe('from-shell');
    expect(out.LEFT).toBe('alone');
  });

  it('keeps file values intact when process.env passthrough is disabled', async () => {
    project.writeFile('.env.local', 'API_KEY=from-file\n');
    process.env.API_KEY = 'from-shell';
    const bulk = await bootAndGetBulk(dotenv({ fromProcessEnv: false }));
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    // Load-bearing: the shell value MUST NOT leak in when explicitly
    // disabled — that's the deterministic-resolver promise.
    expect(out.API_KEY).toBe('from-file');
  });
});

describe('@lich/plugin-dotenv process.env passthrough', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
    process.env = {};
  });

  afterEach(() => {
    rmSync(project.root, { recursive: true, force: true });
  });

  it('passes process.env through when there are no files at all', async () => {
    process.env.ONLY_FROM_SHELL = 'yes';
    const bulk = await bootAndGetBulk(dotenv());
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out.ONLY_FROM_SHELL).toBe('yes');
  });

  it('respects an explicit allowlist (`processEnvKeys: [FOO, BAR]`)', async () => {
    process.env.FOO = '1';
    process.env.BAR = '2';
    process.env.SECRET = 'should-not-leak';
    const bulk = await bootAndGetBulk(
      dotenv({ processEnvKeys: ['FOO', 'BAR'] }),
    );
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out).toEqual({ FOO: '1', BAR: '2' });
    expect(out.SECRET).toBeUndefined();
  });

  it("treats the literal '*' as 'pass everything through'", async () => {
    process.env.A = 'one';
    process.env.B = 'two';
    const bulk = await bootAndGetBulk(dotenv({ processEnvKeys: '*' }));
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out.A).toBe('one');
    expect(out.B).toBe('two');
  });

  it('skips undefined process.env entries (defensive, type-driven)', async () => {
    // Directly assigning `undefined` on `process.env` is unusual but legal;
    // make sure the loop doesn't fall over and doesn't emit the key.
    process.env.MAYBE = undefined as unknown as string;
    const bulk = await bootAndGetBulk(dotenv());
    const out = await bulk.resolve(makeCtx({ projectRoot: project.root }));
    expect(out.MAYBE).toBeUndefined();
  });
});

describe('@lich/plugin-dotenv worktree safety', () => {
  let project: ReturnType<typeof makeTempProject>;
  let worktree: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
    worktree = makeTempProject();
    process.env = {};
  });

  afterEach(() => {
    rmSync(project.root, { recursive: true, force: true });
    rmSync(worktree.root, { recursive: true, force: true });
  });

  it('reads from ctx.projectRoot regardless of where the worktree lives', async () => {
    // The "parent repo" has the real .env.local with the secret.
    project.writeFile('.env.local', 'MY_SECRET=from-project-root\n');
    // The worktree checkout (e.g. `/tmp/lich-worktrees/...`) carries a
    // DIFFERENT .env.local. If the resolver mistakenly used the worktree
    // path it would pick this one up.
    worktree.writeFile('.env.local', 'MY_SECRET=from-worktree\n');

    // Production behavior: `findWorktree` resolves `projectRoot` to the
    // parent repo even when the agent is running inside the worktree
    // checkout. Simulate that by passing the project path as
    // `ctx.projectRoot` (vitest workers forbid `process.chdir`, so we
    // assert against the context directly — which is what the runtime
    // actually consults anyway).
    const bulk = await bootAndGetBulk(dotenv({ fromProcessEnv: false }));
    const fromProject = await bulk.resolve(
      makeCtx({ projectRoot: project.root }),
    );
    const fromWorktree = await bulk.resolve(
      makeCtx({ projectRoot: worktree.root }),
    );

    // Load-bearing: when ctx.projectRoot is the parent repo, the parent's
    // `.env.local` wins. A regression here would cause two worktrees of
    // the same project to disagree on which secrets are in scope.
    expect(fromProject.MY_SECRET).toBe('from-project-root');

    // Sanity check that the worktree directory really does have a
    // different file — if both reads returned the same value, the test
    // would only catch the trivial "both paths point to the same root"
    // failure mode. With this assertion we know the resolver is genuinely
    // honoring the path it was handed.
    expect(fromWorktree.MY_SECRET).toBe('from-worktree');
  });
});
