> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../../specs/2026-05-23-lich-v1-design.md` for the current spec and `../../plans/2026-05-23-lich-v1-plan-0-foundation.md` for the current plan. See `./README.md` in this directory for context.

---

# lich CLI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `lich` CLI binary with config loading, worktree-key detection from `cwd`, machine-local registry management, structured output, a command framework, and the first set of registry-only commands (`init`, `stacks current`, `stacks list`, `stacks prune`, `doctor`).

**Architecture:** A Bun-runtime TypeScript CLI under `tools/cli/`. Single binary `lich`. Commands are registered objects implementing a `Command` interface. Every command auto-resolves a "stack context" from cwd by walking up looking for `lich.config.ts` (its parent directory is the worktree root; the SHA-256 of its canonical path is the worktree key). A JSON registry at `~/.lich/registry.json` is the source of truth for what stacks are tracked. No Docker, no services running yet — that's plan 02.

**Tech Stack:** Bun, TypeScript, Vitest, Node `node:fs`/`node:crypto`/`node:path` (work identically under Bun).

---

## File structure

```
tools/cli/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    bin.ts                       # entry point — minimal shim
    cli.ts                       # parse argv, dispatch to command, format output
    errors.ts                    # CLIError class + error codes
    output.ts                    # JSON + pretty formatters
    worktree.ts                  # walk up cwd; compute key; load config
    config.ts                    # load lich.config.ts via dynamic import
    registry.ts                  # read/write ~/.lich/registry.json
    commands/
      types.ts                   # Command + CommandContext interfaces
      registry.ts                # register/lookup commands
      init.ts                    # lich init
      doctor.ts                  # lich doctor
      stacks/
        current.ts
        list.ts
        prune.ts
  tests/
    worktree.test.ts
    config.test.ts
    registry.test.ts
    output.test.ts
    commands/
      init.test.ts
      stacks-current.test.ts
      stacks-list.test.ts
      stacks-prune.test.ts
      doctor.test.ts
```

Each file has one responsibility. Tests sit beside the module under `tests/` mirroring source layout.

---

### Task 1: Package skeleton

**Files:**
- Create: `tools/cli/package.json`
- Create: `tools/cli/tsconfig.json`
- Create: `tools/cli/vitest.config.ts`
- Create: `tools/cli/src/bin.ts`
- Create: `tools/cli/tests/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

```ts
// tools/cli/tests/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('package skeleton', () => {
  it('exports a placeholder version constant', async () => {
    const mod = await import('../src/bin');
    expect(mod.VERSION).toBe('0.0.0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/smoke.test.ts`
Expected: FAIL (`Cannot find module '../src/bin'`).

- [ ] **Step 3: Create package files**

```json
// tools/cli/package.json
{
  "name": "@lich/cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "lich": "./src/bin.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.12.0"
  }
}
```

```json
// tools/cli/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["bun-types", "node"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

```ts
// tools/cli/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

```ts
// tools/cli/src/bin.ts
export const VERSION = '0.0.0';
```

- [ ] **Step 4: Install and run test to verify it passes**

Run: `cd tools/cli && bun install && bunx vitest run tests/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/
git commit -m "feat(cli): package skeleton with vitest"
```

---

### Task 2: Worktree detection and key

**Files:**
- Create: `tools/cli/src/worktree.ts`
- Create: `tools/cli/tests/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/worktree.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWorktree, computeWorktreeKey } from '../src/worktree';

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-wt-')));
});

describe('findWorktree', () => {
  it('returns null when no lich.config.ts is found above cwd', async () => {
    const result = await findWorktree(tmp);
    expect(result).toBeNull();
  });

  it('finds the config when it is directly in cwd', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const result = await findWorktree(tmp);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(tmp);
    expect(result!.configPath).toBe(join(tmp, 'lich.config.ts'));
  });

  it('walks up the directory tree to find the config', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const nested = join(tmp, 'apps', 'web', 'src');
    mkdirSync(nested, { recursive: true });
    const result = await findWorktree(nested);
    expect(result!.path).toBe(tmp);
  });
});

describe('computeWorktreeKey', () => {
  it('produces a 12-char hex key from a path', () => {
    const key = computeWorktreeKey('/Users/x/projects/foo');
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });

  it('produces the same key for the same path twice', () => {
    expect(computeWorktreeKey('/a/b/c')).toBe(computeWorktreeKey('/a/b/c'));
  });

  it('produces different keys for different paths', () => {
    expect(computeWorktreeKey('/a/b/c')).not.toBe(computeWorktreeKey('/a/b/d'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/worktree.test.ts`
