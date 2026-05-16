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

export class Registry {
  constructor(private readonly path: string) {}

  async read(): Promise<RegistryData> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RegistryData;
      if (!parsed.stacks || typeof parsed.stacks !== 'object') return { stacks: {} };
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

  private async write(data: RegistryData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, this.path);
  }
}
