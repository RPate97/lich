import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireLock } from './registry-lock';

export interface StackEntry {
  path: string;
  branch: string;
  ports: Record<string, number>;
  /**
   * URLs published by services for this stack, keyed by `OwnedService.urlName`
   * (e.g., `{ web: "http://localhost:3000" }`). `dev` populates this after URL
   * registration. Defaults to `{}` for legacy entries written before this field
   * existed (see `read()`).
   */
  urls: Record<string, string>;
  containers: string[];
  network: string;
  logDir: string;
  createdAt: string;
  /**
   * Absolute path to the compose file `dev` wrote for this stack — verbatim, so
   * passthrough commands (`lich compose ps`, `compose logs`, etc.) can
   * shell into the same file `dev`/`stop` use without reconstructing the path
   * from `worktreeKey` (which was the LEV-208 bug: the subdir was added but
   * the passthrough was never updated). Optional because legacy entries
   * written before this field existed don't carry it; callers MUST handle
   * `undefined` as "no recorded path" (typically: re-run `dev`).
   */
  composeFile?: string;
  /**
   * Agent that started this stack, e.g. "claude-code"; absent / null = manual.
   * Populated from the `LICH_STARTED_BY` environment variable at `dev` time.
   * Omitted entirely for manual invocations — `undefined` is the natural
   * "manual" signal. Existing entries that don't carry the field are manual.
   */
  startedBy?: string;
}

export interface RegistryData {
  stacks: Record<string, StackEntry>;
}

export class Registry {
  constructor(private readonly path: string) {}

  async read(): Promise<RegistryData> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RegistryData;
      if (!parsed.stacks || typeof parsed.stacks !== 'object') return { stacks: {} };
      // Default `urls` to `{}` for legacy entries written before the field existed.
      // Purely additive: no migration, just a default on the read path.
      // `composeFile` (LEV-208) is intentionally NOT defaulted — it's optional
      // on the type, and callers (`lich compose <sub>`) treat `undefined`
      // as "no recorded path, re-run dev". A blank string would conflate
      // "stack pre-LEV-208" with "stack with no compose file recorded".
      for (const key of Object.keys(parsed.stacks)) {
        const entry = parsed.stacks[key]!;
        if (!entry.urls || typeof entry.urls !== 'object') entry.urls = {};
      }
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { stacks: {} };
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

  /**
   * Run `fn` with an exclusive advisory lock held on this registry file.
   * Use for read-modify-write sequences that must not interleave.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireLock(this.path);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async write(data: RegistryData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, this.path);
  }
}