Expected: FAIL (`Cannot find module '../src/worktree'`).

- [ ] **Step 3: Implement worktree detection**

```ts
// tools/cli/src/worktree.ts
import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Worktree {
  path: string;          // canonical absolute path of the worktree root
  configPath: string;    // absolute path to lich.config.ts
  key: string;           // 12-char hex sha256
}

const CONFIG_FILENAME = 'lich.config.ts';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function findWorktree(startDir: string): Promise<Worktree | null> {
  let current = await realpath(startDir);
  while (true) {
    const candidate = join(current, CONFIG_FILENAME);
    if (await exists(candidate)) {
      const root = await realpath(current);
      return {
        path: root,
        configPath: candidate,
        key: computeWorktreeKey(root),
      };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function computeWorktreeKey(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/worktree.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/worktree.ts tools/cli/tests/worktree.test.ts
git commit -m "feat(cli): worktree detection and key derivation"
```

---

### Task 3: Config loading

**Files:**
- Create: `tools/cli/src/config.ts`
- Create: `tools/cli/tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/config.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-cfg-')));
});

describe('loadConfig', () => {
  it('loads an empty config', async () => {
    const path = join(tmp, 'lich.config.ts');
    writeFileSync(path, 'export default {};');
    const cfg = await loadConfig(path);
    expect(cfg).toEqual({});
  });

  it('loads a config with a name field', async () => {
    const path = join(tmp, 'lich.config.ts');
    writeFileSync(path, 'export default { name: "myapp" };');
    const cfg = await loadConfig(path);
    expect(cfg.name).toBe('myapp');
  });

  it('throws a useful error when config has no default export', async () => {
    const path = join(tmp, 'lich.config.ts');
    writeFileSync(path, 'export const foo = 1;');
    await expect(loadConfig(path)).rejects.toThrow(/default export/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/config.test.ts`
Expected: FAIL (`Cannot find module '../src/config'`).

- [ ] **Step 3: Implement config loading**

```ts
// tools/cli/src/config.ts
export interface LichConfig {
  name?: string;
  // Adapter slots and services land in later plans. Keep this surface
  // minimal in plan 01 — every later plan extends it via module
  // declaration merging or interface extension.
}

export async function loadConfig(configPath: string): Promise<LichConfig> {
  // Dynamic import works under Bun for .ts files natively. Use a cache-busting
  // query so successive loads in a single process pick up edits during tests.
  const url = `file://${configPath}?t=${Date.now()}`;
  const mod = (await import(url)) as { default?: LichConfig };
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(
      `lich config at ${configPath} has no default export (expected: \`export default { ... }\`)`,
    );
  }
  return mod.default;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/config.ts tools/cli/tests/config.test.ts
git commit -m "feat(cli): config loading via dynamic import"
```

---

### Task 4: Registry

**Files:**
- Create: `tools/cli/src/registry.ts`
- Create: `tools/cli/tests/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/registry';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-reg-')));
});

describe('Registry', () => {
  it('returns an empty registry when the file does not exist', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    const data = await reg.read();
    expect(data).toEqual({ stacks: {} });
  });

  it('persists upsert via atomic rename', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    await reg.upsert('abc123', {
      path: '/some/path',
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '',
      createdAt: '2026-05-16T00:00:00Z',
    });
    expect(existsSync(join(tmp, 'registry.json'))).toBe(true);
    const data = await reg.read();
    expect(data.stacks['abc123']!.path).toBe('/some/path');
  });

  it('remove() deletes a stack entry', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    await reg.upsert('k1', {
      path: '/p', branch: 'b', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    await reg.remove('k1');
    const data = await reg.read();
    expect(data.stacks['k1']).toBeUndefined();
  });

  it('list() returns all entries', async () => {
    const reg = new Registry(join(tmp, 'registry.json'));
    await reg.upsert('k1', {
      path: '/a', branch: 'a', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    await reg.upsert('k2', {
      path: '/b', branch: 'b', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    const entries = await reg.list();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.key).sort()).toEqual(['k1', 'k2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/registry.test.ts`
Expected: FAIL (`Cannot find module '../src/registry'`).

- [ ] **Step 3: Implement the registry**

```ts
// tools/cli/src/registry.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StackEntry {
  path: string;
  branch: string;
  ports: Record<string, number>;
  urls: Record<string, string>;
  containers: string[];
  network: string;
  logDir: string;
  createdAt: string;
}

export interface RegistryData {
  stacks: Record<string, StackEntry>;
}

const EMPTY: RegistryData = { stacks: {} };

export class Registry {
  constructor(private readonly path: string) {}

  async read(): Promise<RegistryData> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RegistryData;
      if (!parsed.stacks || typeof parsed.stacks !== 'object') return { stacks: {} };
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
      throw err;
    }
  }

  async upsert(key: string, entry: StackEntry): Promise<void> {
    const data = await this.read();
    data.stacks[key] = entry;
    await this.write(data);
  }

  async remove(key: string): Promise<void> {
    const data = await this.read();
    delete data.stacks[key];
    await this.write(data);
  }

  async list(): Promise<Array<{ key: string; entry: StackEntry }>> {
    const data = await this.read();
    return Object.entries(data.stacks).map(([key, entry]) => ({ key, entry }));
  }

  async get(key: string): Promise<StackEntry | undefined> {
    const data = await this.read();
    return data.stacks[key];
  }

  private async write(data: RegistryData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, this.path);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/registry.ts tools/cli/tests/registry.test.ts
git commit -m "feat(cli): registry with atomic-rename persistence"
```

---

### Task 5: Output formatting

**Files:**
- Create: `tools/cli/src/output.ts`
- Create: `tools/cli/tests/output.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/output.test.ts
import { describe, it, expect } from 'vitest';
import { formatOutput } from '../src/output';

describe('formatOutput', () => {
  it('emits JSON when format is json', () => {
    expect(formatOutput({ ok: true, n: 1 }, 'json')).toBe('{"ok":true,"n":1}');
  });

  it('emits pretty JSON when format is pretty and value is an object', () => {
    const out = formatOutput({ a: 1 }, 'pretty');
    expect(out).toContain('"a": 1');
    expect(out.includes('\n')).toBe(true);
  });

  it('emits a string as-is when format is pretty and value is a string', () => {
    expect(formatOutput('hello', 'pretty')).toBe('hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/output.test.ts`
Expected: FAIL (`Cannot find module '../src/output'`).

- [ ] **Step 3: Implement output formatting**

```ts
// tools/cli/src/output.ts
export type OutputFormat = 'json' | 'pretty';

export function formatOutput(value: unknown, format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/output.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/output.ts tools/cli/tests/output.test.ts
git commit -m "feat(cli): JSON and pretty output formatters"
```

---

### Task 6: Errors + command framework

**Files:**
- Create: `tools/cli/src/errors.ts`
- Create: `tools/cli/src/commands/types.ts`
- Create: `tools/cli/src/commands/registry.ts`
- Create: `tools/cli/src/cli.ts`
- Create: `tools/cli/tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/cli.test.ts
import { describe, it, expect } from 'vitest';
import { runCli } from '../src/cli';
import type { Command } from '../src/commands/types';
import { CommandRegistry } from '../src/commands/registry';
import { CLIError } from '../src/errors';

function makeRegistry(commands: Command[]): CommandRegistry {
  const reg = new CommandRegistry();
  for (const c of commands) reg.register(c);
  return reg;
}

describe('runCli', () => {
  it('dispatches to a top-level command and prints its result as JSON by default', async () => {
    const echo: Command = {
      name: 'echo',
      describe: 'echo back',
      run: async () => ({ said: 'hi' }),
    };
    const out = await runCli(['echo'], makeRegistry([echo]), { cwd: '/' });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('{"said":"hi"}');
  });

  it('honors --pretty', async () => {
    const echo: Command = {
      name: 'echo',
      describe: 'echo back',
      run: async () => ({ said: 'hi' }),
    };
    const out = await runCli(['echo', '--pretty'], makeRegistry([echo]), { cwd: '/' });
    expect(out.stdout).toContain('"said": "hi"');
    expect(out.stdout.includes('\n')).toBe(true);
  });

  it('supports nested command names with dots: stacks.current', async () => {
    const cur: Command = {
      name: 'stacks.current',
      describe: 'current',
      run: async () => ({ stack: 'x' }),
    };
    const out = await runCli(['stacks', 'current'], makeRegistry([cur]), { cwd: '/' });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).stack).toBe('x');
  });

  it('returns a structured error when the command is unknown', async () => {
    const out = await runCli(['nope'], makeRegistry([]), { cwd: '/' });
    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stderr);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
  });

  it('renders a CLIError raised by a command', async () => {
    const bad: Command = {
      name: 'bad',
      describe: 'bad',
      run: async () => {
        throw new CLIError('NO_PROJECT', 'not inside a lich project');
      },
    };
    const out = await runCli(['bad'], makeRegistry([bad]), { cwd: '/' });
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stderr).code).toBe('NO_PROJECT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/cli.test.ts`
Expected: FAIL (cannot find modules).

- [ ] **Step 3: Implement errors, command types, registry, and runCli**

```ts
// tools/cli/src/errors.ts
export type CLIErrorCode =
  | 'UNKNOWN_COMMAND'
  | 'NO_PROJECT'
  | 'CONFIG_INVALID'
  | 'REGISTRY_CORRUPT'
  | 'INTERNAL';

export class CLIError extends Error {
  constructor(public readonly code: CLIErrorCode, message: string, public readonly hint?: string) {
    super(message);
    this.name = 'CLIError';
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint ?? null };
  }
}
```

```ts
// tools/cli/src/commands/types.ts
import type { OutputFormat } from '../output';

export interface CommandContext {
  cwd: string;
  format: OutputFormat;
  args: string[];
  flags: Record<string, string | boolean>;
}

export interface Command {
  /** Dot-separated name, e.g. "stacks.current". */
  name: string;
  describe: string;
  run(ctx: CommandContext): Promise<unknown>;
}
```

```ts
// tools/cli/src/commands/registry.ts
import type { Command } from './types';

export class CommandRegistry {
  private readonly map = new Map<string, Command>();

  register(cmd: Command): void {
    this.map.set(cmd.name, cmd);
  }

  lookup(name: string): Command | undefined {
    return this.map.get(name);
  }

  /** Resolve a name from a positional argv prefix, longest-match first. */
  resolve(argv: string[]): { command: Command; rest: string[] } | undefined {
    for (let n = argv.length; n >= 1; n--) {
      const candidate = argv.slice(0, n).join('.');
      const cmd = this.map.get(candidate);
      if (cmd) return { command: cmd, rest: argv.slice(n) };
    }
    return undefined;
  }

  all(): Command[] {
    return [...this.map.values()];
  }
}
```

```ts
// tools/cli/src/cli.ts
import { CLIError } from './errors';
import { formatOutput, type OutputFormat } from './output';
import type { CommandRegistry } from './commands/registry';

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd: string;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function pickFormat(flags: Record<string, string | boolean>): OutputFormat {
  if (flags['pretty']) return 'pretty';
  if (flags['json']) return 'json';
  return 'json';
}

export async function runCli(
  argv: string[],
  registry: CommandRegistry,
  opts: RunCliOptions,
): Promise<RunCliResult> {
  const { positional, flags } = parseArgs(argv);
  const format = pickFormat(flags);

  const resolved = registry.resolve(positional);
  if (!resolved) {
    const err = new CLIError(
      'UNKNOWN_COMMAND',
      positional.length === 0 ? 'no command given' : `unknown command: ${positional.join(' ')}`,
      'run with --help to see available commands',
    );
    return { exitCode: 1, stdout: '', stderr: formatOutput(err.toJSON(), format) };
  }

  try {
    const result = await resolved.command.run({
      cwd: opts.cwd,
      format,
      args: resolved.rest,
      flags,
    });
    return { exitCode: 0, stdout: formatOutput(result, format), stderr: '' };
  } catch (err: unknown) {
    if (err instanceof CLIError) {
      return { exitCode: 1, stdout: '', stderr: formatOutput(err.toJSON(), format) };
    }
    const wrapped = new CLIError('INTERNAL', err instanceof Error ? err.message : String(err));
    return { exitCode: 1, stdout: '', stderr: formatOutput(wrapped.toJSON(), format) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/cli.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/errors.ts tools/cli/src/commands/ tools/cli/src/cli.ts tools/cli/tests/cli.test.ts
git commit -m "feat(cli): error model, command registry, dispatch"
```

---

### Task 7: `lich init` (minimal)

**Files:**
- Create: `tools/cli/src/commands/init.ts`
- Create: `tools/cli/tests/commands/init.test.ts`

The full scaffolder lands in plan 11. This is the v0.0 stub: creates a bare `lich.config.ts` in the target directory so it becomes a valid lich project.

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/commands/init.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../../src/commands/init';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-init-')));
});

describe('lich init', () => {
  it('creates lich.config.ts in cwd if not present', async () => {
    const result = await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    const path = join(tmp, 'lich.config.ts');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/export default/);
    expect(result).toMatchObject({ created: true, configPath: path });
  });

  it('refuses to overwrite an existing config without --force', async () => {
    await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    await expect(
      initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/already exists/);
  });

  it('--force overwrites an existing config', async () => {
    await initCommand.run({ cwd: tmp, format: 'json', args: [], flags: {} });
    const result = await initCommand.run({
      cwd: tmp, format: 'json', args: [], flags: { force: true },
    });
    expect(result).toMatchObject({ created: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/commands/init.test.ts`
Expected: FAIL (`Cannot find module '../../src/commands/init'`).

- [ ] **Step 3: Implement init**

```ts
// tools/cli/src/commands/init.ts
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLIError } from '../errors';
import type { Command } from './types';

const STUB = `export default {
  // The CLI foundation only requires a default-exported object.
  // Adapter selections, services, and other config land in later plans.
};
`;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const initCommand: Command = {
  name: 'init',
  describe: 'Scaffold a lich.config.ts in the current directory',
  async run(ctx) {
    const path = join(ctx.cwd, 'lich.config.ts');
    if ((await exists(path)) && !ctx.flags['force']) {
      throw new CLIError(
        'CONFIG_INVALID',
        `lich.config.ts already exists at ${path}`,
        'pass --force to overwrite',
      );
    }
    await writeFile(path, STUB, 'utf8');
    return { created: true, configPath: path };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/commands/init.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/commands/init.ts tools/cli/tests/commands/init.test.ts
git commit -m "feat(cli): minimal init command (config stub)"
```

---

### Task 8: `lich stacks current`

**Files:**
- Create: `tools/cli/src/commands/stacks/current.ts`
- Create: `tools/cli/tests/commands/stacks-current.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/commands/stacks-current.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeStacksCurrentCommand } from '../../src/commands/stacks/current';
import { CLIError } from '../../src/errors';

let tmp: string;
let registryPath: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-cur-')));
  registryPath = join(tmp, 'registry.json');
});

describe('lich stacks current', () => {
  it('errors NO_PROJECT when cwd is not inside a lich project', async () => {
    const cmd = makeStacksCurrentCommand(() => new Registry(registryPath));
    await expect(
      cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('returns worktree info even with no registry entry', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const cmd = makeStacksCurrentCommand(() => new Registry(registryPath));
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.path).toBe(tmp);
    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
    expect(result.running).toBe(false);
    expect(result.entry).toBeNull();
  });

  it('returns the registry entry when one exists', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const reg = new Registry(registryPath);
    const { computeWorktreeKey } = await import('../../src/worktree');
    const key = computeWorktreeKey(tmp);
    await reg.upsert(key, {
      path: tmp,
      branch: 'main',
      ports: { postgres: 54123 },
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: '2026-05-16T00:00:00Z',
    });
    const cmd = makeStacksCurrentCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.running).toBe(true);
    expect(result.entry.ports.postgres).toBe(54123);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/commands/stacks-current.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement stacks current**

```ts
// tools/cli/src/commands/stacks/current.ts
import { CLIError } from '../../errors';
import { findWorktree } from '../../worktree';
import type { Registry } from '../../registry';
import type { Command } from '../types';

export function makeStacksCurrentCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.current',
    describe: 'Show the stack the CLI would target from the current directory',
    async run(ctx) {
      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        throw new CLIError(
          'NO_PROJECT',
          'not inside a lich project',
          'run `lich init` or cd into a directory with lich.config.ts',
        );
      }
      const entry = await getRegistry().get(wt.key);
      return {
        key: wt.key,
        path: wt.path,
        configPath: wt.configPath,
        running: entry !== undefined,
        entry: entry ?? null,
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/commands/stacks-current.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/commands/stacks/ tools/cli/tests/commands/stacks-current.test.ts
git commit -m "feat(cli): stacks current"
```

---

### Task 9: `lich stacks list`

**Files:**
- Create: `tools/cli/src/commands/stacks/list.ts`
- Create: `tools/cli/tests/commands/stacks-list.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/commands/stacks-list.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeStacksListCommand } from '../../src/commands/stacks/list';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-list-')));
  reg = new Registry(join(tmp, 'registry.json'));
});

describe('lich stacks list', () => {
  it('returns an empty array when no stacks are registered', async () => {
    const cmd = makeStacksListCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.stacks).toEqual([]);
  });

  it('returns every registry entry, keyed', async () => {
    await reg.upsert('k1', {
      path: '/a', branch: 'a', ports: { postgres: 1 }, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    await reg.upsert('k2', {
      path: '/b', branch: 'b', ports: { postgres: 2 }, urls: {}, containers: [], network: '', logDir: '', createdAt: '',
    });
    const cmd = makeStacksListCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.stacks).toHaveLength(2);
    const keys = result.stacks.map((s: any) => s.key).sort();
    expect(keys).toEqual(['k1', 'k2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/commands/stacks-list.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement stacks list**

```ts
// tools/cli/src/commands/stacks/list.ts
import type { Registry } from '../../registry';
import type { Command } from '../types';

export function makeStacksListCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.list',
    describe: 'List every running lich stack on this machine',
    async run() {
      const entries = await getRegistry().list();
      return {
        stacks: entries.map(({ key, entry }) => ({
          key,
          path: entry.path,
          branch: entry.branch,
          ports: entry.ports,
          urls: entry.urls,
          createdAt: entry.createdAt,
        })),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/commands/stacks-list.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/commands/stacks/list.ts tools/cli/tests/commands/stacks-list.test.ts
git commit -m "feat(cli): stacks list"
```

---

### Task 10: `lich stacks prune`

**Files:**
- Create: `tools/cli/src/commands/stacks/prune.ts`
- Create: `tools/cli/tests/commands/stacks-prune.test.ts`

Prune removes registry entries whose worktree path no longer exists on disk. Container cleanup is plan 02's job; plan 01 prune is registry-only.

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/commands/stacks-prune.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeStacksPruneCommand } from '../../src/commands/stacks/prune';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-prune-')));
  reg = new Registry(join(tmp, 'registry.json'));
});

describe('lich stacks prune', () => {
  it('removes entries pointing at paths that no longer exist', async () => {
    const live = join(tmp, 'live');
    const dead = join(tmp, 'dead');
    mkdirSync(live);
    await reg.upsert('live', { path: live, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    await reg.upsert('dead', { path: dead, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    const cmd = makeStacksPruneCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.pruned).toEqual(['dead']);
    const after = await reg.list();
    expect(after.map(e => e.key)).toEqual(['live']);
  });

  it('returns an empty pruned array when all paths exist', async () => {
    const live = join(tmp, 'live');
    mkdirSync(live);
    await reg.upsert('live', { path: live, branch: '', ports: {}, urls: {}, containers: [], network: '', logDir: '', createdAt: '' });
    const cmd = makeStacksPruneCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.pruned).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/commands/stacks-prune.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement stacks prune**

```ts
// tools/cli/src/commands/stacks/prune.ts
import { access } from 'node:fs/promises';
import type { Registry } from '../../registry';
import type { Command } from '../types';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function makeStacksPruneCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.prune',
    describe: 'Remove registry entries for worktrees that no longer exist on disk',
    async run() {
      const reg = getRegistry();
      const entries = await reg.list();
      const pruned: string[] = [];
      for (const { key, entry } of entries) {
        if (!(await pathExists(entry.path))) {
          await reg.remove(key);
          pruned.push(key);
        }
      }
      return { pruned };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/commands/stacks-prune.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/commands/stacks/prune.ts tools/cli/tests/commands/stacks-prune.test.ts
git commit -m "feat(cli): stacks prune (registry-only)"
```

---

### Task 11: `lich doctor`

**Files:**
- Create: `tools/cli/src/commands/doctor.ts`
- Create: `tools/cli/tests/commands/doctor.test.ts`

Plan 01's doctor checks: registry directory writable, config (if any) loadable, worktree key derivation works. Container/port health is plan 02's job.

- [ ] **Step 1: Write the failing test**

```ts
// tools/cli/tests/commands/doctor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeDoctorCommand } from '../../src/commands/doctor';

let tmp: string;
let reg: Registry;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-doc-')));
  reg = new Registry(join(tmp, 'registry.json'));
});

describe('lich doctor', () => {
  it('reports no_project when not inside a project, with all infra checks ok', async () => {
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(true);
    expect(result.checks.find((c: any) => c.id === 'project').status).toBe('skipped');
    expect(result.checks.find((c: any) => c.id === 'registry').status).toBe('ok');
  });

  it('reports project ok when inside a valid project', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(true);
    expect(result.checks.find((c: any) => c.id === 'project').status).toBe('ok');
    expect(result.checks.find((c: any) => c.id === 'config').status).toBe('ok');
  });

  it('reports config error when the config file is malformed', async () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export const foo = 1;'); // no default export
    const cmd = makeDoctorCommand(() => reg);
    const result = (await cmd.run({ cwd: tmp, format: 'json', args: [], flags: {} })) as any;
    expect(result.ok).toBe(false);
    const cfg = result.checks.find((c: any) => c.id === 'config');
    expect(cfg.status).toBe('error');
    expect(cfg.message).toMatch(/default export/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/commands/doctor.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement doctor**

```ts
// tools/cli/src/commands/doctor.ts
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config';
import type { Registry } from '../registry';
import { findWorktree } from '../worktree';
import type { Command } from './types';

type Status = 'ok' | 'error' | 'skipped';
interface Check {
  id: string;
  status: Status;
  message?: string;
}

export function makeDoctorCommand(getRegistry: () => Registry): Command {
  return {
    name: 'doctor',
    describe: 'Diagnose the local environment',
    async run(ctx) {
      const checks: Check[] = [];

      // Registry directory writable
      const regPath = (getRegistry() as any).path as string;
      try {
        await mkdir(dirname(regPath), { recursive: true });
        await access(dirname(regPath));
        checks.push({ id: 'registry', status: 'ok' });
      } catch (err) {
        checks.push({
          id: 'registry',
          status: 'error',
          message: `cannot access registry dir ${dirname(regPath)}: ${(err as Error).message}`,
        });
      }

      // Worktree presence
      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        checks.push({ id: 'project', status: 'skipped', message: 'not inside a lich project' });
      } else {
        checks.push({ id: 'project', status: 'ok', message: wt.path });
        // Config loadable
        try {
          await loadConfig(wt.configPath);
          checks.push({ id: 'config', status: 'ok' });
        } catch (err) {
          checks.push({ id: 'config', status: 'error', message: (err as Error).message });
        }
      }

      const ok = checks.every((c) => c.status !== 'error');
      return { ok, checks };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/commands/doctor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/cli/src/commands/doctor.ts tools/cli/tests/commands/doctor.test.ts
git commit -m "feat(cli): doctor"
```

---

### Task 12: Wire commands into `bin.ts`; add a small end-to-end test

**Files:**
- Modify: `tools/cli/src/bin.ts`
- Modify: `tools/cli/package.json` (add `bin`/`scripts`)
- Create: `tools/cli/tests/bin.e2e.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// tools/cli/tests/bin.e2e.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-e2e-')));
});

const BIN = join(__dirname, '..', 'src', 'bin.ts');

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync('bun', [BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('bin end-to-end', () => {
  it('init then stacks current returns running:false', () => {
    const initRes = run(['init'], tmp, { LICH_HOME: tmp });
    expect(initRes.status).toBe(0);

    const curRes = run(['stacks', 'current'], tmp, { LICH_HOME: tmp });
    expect(curRes.status).toBe(0);
    const parsed = JSON.parse(curRes.stdout);
    expect(parsed.path).toBe(tmp);
    expect(parsed.running).toBe(false);
  });

  it('unknown command returns exit 1 with JSON error', () => {
    writeFileSync(join(tmp, 'lich.config.ts'), 'export default {};');
    const res = run(['no-such-command'], tmp, { LICH_HOME: tmp });
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stderr);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/cli && bunx vitest run tests/bin.e2e.test.ts`
Expected: FAIL (bin.ts only exports VERSION).

- [ ] **Step 3: Wire commands into bin.ts**

```ts
// tools/cli/src/bin.ts
#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli';
import { CommandRegistry } from './commands/registry';
import { Registry } from './registry';
import { initCommand } from './commands/init';
import { makeDoctorCommand } from './commands/doctor';
import { makeStacksCurrentCommand } from './commands/stacks/current';
import { makeStacksListCommand } from './commands/stacks/list';
import { makeStacksPruneCommand } from './commands/stacks/prune';

export const VERSION = '0.0.0';

function defaultRegistryPath(): string {
  const home = process.env['LICH_HOME'] ?? homedir();
  return join(home, '.lich', 'registry.json');
}

export function buildCommands(registryPath: string): CommandRegistry {
  const reg = new CommandRegistry();
  const getReg = () => new Registry(registryPath);
  reg.register(initCommand);
  reg.register(makeDoctorCommand(getReg));
  reg.register(makeStacksCurrentCommand(getReg));
  reg.register(makeStacksListCommand(getReg));
  reg.register(makeStacksPruneCommand(getReg));
  return reg;
}

async function main() {
  const cli = buildCommands(defaultRegistryPath());
  const result = await runCli(process.argv.slice(2), cli, { cwd: process.cwd() });
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr + '\n');
  process.exit(result.exitCode);
}

// Run when invoked as a script (not when imported).
const invokedAsScript = (() => {
  try {
    // Bun: import.meta.main is true when entry script.
    return (import.meta as unknown as { main?: boolean }).main === true;
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  void main();
}
```

`LICH_HOME` overrides the registry location for tests so the real `~/.lich` is never touched.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/cli && bunx vitest run tests/bin.e2e.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the entire suite to verify nothing regressed**

Run: `cd tools/cli && bunx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/cli/src/bin.ts tools/cli/tests/bin.e2e.test.ts
git commit -m "feat(cli): wire commands into bin; end-to-end test"
```

---

## Verification checklist (run after the final task)

- [ ] `cd tools/cli && bunx vitest run` is green (all suites).
- [ ] `cd tools/cli && bun tsc --noEmit` reports no type errors.
- [ ] From a scratch directory: `bun /path/to/tools/cli/src/bin.ts init` creates `lich.config.ts`.
- [ ] From inside that directory: `bun /path/to/tools/cli/src/bin.ts stacks current` prints JSON containing the expected `key` and `running: false`.
- [ ] From inside that directory: `bun /path/to/tools/cli/src/bin.ts doctor` prints JSON with `ok: true` and a `project` check `ok`.

## What's intentionally not in plan 01

These are pulled forward into later plans on purpose; do not add them here:

- Docker, Postgres, or any other service runtime (plan 02).
- The `Service` contract, port allocator, container naming (plan 02).
- `lich up` / `lich down` (plan 02).
- `lich logs` (plan 03).
- DB/auth/test/codegen/UI/scaffolder commands (plans 05–11).
- A real scaffold inside `init` (plan 11).
- Adapter slot system beyond the empty config type (plan 13).
- File locking for concurrent registry writes (plan 02, when contention starts mattering).
- Structured `--help` schema (plan 13 — needs the full command surface before designing the contract).
